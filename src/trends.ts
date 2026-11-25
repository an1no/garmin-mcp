/**
 * get_trends: fetches up to a year of data from several Garmin endpoints and reduces it to
 * weekly or monthly statistics on the server, so the model gets a few rows instead of
 * hundreds of days (which would flood its context and make totals unreliable).
 *
 * The aggregators work on the shapes produced by the summarizers in format.ts, so they share
 * one definition of every field with the day-by-day tools.
 */
import type { GarminClient } from "./garmin";
import { describeError } from "./parts";
import {
	addDays,
	compact,
	round,
	summarizeActivity,
	summarizeDailySummaryV2,
	summarizeHrv,
	summarizeSleep,
} from "./format";

type Json = Record<string, unknown>;

export const TREND_METRICS = ["sleep", "daily", "hrv", "activities"] as const;
export type TrendMetric = (typeof TREND_METRICS)[number];
export type TrendPeriod = "week" | "month";

/** Longest range get_trends accepts. */
export const TREND_MAX_DAYS = 366;

/** Garmin limits per request (Personal API Swagger), kept below the documented maximums. */
const SLEEP_CHUNK_DAYS = 31;
const DAILY_CHUNK_DAYS = 183;
const HRV_CHUNK_DAYS = 183;
const ACTIVITY_PAGE_SIZE = 100;
const ACTIVITY_MAX_PAGES = 10;
/** Parallel Garmin requests per metric; Workers allows 6 open connections per request. */
const CONCURRENCY = 3;

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

/** The week (its Monday, YYYY-MM-DD) or month (YYYY-MM) a date belongs to. */
export function periodKey(date: string, period: TrendPeriod): string {
	if (period === "month") return date.slice(0, 7);
	const weekday = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
	return addDays(date, -weekday);
}

function firstDayOfNextMonth(date: string): string {
	const year = Number(date.slice(0, 4));
	const month = Number(date.slice(5, 7)); // 1-12; Date.UTC months are 0-based, so this is next month
	return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
}

/** Consecutive periods covering [startDate, endDate]; the first and last may be partial. */
export function periodsInRange(
	startDate: string,
	endDate: string,
	period: TrendPeriod,
): { period: string; from: string; to: string }[] {
	const out: { period: string; from: string; to: string }[] = [];
	let cursor = startDate;
	while (cursor <= endDate) {
		const key = periodKey(cursor, period);
		const next = period === "month" ? firstDayOfNextMonth(cursor) : addDays(key, 7);
		const last = addDays(next, -1);
		out.push({ period: key, from: cursor, to: last < endDate ? last : endDate });
		cursor = next;
	}
	return out;
}

