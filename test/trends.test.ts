import { describe, expect, it } from "vitest";
import { GarminApiError } from "../src/garmin";
import { summarizeActivity, summarizeDailySummaryV2, summarizeHrv, summarizeSleep } from "../src/format";
import {
	aggregateActivities,
	aggregateVo2Max,
	aggregateWeight,
	MAX_GARMIN_REQUESTS,
	plannedRequests,
	aggregateDaily,
	aggregateHrv,
	aggregateSleep,
	buildTrends,
	collectTrends,
	periodKey,
	periodsInRange,
} from "../src/trends";
import { chunkRange, mapLimit } from "../src/parts";
import { vo2DailyRecords } from "../src/fitness";
import { fakeGarmin, spanDays } from "./helpers";

// Synthetic Garmin payloads, shaped like the Personal API Swagger schemas.
const rawSleep = (date: string, hours: number | null, score: number | null, extra: object = {}) => ({
	calendarDate: date,
	sleepTimeSeconds: hours === null ? null : hours * 3600,
	deepSleepSeconds: 3600,
	lightSleepSeconds: 4 * 3600,
	remSleepSeconds: 5400,
	awakeSleepSeconds: 600,
	avgHeartRate: 52,
	avgSleepStress: 14,
	averageRespirationValue: 14.5,
	sleepScores: { overall: { value: score, qualifierKey: "GOOD" } },
	...extra,
});
const rawDay = (date: string, steps: number, resting: number, extra: object = {}) => ({
	calendarDate: date,
	movement: { steps: { value: steps, goal: 8000, distanceInMeters: steps * 0.8 } },
	heartRate: { restingValue: resting, minValue: 45, maxValue: 150 },
	stress: { avgLevel: 30 },
	bodyBattery: { maxValue: 90, minValue: 20, chargedValue: 60, drainedValue: 65 },
	intensityMinutes: { moderate: 20, vigorous: 10, goal: 150 },
	calories: { burnedActive: 500 },
	...extra,
});
const rawHrv = (date: string, avg: number, status: string) => ({ calendarDate: date, lastNightAvg: avg, weeklyAvg: 60, status });
const rawActivity = (id: number, date: string, type: string, km: number, extra: object = {}) => ({
	activityId: id,
	activityName: `${type} ${id}`,
	activityType: { typeKey: type },
	eventType: { typeKey: "training" },
	startTimeLocal: `${date} 07:00:00`,
	distance: km * 1000,
	duration: km * 300,
	elevationGain: km * 10,
	calories: km * 60,
	...extra,
});
const round1 = (n: number) => Math.round(n * 10) / 10;

