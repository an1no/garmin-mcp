/**
 * get_health_snapshots: Health Snapshot sessions, the short health readings a user starts on the watch.
 * Garmin's Personal API lists them as wellness activities (type HEALTH_MONITORING), each with the
 * average, lowest and highest heart rate, HRV, stress, respiration and SpO2 of the session.
 * Free-text notes, device details and IDs are left out.
 */
import { GarminApiError, type GarminClient } from "./garmin";
import { compact, connectDate, num, round } from "./format";
import { chunkRange, mapLimit } from "./parts";

type Json = Record<string, unknown>;

export const SNAPSHOT_DEFAULT_DAYS = 30;
/** Garmin doesn't document a range limit for this endpoint; 28-day requests stay on the safe side. */
const CHUNK_DAYS = 28;
const CONCURRENCY = 3;
/** Sessions listed in full (the newest); the averages cover all of them. */
export const SNAPSHOT_MAX_LISTED = 60;

/** Garmin's summary types -> output field and rounding. */
const METRICS: Record<string, { key: string; digits: number }> = {
	HEART_RATE: { key: "heartRate", digits: 0 },
	WRIST_HEART_RATE: { key: "wristHeartRate", digits: 0 },
	STRESS: { key: "stress", digits: 0 },
	RESPIRATION: { key: "respiration", digits: 1 },
	SPO2: { key: "spo2", digits: 0 },
	RMSSD_HRV: { key: "hrvRmssd", digits: 0 },
	SDRR_HRV: { key: "hrvSdrr", digits: 0 },
};

export const SNAPSHOT_UNITS = {
	heartRate: "bpm",
	wristHeartRate: "bpm",
	stress: "Garmin stress level, 0-100",
	respiration: "breaths per minute",
	spo2: "percent",
	hrvRmssd: "milliseconds (RMSSD)",
	hrvSdrr: "milliseconds (SDRR)",
	durationSeconds: "seconds",
	averages: "mean of each session's average",
};

function obj(value: unknown): Json {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

/** Garmin's ConnectTimestamp ({ date }), an ISO-like string or epoch ms -> "YYYY-MM-DDTHH:MM:SS" (no zone). */
function timestamp(value: unknown): string | undefined {
	const v = value && typeof value === "object" && !Array.isArray(value) ? (value as Json).date : value;
	if (typeof v === "number" && Number.isFinite(v)) return new Date(v).toISOString().slice(0, 19);
	if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v)) return v.replace(" ", "T").slice(0, 19);
	return undefined;
}

function secondsBetween(from: string | undefined, to: string | undefined): number | undefined {
	if (!from || !to) return undefined;
	const ms = Date.parse(`${to}Z`) - Date.parse(`${from}Z`);
	return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 1000) : undefined;
}

/** One WellnessActivitySummaryDTO -> date, local times, duration and avg/min/max per metric. */
export function shapeSnapshot(raw: unknown): Json {
	const r = obj(raw);
	const startLocal = timestamp(r.startTimestampLocal);
	const endLocal = timestamp(r.endTimestampLocal);
	const startGmt = timestamp(r.startTimestampGMT);
	const endGmt = timestamp(r.endTimestampGMT);
	const metrics: Json = {};
	for (const item of Array.isArray(r.summaryTypeDataList) ? r.summaryTypeDataList : []) {
		const m = obj(item);
		const metric = typeof m.summaryType === "string" ? METRICS[m.summaryType] : undefined;
		if (!metric) continue;
		metrics[metric.key] = compact({
			avg: round(m.avgValue, metric.digits),
			min: round(m.minValue, metric.digits),
			max: round(m.maxValue, metric.digits),
		});
	}
	return compact({
		date: connectDate(r.calendarDate) ?? (startLocal ?? startGmt)?.slice(0, 10),
		start: startLocal,
		end: endLocal,
		// Only when the local times are missing; marked as UTC.
		startUtc: startLocal ? undefined : startGmt && `${startGmt}Z`,
		durationSeconds: secondsBetween(startGmt, endGmt) ?? secondsBetween(startLocal, endLocal),
		name: r.activityName,
		type: r.wellnessActivityType === "HEALTH_MONITORING" ? undefined : r.wellnessActivityType,
		...metrics,
	});
}

/** One request's sessions; Garmin answers 404 when there are none. */
async function fetchChunk(garmin: GarminClient, range: { startDate: string; endDate: string }): Promise<unknown[]> {
	try {
		const raw = await garmin.get(`/wellnessactivity-service/activity/summary/range/${range.startDate}/${range.endDate}`);
		return Array.isArray(raw) ? raw : [];
	} catch (error) {
		if (error instanceof GarminApiError && error.status === 404) return [];
		throw error;
	}
}

/** Health Snapshot sessions in a range (oldest first), with the averages over all of them. */
export async function fetchHealthSnapshots(garmin: GarminClient, range: { startDate: string; endDate: string }): Promise<Json> {
	const chunks = chunkRange(range.startDate, range.endDate, CHUNK_DAYS);
	if (chunks.length > 1) await garmin.getAccessToken(); // one token request up front instead of one per parallel call
	const lists = await mapLimit(chunks, CONCURRENCY, (chunk) => fetchChunk(garmin, chunk));
	const sortKey = (s: Json) => String(s.start ?? s.startUtc ?? s.date ?? "");
	const all = lists
		.flat()
		.map(shapeSnapshot)
		.filter((s) => s.date !== undefined)
		.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

	const averages: Json = {};
	for (const { key, digits } of Object.values(METRICS)) {
		const values = all.map((s) => num(obj(s[key]).avg)).filter((v): v is number => v !== undefined);
		if (values.length) averages[key] = round(values.reduce((a, b) => a + b, 0) / values.length, digits);
	}
	const listed = all.slice(-SNAPSHOT_MAX_LISTED);
	return compact({
		...range,
		units: SNAPSHOT_UNITS,
		count: all.length,
		averages,
		note: listed.length < all.length ? `Showing the newest ${listed.length} of ${all.length} sessions; the averages cover all of them.` : undefined,
		message: all.length
			? undefined
			: "No Health Snapshots in this range. Garmin only records one when the user starts a Health Snapshot on the watch.",
		snapshots: listed,
	});
}