/** Splits [startDate, endDate] into consecutive ranges of at most `size` days. */
export function chunkRange(startDate: string, endDate: string, size: number): { startDate: string; endDate: string }[] {
	const out: { startDate: string; endDate: string }[] = [];
	let cursor = startDate;
	while (cursor <= endDate) {
		const last = addDays(cursor, size - 1);
		out.push({ startDate: cursor, endDate: last < endDate ? last : endDate });
		cursor = addDays(last, 1);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Small statistics helpers
// ---------------------------------------------------------------------------

function obj(value: unknown): Json {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function numbers(values: unknown[], keep: (n: number) => boolean = () => true): number[] {
	return values.filter((v): v is number => typeof v === "number" && Number.isFinite(v) && keep(v));
}

function avg(values: number[], digits = 1): number | undefined {
	return values.length ? round(values.reduce((a, b) => a + b, 0) / values.length, digits) : undefined;
}

function sum(values: number[], digits = 0): number | undefined {
	return values.length ? round(values.reduce((a, b) => a + b, 0), digits) : undefined;
}

function min(values: number[]): number | undefined {
	return values.length ? Math.min(...values) : undefined;
}

function max(values: number[]): number | undefined {
	return values.length ? Math.max(...values) : undefined;
}

/** Item with the highest (or lowest) numeric value of `pick`, ignoring items without one. */
function extreme<T>(items: T[], pick: (item: T) => unknown, highest: boolean): T | undefined {
	let best: T | undefined;
	let bestValue = highest ? -Infinity : Infinity;
	for (const item of items) {
		const v = pick(item);
		if (typeof v !== "number" || !Number.isFinite(v)) continue;
		if (highest ? v > bestValue : v < bestValue) {
			best = item;
			bestValue = v;
		}
	}
	return best;
}

const positive = (n: number) => n > 0;
const nonNegative = (n: number) => n >= 0;

// ---------------------------------------------------------------------------
// Aggregators (input: records shaped by format.ts)
// ---------------------------------------------------------------------------

/** Nights from summarizeSleep(). */
export function aggregateSleep(records: Json[]): Json | undefined {
	const nights = records.filter((n) => typeof n.totalSleepSeconds === "number" && n.totalSleepSeconds > 0);
	if (!nights.length) return undefined;
	const sleepHours = (n: Json) => (n.totalSleepSeconds as number) / 3600;
	const stageMinutes = (key: string) => avg(numbers(nights.map((n) => obj(n.stages)[key])).map((s) => s / 60), 0);
	const scores = numbers(nights.map((n) => n.sleepScore));
	const night = (n: Json | undefined) =>
		n && { date: n.calendarDate, sleepScore: n.sleepScore, hours: round(sleepHours(n), 2) };
	return compact({
		nights: nights.length,
		avgSleepHours: avg(nights.map(sleepHours), 2),
		minSleepHours: round(min(nights.map(sleepHours)), 2),
		maxSleepHours: round(max(nights.map(sleepHours)), 2),
		avgDeepMinutes: stageMinutes("deepSeconds"),
		avgLightMinutes: stageMinutes("lightSeconds"),
		avgRemMinutes: stageMinutes("remSeconds"),
		avgAwakeMinutes: stageMinutes("awakeSeconds"),
		avgSleepScore: avg(scores, 0),
		minSleepScore: min(scores),
		maxSleepScore: max(scores),
		bestNight: night(extreme(nights, (n) => n.sleepScore, true)),
		worstNight: night(extreme(nights, (n) => n.sleepScore, false)),
		avgSleepHeartRate: avg(numbers(nights.map((n) => n.avgHeartRate), positive), 0),
		avgSleepStress: avg(numbers(nights.map((n) => n.avgSleepStress), nonNegative), 1),
		avgRespiration: avg(numbers(nights.map((n) => n.avgRespiration), positive), 1),
	});
}

/** Days from summarizeDailySummaryV2(). */
export function aggregateDaily(records: Json[]): Json | undefined {
	const steps = (d: Json) => obj(d.steps).total;
	const resting = (d: Json) => obj(d.heartRate).resting;
	const days = records.filter((d) => {
		const s = steps(d);
		const r = resting(d);
		return (typeof s === "number" && s > 0) || (typeof r === "number" && r > 0);
	});
	if (!days.length) return undefined;
	const stepValues = numbers(days.map(steps));
	const restingValues = numbers(days.map(resting), positive);
	const bb = (key: string) => numbers(days.map((d) => obj(d.bodyBattery)[key]), nonNegative);
	const im = (key: string) => numbers(days.map((d) => obj(d.intensityMinutes)[key]), nonNegative);
	const distance = sum(numbers(days.map((d) => d.distanceMeters), nonNegative));
	const top = extreme(days, steps, true);
	return compact({
		days: days.length,
		totalSteps: sum(stepValues),
		avgSteps: avg(stepValues, 0),
		mostStepsDay: top && { date: top.calendarDate, steps: steps(top) },
		totalDistanceKm: distance !== undefined ? round(distance / 1000, 1) : undefined,
		avgRestingHeartRate: avg(restingValues, 0),
		minRestingHeartRate: min(restingValues),
		maxRestingHeartRate: max(restingValues),
		avgStress: avg(numbers(days.map((d) => obj(d.stress).average), nonNegative), 0),
		avgBodyBatteryHighest: avg(bb("highest"), 0),
		avgBodyBatteryLowest: avg(bb("lowest"), 0),
		avgBodyBatteryCharged: avg(bb("charged"), 0),
		avgBodyBatteryDrained: avg(bb("drained"), 0),
		intensityMinutes: { moderate: sum(im("moderate")), vigorous: sum(im("vigorous")) },
		avgActiveCalories: avg(numbers(days.map((d) => obj(d.calories).active), nonNegative), 0),
	});
}

/** Nights from summarizeHrv(). */
export function aggregateHrv(records: Json[]): Json | undefined {
	const nights = records.filter((h) => typeof h.lastNightAvg === "number" && h.lastNightAvg > 0);
	if (!nights.length) return undefined;
	const values = numbers(nights.map((h) => h.lastNightAvg));
	const statusCounts: Record<string, number> = {};
	for (const h of nights) {
		if (typeof h.status === "string") statusCounts[h.status] = (statusCounts[h.status] ?? 0) + 1;
	}
	const latest = [...nights].sort((a, b) => String(a.calendarDate).localeCompare(String(b.calendarDate))).pop();
	return compact({
		nights: nights.length,
		avgLastNight: avg(values, 0),
		minLastNight: min(values),
		maxLastNight: max(values),
		latestWeeklyAvg: latest?.weeklyAvg,
		latestStatus: latest?.status,
		statusCounts,
	});
}

/** Activities from summarizeActivity(). */
export function aggregateActivities(records: Json[]): Json | undefined {
	if (!records.length) return undefined;
	const totals = (items: Json[]) => {
		const distance = sum(numbers(items.map((a) => a.distance), nonNegative));
		const duration = sum(numbers(items.map((a) => a.duration), nonNegative));
		return {
			count: items.length,
			distanceKm: distance !== undefined ? round(distance / 1000, 1) : undefined,
			durationHours: duration !== undefined ? round(duration / 3600, 1) : undefined,
			elevationGainMeters: sum(numbers(items.map((a) => a.elevationGain), nonNegative)),
			calories: sum(numbers(items.map((a) => a.calories), nonNegative)),
		};
	};
	const byType = new Map<string, Json[]>();
	for (const a of records) {
		const type = typeof a.activityType === "string" ? a.activityType : "other";
		byType.set(type, [...(byType.get(type) ?? []), a]);
	}
	const types = [...byType.entries()]
		.sort((a, b) => b[1].length - a[1].length)
		.map(([type, items]) => ({ type, ...totals(items) }));
	const longest = extreme(records, (a) => a.distance, true);
	return compact({
		...totals(records),
		byType: types,
		longest: longest && {
			date: String(longest.startTimeLocal ?? "").slice(0, 10),
			activityId: longest.activityId,
			name: longest.activityName,
			type: longest.activityType,
			distanceKm: typeof longest.distance === "number" ? round(longest.distance / 1000, 2) : undefined,
		},
	});
}

const AGGREGATORS: Record<TrendMetric, (records: Json[]) => Json | undefined> = {
	sleep: aggregateSleep,
	daily: aggregateDaily,
	hrv: aggregateHrv,
	activities: aggregateActivities,
};

/** Calendar date (YYYY-MM-DD) a shaped record belongs to. */
function recordDate(metric: TrendMetric, record: Json): string | undefined {
	const value = metric === "activities" ? record.startTimeLocal : record.calendarDate;
	return typeof value === "string" && value.length >= 10 ? value.slice(0, 10) : undefined;
}

export type TrendData = Partial<Record<TrendMetric, Json[]>>;

/** Groups the shaped records into periods and aggregates each period and the whole range. */
export function buildTrends(opts: {
	startDate: string;
	endDate: string;
	period: TrendPeriod;
	data: TrendData;
	errors?: Partial<Record<TrendMetric, string>>;
	notes?: string[];
}): Json {
	const { startDate, endDate, period, data } = opts;
	const metrics = TREND_METRICS.filter((m) => data[m] !== undefined);

	const grouped = new Map<string, TrendData>();
	for (const metric of metrics) {
		for (const record of data[metric] ?? []) {
			const date = recordDate(metric, record);
			if (!date || date < startDate || date > endDate) continue;
			const key = periodKey(date, period);
			const bucket = grouped.get(key) ?? {};
			(bucket[metric] ??= []).push(record);
			grouped.set(key, bucket);
		}
	}

	const periods = periodsInRange(startDate, endDate, period).map(({ period: key, from, to }) => {
		const row: Json = { period: key, from, to };
		for (const metric of metrics) row[metric] = AGGREGATORS[metric](grouped.get(key)?.[metric] ?? []);
		return compact(row);
	});

	const overall: Json = {};
	for (const metric of metrics) {
		const inRange = (data[metric] ?? []).filter((r) => {
			const date = recordDate(metric, r);
			return date !== undefined && date >= startDate && date <= endDate;
		});
		overall[metric] = AGGREGATORS[metric](inRange);
	}

	return compact({
		startDate,
		endDate,
		groupedBy: period === "week" ? "week (period = the Monday it starts on)" : "month",
		units: {
			hours: "hours",
			minutes: "minutes",
			distanceKm: "kilometers",
			durationHours: "hours",
			elevationGainMeters: "meters",
			heartRate: "bpm",
			hrv: "milliseconds",
			stress: "0-100",
			bodyBattery: "0-100",
		},
		notes: opts.notes,
		errors: opts.errors,
		overall,
		periods,
	});
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/** Maps `items` with at most `limit` calls of `fn` running at once, keeping the order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i]!);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

type Range = { startDate: string; endDate: string };

async function fetchSleep(garmin: GarminClient, range: Range): Promise<Json[]> {
	const chunks = chunkRange(range.startDate, range.endDate, SLEEP_CHUNK_DAYS);
	const pages = await mapLimit(chunks, CONCURRENCY, (chunk) =>
		garmin.get<unknown[]>("/sleep-service/sleep/dailySleepSummariesByDate", chunk),
	);
	return pages.flatMap((page) => (Array.isArray(page) ? page : []).map(summarizeSleep));
}

async function fetchDaily(garmin: GarminClient, range: Range): Promise<Json[]> {
	const chunks = chunkRange(range.startDate, range.endDate, DAILY_CHUNK_DAYS);
	const pages = await mapLimit(chunks, CONCURRENCY, (chunk) =>
		garmin.get<{ data?: unknown[] }>("/usersummary-service/v2/dailysummaries", chunk),
	);
	return pages.flatMap((page) => (Array.isArray(page?.data) ? page.data : []).map(summarizeDailySummaryV2));
}

async function fetchHrv(garmin: GarminClient, range: Range): Promise<Json[]> {
	const chunks = chunkRange(range.startDate, range.endDate, HRV_CHUNK_DAYS);
	const pages = await mapLimit(chunks, CONCURRENCY, (chunk) =>
		garmin.get(`/hrv-service/hrv/daily/${chunk.startDate}/${chunk.endDate}`),
	);
	return pages.flatMap((page) => summarizeHrv(page));
}

async function fetchActivities(
	garmin: GarminClient,
	range: Range,
	activityType: string | undefined,
	notes: string[],
): Promise<Json[]> {
	const out: Json[] = [];
	for (let page = 0; page < ACTIVITY_MAX_PAGES; page++) {
		const result = await garmin.get<unknown[]>("/activitylist-service/activities/search/activities", {
			start: page * ACTIVITY_PAGE_SIZE,
			limit: ACTIVITY_PAGE_SIZE,
			startDate: range.startDate,
			endDate: range.endDate,
			activityType,
		});
		const items = Array.isArray(result) ? result : [];
		out.push(...items.map(summarizeActivity));
		if (items.length < ACTIVITY_PAGE_SIZE) return out;
	}
	notes.push(
		`More than ${ACTIVITY_PAGE_SIZE * ACTIVITY_MAX_PAGES} activities in this range; activity totals cover the ` +
			`${ACTIVITY_PAGE_SIZE * ACTIVITY_MAX_PAGES} most recent. Use a shorter range for complete totals.`,
	);
	return out;
}

/**
 * Fetches every requested metric in parallel. A metric that fails is reported in `errors`
 * while the others are still returned; if all of them fail, the first error is thrown.
 */
export async function collectTrends(
	garmin: GarminClient,
	opts: Range & { period: TrendPeriod; metrics: readonly TrendMetric[]; activityType?: string },
): Promise<Json> {
	const range = { startDate: opts.startDate, endDate: opts.endDate };
	// Fetch the Garmin access token once up front, so parallel requests don't each request one.
	await garmin.getAccessToken();

	const notes: string[] = [];
	const fetchers: Record<TrendMetric, () => Promise<Json[]>> = {
		sleep: () => fetchSleep(garmin, range),
		daily: () => fetchDaily(garmin, range),
		hrv: () => fetchHrv(garmin, range),
		activities: () => fetchActivities(garmin, range, opts.activityType, notes),
	};

	const data: TrendData = {};
	const errors: Partial<Record<TrendMetric, string>> = {};
	const failures: unknown[] = [];
	await Promise.all(
		opts.metrics.map(async (metric) => {
			try {
				data[metric] = await fetchers[metric]();
			} catch (error) {
				errors[metric] = describeError(error);
				failures.push(error);
			}
		}),
	);
	if (failures.length === opts.metrics.length) throw failures[0];
	if (opts.activityType && data.activities) notes.push(`Activities are limited to type "${opts.activityType}".`);

	return buildTrends({ ...range, period: opts.period, data, errors, notes: notes.length ? notes : undefined });
}