describe("periods", () => {
	it("periodKey: weeks start on Monday, months are YYYY-MM", () => {
		expect(periodKey("2025-03-05", "week")).toBe("2025-03-03"); // Wednesday
		expect(periodKey("2025-03-09", "week")).toBe("2025-03-03"); // Sunday
		expect(periodKey("2025-03-10", "week")).toBe("2025-03-10"); // Monday
		expect(periodKey("2025-01-01", "week")).toBe("2024-12-30"); // across the year boundary
		expect(periodKey("2025-03-31", "month")).toBe("2025-03");
	});

	it("periodsInRange: partial first/last periods and month lengths", () => {
		expect(periodsInRange("2025-01-15", "2025-03-10", "month")).toEqual([
			{ period: "2025-01", from: "2025-01-15", to: "2025-01-31" },
			{ period: "2025-02", from: "2025-02-01", to: "2025-02-28" },
			{ period: "2025-03", from: "2025-03-01", to: "2025-03-10" },
		]);
		expect(periodsInRange("2024-02-01", "2024-02-29", "month")).toEqual([
			{ period: "2024-02", from: "2024-02-01", to: "2024-02-29" },
		]);
		expect(periodsInRange("2025-01-01", "2025-01-12", "week")).toEqual([
			{ period: "2024-12-30", from: "2025-01-01", to: "2025-01-05" },
			{ period: "2025-01-06", from: "2025-01-06", to: "2025-01-12" },
		]);
		expect(periodsInRange("2025-01-01", "2025-12-31", "month")).toHaveLength(12);
		expect(periodsInRange("2025-12-31", "2025-12-31", "month")).toHaveLength(1);
	});

	it("chunkRange: contiguous chunks within the size", () => {
		const chunks = chunkRange("2025-01-01", "2025-12-31", 31);
		expect(chunks).toHaveLength(12);
		expect(chunks[0]).toEqual({ startDate: "2025-01-01", endDate: "2025-01-31" });
		expect(chunks.at(-1)?.endDate).toBe("2025-12-31");
		for (let i = 1; i < chunks.length; i++) {
			expect(spanDays(chunks[i - 1]!.endDate, chunks[i]!.startDate)).toBe(2); // next day
		}
		for (const c of chunks) expect(spanDays(c.startDate, c.endDate)).toBeLessThanOrEqual(31);
		expect(chunkRange("2025-05-05", "2025-05-05", 31)).toEqual([{ startDate: "2025-05-05", endDate: "2025-05-05" }]);
		expect(chunkRange("2025-01-01", "2025-12-31", 183)).toHaveLength(2);
	});

	it("mapLimit: keeps order and never runs more than the limit at once", async () => {
		let running = 0;
		let peak = 0;
		const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
			running++;
			peak = Math.max(peak, running);
			await new Promise((r) => setTimeout(r, 5 * (8 - n)));
			running--;
			return n * 10;
		});
		expect(out).toEqual([10, 20, 30, 40, 50, 60, 70]);
		expect(peak).toBeLessThanOrEqual(3);
		expect(await mapLimit([], 3, async (n: number) => n)).toEqual([]);
	});
});

describe("aggregators", () => {
	it("aggregateSleep: averages, extremes, skips empty nights", () => {
		const nights = [
			rawSleep("2025-03-01", 8, 85),
			rawSleep("2025-03-02", 6, 60),
			rawSleep("2025-03-03", 7, 75),
			rawSleep("2025-03-04", null, null),
		].map(summarizeSleep);
		const s = aggregateSleep(nights)!;
		expect(s).toMatchObject({
			nights: 3,
			avgSleepHours: 7,
			minSleepHours: 6,
			maxSleepHours: 8,
			avgSleepScore: 73,
			avgDeepMinutes: 60,
			avgRemMinutes: 90,
			avgSleepHeartRate: 52,
		});
		expect(s.bestNight).toMatchObject({ date: "2025-03-01", sleepScore: 85 });
		expect(s.worstNight).toMatchObject({ date: "2025-03-02", sleepScore: 60 });
		expect(aggregateSleep([])).toBeUndefined();
		expect(aggregateSleep([summarizeSleep(rawSleep("2025-03-04", null, null))])).toBeUndefined();
	});

	it("aggregateDaily: totals, resting HR range, ignores negative stress and days not worn", () => {
		const days = [
			rawDay("2025-03-01", 10000, 50),
			rawDay("2025-03-02", 4000, 54, { stress: { avgLevel: -1 } }),
			rawDay("2025-03-03", 0, 0),
		].map(summarizeDailySummaryV2);
		expect(aggregateDaily(days)).toMatchObject({
			days: 2,
			totalSteps: 14000,
			avgSteps: 7000,
			mostStepsDay: { date: "2025-03-01", steps: 10000 },
			totalDistanceKm: 11.2,
			avgRestingHeartRate: 52,
			minRestingHeartRate: 50,
			maxRestingHeartRate: 54,
			avgStress: 30,
			intensityMinutes: { moderate: 40, vigorous: 20 },
			avgBodyBatteryHighest: 90,
		});
	});

	it("aggregateHrv: stats, latest status by date, status counts", () => {
		const nights = summarizeHrv({
			hrvSummaries: [rawHrv("2025-03-02", 70, "BALANCED"), rawHrv("2025-03-01", 50, "UNBALANCED"), rawHrv("2025-03-03", 60, "BALANCED")],
		});
		expect(aggregateHrv(nights)).toMatchObject({
			nights: 3,
			avgLastNight: 60,
			minLastNight: 50,
			maxLastNight: 70,
			latestStatus: "BALANCED",
			statusCounts: { BALANCED: 2, UNBALANCED: 1 },
		});
	});

	it("aggregateActivities: totals, types sorted by count, longest", () => {
		const acts = [
			rawActivity(1, "2025-03-01", "running", 10),
			rawActivity(2, "2025-03-02", "running", 5),
			rawActivity(3, "2025-03-03", "cycling", 40),
		].map(summarizeActivity);
		const a = aggregateActivities(acts)!;
		expect(a).toMatchObject({ count: 3, distanceKm: 55, durationHours: round1((55 * 300) / 3600), elevationGainMeters: 550 });
		expect(a.byType).toEqual([
			expect.objectContaining({ type: "running", count: 2, distanceKm: 15 }),
			expect.objectContaining({ type: "cycling", count: 1, distanceKm: 40 }),
		]);
		expect(a.longest).toMatchObject({ activityId: 3, distanceKm: 40, date: "2025-03-03" });
		expect(aggregateActivities([])).toBeUndefined();
	});
});

