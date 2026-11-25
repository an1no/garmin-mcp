/**
 * get_vo2max and get_weight: fetching and shaping.
 *
 * Garmin doesn't document a range limit for these endpoints, so requests are split into
 * 28-day chunks, the smallest limit any Personal API endpoint documents.
 */
import type { GarminClient } from "./garmin";
import { compact, num, round } from "./format";
import { chunkRange, mapLimit } from "./trends";

type Json = Record<string, unknown>;
type Range = { startDate: string; endDate: string };

const CHUNK_DAYS = 28;
const CONCURRENCY = 3;
/** Above this many measured days, get_weight returns monthly averages instead of daily values. */
const MAX_DAILY_WEIGHT_ROWS = 62;

function obj(value: unknown): Json {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function arr(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function avg(values: number[], digits = 1): number | undefined {
	return values.length ? round(values.reduce((a, b) => a + b, 0) / values.length, digits) : undefined;
}

// ---------------------------------------------------------------------------
// VO2 max
// ---------------------------------------------------------------------------

export const VO2_SPORTS = ["generic", "cycling", "rowing"] as const;

type Vo2Reading = { date: string; vo2Max: number; precise: number };

/** Rows of /metrics-service/metrics/maxmet/daily -> per sport: first, latest, change, range and changes. */
export function summarizeVo2Max(rows: unknown[]): Json {
	const out: Json = {};
	for (const sport of VO2_SPORTS) {
		const byDate = new Map<string, Vo2Reading>();
		for (const row of rows) {
			const r = obj(obj(row)[sport]);
			const precise = num(r.vo2MaxPreciseValue) ?? num(r.vo2MaxValue);
			if (typeof r.calendarDate !== "string" || precise === undefined || precise <= 0) continue;
			const date = r.calendarDate.slice(0, 10);
			byDate.set(date, { date, vo2Max: round(num(r.vo2MaxValue) ?? precise, 0)!, precise: round(precise, 1)! });
		}
		const readings = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
		if (!readings.length) continue;
		const first = readings[0]!;
		const latest = readings[readings.length - 1]!;
		const precise = readings.map((r) => r.precise);
		out[sport] = {
			first,
			latest,
			change: round(latest.precise - first.precise, 1),
			min: Math.min(...precise),
			max: Math.max(...precise),
			daysWithValue: readings.length,
			// Days the whole-number value (the one Garmin shows) changed, starting with the first reading.
			changes: readings.filter((r, i) => i === 0 || r.vo2Max !== readings[i - 1]!.vo2Max),
		};
	}
	return out;
}

export async function fetchVo2Max(garmin: GarminClient, range: Range): Promise<Json> {
	const pages = await mapLimit(chunkRange(range.startDate, range.endDate, CHUNK_DAYS), CONCURRENCY, (chunk) =>
		garmin.get<unknown[]>(`/metrics-service/metrics/maxmet/daily/${chunk.startDate}/${chunk.endDate}`),
	);
	const sports = summarizeVo2Max(pages.flatMap((page) => arr(page)));
	return compact({
		...range,
		units: { vo2Max: "ml/kg/min" },
		sports: Object.keys(sports).length ? sports : undefined,
		message: Object.keys(sports).length ? undefined : "No VO2 max values in this range.",
		note: sports.generic ? "generic = running/walking VO2 max." : undefined,
	});
}

// ---------------------------------------------------------------------------
// Weight
// ---------------------------------------------------------------------------

/**
 * Kilograms from a Garmin mass field. The Swagger docs say kilograms, but bone and muscle mass
 * are integers and Garmin often stores mass in grams, so values above 500 are read as grams.
 */
export function kg(value: unknown, digits = 1): number | undefined {
	const n = num(value);
	if (n === undefined || n <= 0) return undefined;
	return round(n > 500 ? n / 1000 : n, digits);
}

/** One WeightMetrics entry -> concise measurement. */
export function shapeWeight(raw: unknown, date?: string): Json {
	const m = obj(raw);
	return compact({
		date: typeof m.calendarDate === "string" ? m.calendarDate.slice(0, 10) : date,
		weightKg: kg(m.weight),
		bmi: round(m.bmi, 1),
		bodyFatPercent: round(m.bodyFat, 1),
		bodyWaterPercent: round(m.bodyWater, 1),
		muscleMassKg: kg(m.muscleMass),
		boneMassKg: kg(m.boneMass),
		visceralFat: m.visceralFat,
		metabolicAge: round(m.metabolicAge, 0),
		physiqueRating: m.physiqueRating,
	});
}

/** Pages of /weight-service/weight/range -> one measurement per day (the day's latest), oldest first. */
export function weightDays(pages: unknown[]): Json[] {
	const byDate = new Map<string, Json>();
	for (const page of pages) {
		for (const item of arr(obj(page).dailyWeightSummaries)) {
			const d = obj(item);
			const date = typeof d.summaryDate === "string" ? d.summaryDate.slice(0, 10) : undefined;
			const all = arr(d.allWeightMetrics);
			const latest = Object.keys(obj(d.latestWeight)).length ? d.latestWeight : all[all.length - 1];
			const shaped = shapeWeight(latest, date);
			if (!shaped.date || shaped.weightKg === undefined) continue;
			const entries = num(d.numOfWeightEntries);
			byDate.set(
				shaped.date as string,
				compact({
					...shaped,
					entries: entries && entries > 1 ? entries : undefined,
					dayMinKg: entries && entries > 1 ? kg(d.minWeight) : undefined,
					dayMaxKg: entries && entries > 1 ? kg(d.maxWeight) : undefined,
				}),
			);
		}
	}
	return [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/** Effective weight goal for the end of the range, from /goal-service/.../weightgoal. */
export function shapeWeightGoal(raw: unknown): Json | undefined {
	const g = obj(raw);
	const goals = arr(g.userGoals).map(obj).filter((x) => kg(x.goalValue) !== undefined);
	const ranges = arr(g.userGoalRanges).map(obj);
	const goal = goals[goals.length - 1];
	const range = ranges[ranges.length - 1];
	const shaped = compact({
		weightKg: goal ? kg(goal.goalValue) : undefined,
		rangeKg: range ? { low: kg(range.lowWeightGoalInGrams), high: kg(range.highWeightGoalInGrams) } : undefined,
	});
	return Object.keys(shaped).length ? shaped : undefined;
}

/** Summary of the measured days: first/latest/extremes/average plus daily rows or monthly averages. */
export function summarizeWeight(days: Json[], range: Range, goal?: Json): Json {
	const base = {
		...range,
		units: { weight: "kg", bodyFat: "%", bodyWater: "%", muscleMass: "kg", boneMass: "kg" },
		goal,
	};
	if (!days.length) return compact({ ...base, measuredDays: 0, message: "No weight entries in this range." });

	const weights = days.map((d) => d.weightKg as number);
	const point = (d: Json | undefined) => d && { date: d.date, weightKg: d.weightKg };
	const lowest = days.reduce((a, b) => ((b.weightKg as number) < (a.weightKg as number) ? b : a));
	const highest = days.reduce((a, b) => ((b.weightKg as number) > (a.weightKg as number) ? b : a));
	const first = days[0]!;
	const latest = days[days.length - 1]!;

	let detail: Json;
	if (days.length <= MAX_DAILY_WEIGHT_ROWS) {
		detail = { days };
	} else {
		const months = new Map<string, Json[]>();
		for (const d of days) {
			const month = String(d.date).slice(0, 7);
			months.set(month, [...(months.get(month) ?? []), d]);
		}
		detail = {
			monthly: [...months.entries()].map(([month, items]) => {
				const w = items.map((d) => d.weightKg as number);
				const fat = items.map((d) => d.bodyFatPercent).filter((v): v is number => typeof v === "number");
				return compact({
					month,
					measuredDays: items.length,
					avgWeightKg: avg(w),
					minWeightKg: Math.min(...w),
					maxWeightKg: Math.max(...w),
					avgBodyFatPercent: avg(fat),
				});
			}),
			note: `${days.length} measured days: monthly averages instead of daily values. Ask for a shorter range for daily values.`,
		};
	}

	return compact({
		...base,
		measuredDays: days.length,
		first: point(first),
		latest,
		changeKg: round((latest.weightKg as number) - (first.weightKg as number), 1),
		averageWeightKg: avg(weights),
		lowest: point(lowest),
		highest: point(highest),
		...detail,
	});
}

export async function fetchWeight(garmin: GarminClient, range: Range): Promise<Json> {
	const chunks = chunkRange(range.startDate, range.endDate, CHUNK_DAYS);
	const goalChunk = chunks[chunks.length - 1]!;
	const [pages, goal] = await Promise.all([
		mapLimit(chunks, CONCURRENCY, (chunk) =>
			garmin.get(`/weight-service/weight/range/${chunk.startDate}/${chunk.endDate}`, { includeAll: false }),
		),
		// The goal is a nice-to-have: if Garmin refuses, the weight data is still returned.
		garmin
			.get(`/goal-service/goal/user/effective/weightgoal/${goalChunk.startDate}/${goalChunk.endDate}`)
			.then(shapeWeightGoal)
			.catch(() => undefined),
	]);
	return summarizeWeight(weightDays(pages), range, goal);
}
