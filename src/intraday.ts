/**
 * get_day_details: heart rate through one day, the overnight HRV readings and SpO2, averaged into
 * intervals (default 15 minutes) so a day stays a few dozen rows instead of hundreds of readings.
 *
 * Garmin's value arrays carry GMT epoch timestamps; they are shown as local clock times in the
 * user's timezone (the same one that decides "today").
 */
import { GarminApiError, type GarminClient } from "./garmin";
import { compact, num, round } from "./format";

type Json = Record<string, unknown>;

export const DAY_DETAIL_PARTS = ["heartRate", "hrv", "spo2"] as const;
export type DayDetailPart = (typeof DAY_DETAIL_PARTS)[number];

const MAX_ABNORMAL_READINGS = 20;

function obj(value: unknown): Json {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function arr(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Wall-clock time in `timeZone` for a GMT epoch, returned as epoch milliseconds of that wall
 * clock read as UTC. That makes local times sortable and easy to bucket without a date library.
 */
export function localWallClock(epochMs: number, timeZone: string): number {
	let fmt = formatters.get(timeZone);
	if (!fmt) {
		fmt = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
		formatters.set(timeZone, fmt);
	}
	const p: Record<string, number> = {};
	for (const part of fmt.formatToParts(new Date(epochMs))) {
		if (part.type !== "literal") p[part.type] = Number(part.value);
	}
	return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
}

/** Epoch milliseconds of a Garmin "local" ISO string without offset (e.g. 2025-03-01T02:15:00.0), read as UTC. */
export function parseLocalIso(value: unknown): number | undefined {
	if (typeof value !== "string" || value.length < 16) return undefined;
	const ms = Date.parse(`${value.slice(0, 19)}Z`);
	return Number.isNaN(ms) ? undefined : ms;
}

/** "HH:MM" of a wall-clock epoch (see localWallClock). */
export function clock(wallMs: number): string {
	return new Date(wallMs).toISOString().slice(11, 16);
}

type Point = { t: number; v: number };

/** Averages points into `intervalMinutes` buckets; a bucket with one reading is just { time, value }. */
export function bucketSeries(points: Point[], intervalMinutes: number, digits = 0): Json[] {
	const size = intervalMinutes * 60_000;
	const buckets = new Map<number, number[]>();
	for (const p of points) {
		const key = Math.floor(p.t / size) * size;
		buckets.set(key, [...(buckets.get(key) ?? []), p.v]);
	}
	return [...buckets.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([key, values]) =>
			values.length === 1
				? { time: clock(key), value: round(values[0], digits) }
				: {
						time: clock(key),
						avg: round(values.reduce((a, b) => a + b, 0) / values.length, digits),
						min: Math.min(...values),
						max: Math.max(...values),
					},
		);
}

/** Maps descriptor rows ({index,key} in various field names) to key -> column index. */
function columns(descriptors: unknown[], indexField: string, keyField: string): Map<string, number> {
	const out = new Map<string, number>();
	for (const d of descriptors.map(obj)) {
		if (typeof d[keyField] === "string" && typeof d[indexField] === "number") out.set(d[keyField] as string, d[indexField] as number);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Shapers
// ---------------------------------------------------------------------------

/** /wellness-service/wellness/dailyHeartRate -> summary + interval series in local time. */
export function shapeHeartRate(raw: unknown, timeZone: string, intervalMinutes: number): Json | undefined {
	const r = obj(raw);
	const cols = columns(arr(r.heartRateValueDescriptors), "index", "key");
	const tsIdx = cols.get("timestamp") ?? 0;
	const hrIdx = cols.get("heartrate") ?? 1;

	const toPoints = (rows: unknown[]): Point[] =>
		rows.flatMap((row) => {
			if (!Array.isArray(row)) return [];
			const ts = num(row[tsIdx]);
			const hr = num(row[hrIdx]);
			return ts !== undefined && hr !== undefined && hr > 0 ? [{ t: localWallClock(ts, timeZone), v: hr }] : [];
		});

	const points = toPoints(arr(r.heartRateValues));
	if (!points.length && num(r.restingHeartRate) === undefined) return undefined;
	const lowest = points.reduce<Point | undefined>((a, p) => (!a || p.v < a.v ? p : a), undefined);
	const highest = points.reduce<Point | undefined>((a, p) => (!a || p.v > a.v ? p : a), undefined);
	const abnormal = toPoints(arr(r.abnormalHRValuesArray));

	return compact({
		resting: r.restingHeartRate,
		lastSevenDaysAvgResting: r.lastSevenDaysAvgRestingHeartRate,
		min: lowest ? { bpm: lowest.v, time: clock(lowest.t) } : r.minHeartRate,
		max: highest ? { bpm: highest.v, time: clock(highest.t) } : r.maxHeartRate,
		readings: points.length,
		abnormalThresholds: { high: r.abnormalHrThresholdValue, low: r.lowAbnormalHrThresholdValue },
		abnormalReadings: abnormal.slice(0, MAX_ABNORMAL_READINGS).map((p) => ({ time: clock(p.t), bpm: p.v })),
		abnormalReadingsTotal: abnormal.length > MAX_ABNORMAL_READINGS ? abnormal.length : undefined,
		series: bucketSeries(points, intervalMinutes),
	});
}

/** /hrv-service/hrv/{date} -> night summary + interval series (local times). */
export function shapeHrvNight(raw: unknown, intervalMinutes: number): Json | undefined {
	const r = obj(raw);
	const s = obj(r.hrvSummary);
	const b = obj(s.baseline);
	const points: Point[] = arr(r.hrvReadings).flatMap((item) => {
		const reading = obj(item);
		const t = parseLocalIso(reading.readingTimeLocal);
		const v = num(reading.hrvValue);
		return t !== undefined && v !== undefined && v > 0 ? [{ t, v }] : [];
	});
	if (!points.length && num(s.lastNightAvg) === undefined) return undefined;
	const sleepStart = parseLocalIso(r.sleepStartTimestampLocal);
	const sleepEnd = parseLocalIso(r.sleepEndTimestampLocal);
	return compact({
		lastNightAvg: s.lastNightAvg,
		lastNight5MinHigh: s.lastNight5MinHigh,
		weeklyAvg: s.weeklyAvg,
		status: s.status,
		baseline: { balancedLow: b.balancedLow, balancedUpper: b.balancedUpper, lowUpper: b.lowUpper },
		sleepStart: sleepStart !== undefined ? clock(sleepStart) : undefined,
		sleepEnd: sleepEnd !== undefined ? clock(sleepEnd) : undefined,
		readings: points.length,
		series: bucketSeries(points, intervalMinutes),
	});
}

/** /wellness-service/wellness/daily/spo2acclimation/{date} -> summary + hourly averages (local times). */
export function shapeSpo2(raw: unknown, timeZone: string): Json | undefined {
	const r = obj(raw);
	const cols = columns(arr(r.spO2HourlyAveragesDescriptorList), "spo2ValueDescIndex", "spo2ValueDescKey");
	const tsIdx = cols.get("timestamp") ?? 0;
	const levelIdx = cols.get("spo2Level") ?? 1;
	const hourly = arr(r.spO2HourlyAverages).flatMap((row) => {
		if (!Array.isArray(row)) return [];
		const ts = num(row[tsIdx]);
		const level = num(row[levelIdx]);
		return ts !== undefined && level !== undefined && level > 0
			? [{ time: clock(localWallClock(ts, timeZone)), percent: round(level, 0) }]
			: [];
	});
	if (!hourly.length && num(r.averageSpO2) === undefined && num(r.latestSpO2) === undefined) return undefined;
	const latestAt = parseLocalIso(r.latestSpO2TimestampLocal);
	return compact({
		average: round(r.averageSpO2, 0),
		lowest: r.lowestSpO2,
		latest: r.latestSpO2,
		latestAt: latestAt !== undefined ? clock(latestAt) : undefined,
		averageDuringSleep: round(r.avgSleepSpO2, 0),
		lastSevenDaysAverage: round(r.lastSevenDaysAvgSpO2, 0),
		hourly,
	});
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

function describeError(error: unknown): string {
	if (error instanceof GarminApiError) return error.message;
	if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
		return "Garmin did not respond in time.";
	}
	return error instanceof Error ? error.message : String(error);
}

/**
 * Fetches the requested parts in parallel. A part that fails is reported in `errors` while the
 * others are still returned; if every part fails, the first error is thrown.
 */
export async function fetchDayDetails(
	garmin: GarminClient,
	opts: { date: string; timeZone: string; intervalMinutes: number; parts: readonly DayDetailPart[] },
): Promise<Json> {
	const { date, timeZone, intervalMinutes } = opts;
	await garmin.getAccessToken(); // one token request up front instead of one per parallel call

	const fetchers: Record<DayDetailPart, () => Promise<Json | undefined>> = {
		heartRate: async () =>
			shapeHeartRate(await garmin.get("/wellness-service/wellness/dailyHeartRate", { date }), timeZone, intervalMinutes),
		hrv: async () => shapeHrvNight(await garmin.get(`/hrv-service/hrv/${date}`), intervalMinutes),
		spo2: async () => shapeSpo2(await garmin.get(`/wellness-service/wellness/daily/spo2acclimation/${date}`), timeZone),
	};

	const result: Json = {};
	const errors: Partial<Record<DayDetailPart, string>> = {};
	const failures: unknown[] = [];
	const missing: DayDetailPart[] = [];
	await Promise.all(
		opts.parts.map(async (part) => {
			try {
				const shaped = await fetchers[part]();
				if (shaped) result[part] = shaped;
				else missing.push(part);
			} catch (error) {
				errors[part] = describeError(error);
				failures.push(error);
			}
		}),
	);
	if (failures.length === opts.parts.length) throw failures[0];

	return compact({
		date,
		timeZone,
		intervalMinutes,
		units: { heartRate: "bpm", hrv: "milliseconds", spo2: "%" },
		note:
			"Times are local. hrv is the night that ended on this date; series rows are averages per interval " +
			"(rows with a single reading show just its value).",
		noData: missing.length ? DAY_DETAIL_PARTS.filter((p) => missing.includes(p)) : undefined,
		errors,
		...result,
	});
}