describe("buildTrends", () => {
	it("groups by month, ignores out-of-range records, overall covers the range", () => {
		const t = buildTrends({
			startDate: "2025-01-01",
			endDate: "2025-03-31",
			period: "month",
			data: {
				sleep: [rawSleep("2025-01-10", 7, 70), rawSleep("2025-02-10", 8, 80), rawSleep("2024-12-31", 9, 99)].map(summarizeSleep),
				activities: [rawActivity(1, "2025-01-05", "running", 10), rawActivity(2, "2025-03-05", "running", 20)].map(summarizeActivity),
			},
			errors: {},
		}) as Record<string, any>;
		expect(t.periods).toHaveLength(3);
		expect(t.periods[0]).toMatchObject({ period: "2025-01", sleep: { nights: 1 } });
		expect(t.periods[1].activities).toBeUndefined();
		expect(t.periods[2].sleep).toBeUndefined();
		expect(t.overall.sleep.nights).toBe(2);
		expect(t.overall.activities.distanceKm).toBe(30);
		expect(t.errors).toBeUndefined();
		expect(t.overall.daily).toBeUndefined();
		expect(t.groupedBy).toBe("month");
	});
});

describe("collectTrends", () => {
	const garminFor = (opts: { failHrv?: boolean; failAll?: boolean; activityCount?: number } = {}) =>
		fakeGarmin((path, query) => {
			if (opts.failAll) throw new GarminApiError("Rate limited by Garmin - wait a bit and try again.", 429, path);
			if (path.startsWith("/sleep-service")) return [rawSleep(String(query.startDate), 7, 70)];
			if (path.startsWith("/usersummary-service")) return { data: [rawDay(String(query.startDate), 8000, 55)] };
			if (path.startsWith("/hrv-service")) {
				if (opts.failHrv) throw new GarminApiError("Rate limited by Garmin - wait a bit and try again.", 429, path);
				return { hrvSummaries: [rawHrv(path.split("/").at(-2)!, 60, "BALANCED")] };
			}
			if (path.startsWith("/activitylist-service")) {
				const all = Array.from({ length: opts.activityCount ?? 3 }, (_, i) => rawActivity(i + 1, "2025-06-01", "running", 5));
				return all.slice(Number(query.start), Number(query.start) + Number(query.limit));
			}
			throw new Error(`unexpected path ${path}`);
		});

	it("a year: 12 sleep calls (<=31 days), 2 daily, 2 HRV, 1 activity page, 1 token request", async () => {
		const g = garminFor();
		const t = (await collectTrends(g.client, {
			startDate: "2025-01-01",
			endDate: "2025-12-31",
			period: "month",
			metrics: ["sleep", "daily", "hrv", "activities"],
		})) as Record<string, any>;
		const count = (prefix: string) => g.calls.filter((c) => c.path.startsWith(prefix)).length;
		expect(g.tokenCalls).toBe(1);
		expect(count("/sleep-service")).toBe(12);
		expect(count("/usersummary-service")).toBe(2);
		expect(count("/hrv-service")).toBe(2);
		expect(count("/activitylist-service")).toBe(1);
		for (const c of g.calls.filter((c) => c.path.startsWith("/sleep-service"))) {
			expect(spanDays(String(c.query.startDate), String(c.query.endDate))).toBeLessThanOrEqual(31);
		}
		expect(t.periods).toHaveLength(12);
		expect(t.overall).toMatchObject({ sleep: { nights: 12 }, daily: { days: 2 }, hrv: { nights: 2 }, activities: { count: 3 } });
	});

	it("pages activities and stops at 1000 with a note", async () => {
		const g = garminFor({ activityCount: 250 });
		const t = (await collectTrends(g.client, { startDate: "2025-01-01", endDate: "2025-12-31", period: "month", metrics: ["activities"] })) as Record<string, any>;
		expect(g.calls).toHaveLength(3);
		expect(t.overall.activities.count).toBe(250);
		expect(t.notes).toBeUndefined();

		const big = garminFor({ activityCount: 1500 });
		const t2 = (await collectTrends(big.client, { startDate: "2025-01-01", endDate: "2025-12-31", period: "month", metrics: ["activities"] })) as Record<string, any>;
		expect(big.calls).toHaveLength(10);
		expect(t2.overall.activities.count).toBe(1000);
		expect(t2.notes[0]).toMatch(/More than 1000 activities/);
	});

	it("reports one failing metric and still returns the others", async () => {
		const g = garminFor({ failHrv: true });
		const t = (await collectTrends(g.client, { startDate: "2025-03-01", endDate: "2025-03-31", period: "week", metrics: ["sleep", "hrv"] })) as Record<string, any>;
		expect(t.errors.hrv).toMatch(/Rate limited/);
		expect(t.overall.sleep.nights).toBe(1);
		expect(t.overall.hrv).toBeUndefined();
		expect(t.periods).toHaveLength(6); // March 2025 touches 6 ISO weeks
	});

	it("throws the Garmin error when every metric fails", async () => {
		const g = garminFor({ failAll: true });
		await expect(
			collectTrends(g.client, { startDate: "2025-03-01", endDate: "2025-03-31", period: "week", metrics: ["sleep", "daily"] }),
		).rejects.toBeInstanceOf(GarminApiError);
	});

	it("passes activityType through and notes it", async () => {
		const g = garminFor();
		const t = (await collectTrends(g.client, {
			startDate: "2025-03-01",
			endDate: "2025-03-31",
			period: "week",
			metrics: ["activities"],
			activityType: "running",
		})) as Record<string, any>;
		expect(g.calls[0]!.query.activityType).toBe("running");
		expect(t.notes[0]).toMatch(/running/);
	});
});

describe("VO2 max and weight in trends", () => {
	const maxmetRow = (date: string, generic?: number, cycling?: number) => ({
		generic: generic === undefined ? null : { calendarDate: date, vo2MaxPreciseValue: generic, vo2MaxValue: Math.round(generic) },
		cycling: cycling === undefined ? null : { calendarDate: date, vo2MaxPreciseValue: cycling, vo2MaxValue: Math.round(cycling) },
	});

	it("vo2DailyRecords: one record per date with each sport's precise value", () => {
		expect(vo2DailyRecords([maxmetRow("2026-03-02", 48.44), maxmetRow("2026-03-01", 48.1, 52.06), {}, null])).toEqual([
			{ calendarDate: "2026-03-01", generic: 48.1, cycling: 52.1 },
			{ calendarDate: "2026-03-02", generic: 48.4 },
		]);
	});

	it("aggregateVo2Max: per sport latest/average/min/max/change, in date order", () => {
		expect(
			aggregateVo2Max([
				{ calendarDate: "2026-03-03", generic: 49 },
				{ calendarDate: "2026-03-01", generic: 48, cycling: 52 },
				{ calendarDate: "2026-03-02", generic: 48.5 },
			]),
		).toEqual({
			generic: { latest: 49, average: 48.5, min: 48, max: 49, change: 1, days: 3 },
			cycling: { latest: 52, average: 52, min: 52, max: 52, change: 0, days: 1 },
		});
		expect(aggregateVo2Max([])).toBeUndefined();
	});

	it("aggregateWeight: measurements, average, range, first/latest, change, body fat", () => {
		expect(
			aggregateWeight([
				{ date: "2026-03-05", weightKg: 71.5, bodyFatPercent: 18 },
				{ date: "2026-03-01", weightKg: 73, bodyFatPercent: 19 },
				{ date: "2026-03-03", weightKg: 72 },
				{ date: "2026-03-04" },
			]),
		).toEqual({
			measurements: 3,
			averageKg: 72.2,
			minKg: 71.5,
			maxKg: 73,
			firstKg: 73,
			latestKg: 71.5,
			changeKg: -1.5,
			averageBodyFatPercent: 18.5,
		});
		expect(aggregateWeight([{ date: "2026-03-01" }])).toBeUndefined();
	});

	it("collectTrends fetches VO2 max in 28-day and weight in 364-day chunks, groups them by month", async () => {
		const g = fakeGarmin((path) => {
			const [from] = path.split("/").slice(-2);
			if (path.startsWith("/metrics-service/metrics/maxmet/daily/")) return [maxmetRow(from!, 48)];
			if (path.startsWith("/weight-service/weight/all/")) return [{ calendarDate: from, weight: 72000 }, { calendarDate: "2026-06-15", weight: 71.2 }];
			throw new Error(`unexpected ${path}`);
		});
		const t = (await collectTrends(g.client, {
			startDate: "2026-01-01",
			endDate: "2026-12-31",
			period: "month",
			metrics: ["vo2max", "weight"],
		})) as Record<string, any>;
		const vo2Calls = g.calls.filter((c) => c.path.includes("/maxmet/"));
		const weightCalls = g.calls.filter((c) => c.path.includes("/weight/all/"));
		expect(vo2Calls).toHaveLength(14);
		for (const c of vo2Calls) expect(spanDays(c.path.split("/").at(-2)!, c.path.split("/").at(-1)!)).toBeLessThanOrEqual(28);
		expect(weightCalls).toHaveLength(2);
		expect(weightCalls.map((c) => c.path.split("/").slice(-2).join("/"))).toEqual(["2026-01-01/2026-12-30", "2026-12-31/2026-12-31"]);
		expect(t.overall.vo2max.generic).toMatchObject({ latest: 48, days: 14 });
		expect(t.overall.weight).toMatchObject({ firstKg: 72, minKg: 71.2 });
		expect(t.periods.find((p: { period: string }) => p.period === "2026-06").weight).toMatchObject({ measurements: 2 });
		expect(t.units).toMatchObject({ vo2max: "ml/kg/min", weight: "kg" });
	});

	it("the largest allowed request stays within the Garmin request budget", () => {
		const year = { startDate: "2024-01-01", endDate: "2024-12-31" }; // 366 days, a leap year
		const all = ["sleep", "daily", "hrv", "activities", "vo2max", "weight"] as const;
		expect(plannedRequests(year, all)).toBe(12 + 2 + 2 + 10 + 14 + 2);
		expect(plannedRequests(year, all)).toBeLessThanOrEqual(MAX_GARMIN_REQUESTS);
		expect(plannedRequests(year, ["sleep"])).toBe(12);
	});
});
