import { describe, expect, it } from "vitest";
import { GarminApiError } from "../src/garmin";
import {
	fetchFitnessProfile,
	fetchVo2Max,
	fetchWeight,
	kg,
	shapeFitnessAge,
	shapeHeartRateZones,
	shapeWeight,
	shapeWeightGoal,
	summarizeVo2Max,
	summarizeWeight,
	weightDays,
} from "../src/fitness";
import { fakeGarmin, spanDays } from "./helpers";

const round1 = (n: number) => Math.round(n * 10) / 10;

describe("VO2 max", () => {
	const row = (date: string, generic: number | null, cycling?: number) => ({
		generic: generic === null ? null : { calendarDate: date, vo2MaxPreciseValue: generic, vo2MaxValue: Math.round(generic) },
		cycling: cycling === undefined ? null : { calendarDate: date, vo2MaxPreciseValue: cycling, vo2MaxValue: Math.round(cycling) },
	});

	it("per sport: first/latest/change/min/max and the dates the whole number changed", () => {
		const s = summarizeVo2Max([
			row("2025-03-03", 47.6, 52.1),
			row("2025-03-01", 47.2),
			row("2025-03-02", 47.4),
			row("2025-03-04", 48.1),
			row("2025-03-05", null),
			{},
			null,
		]) as Record<string, any>;
		expect(Object.keys(s)).toEqual(["generic", "cycling"]);
		expect(s.generic).toMatchObject({
			first: { date: "2025-03-01", vo2Max: 47, precise: 47.2 },
			latest: { date: "2025-03-04", vo2Max: 48, precise: 48.1 },
			change: 0.9,
			min: 47.2,
			max: 48.1,
			daysWithValue: 4,
		});
		// 47 (03-01) -> 47 -> 48 (03-03) -> 48
		expect(s.generic.changes.map((c: { date: string }) => c.date)).toEqual(["2025-03-01", "2025-03-03"]);
		expect(s.cycling).toMatchObject({ daysWithValue: 1, change: 0 });
	});

	it("keeps one reading per date (the last one seen)", () => {
		const s = summarizeVo2Max([row("2025-03-01", 47.2), row("2025-03-01", 47.4)]) as Record<string, any>;
		expect(s.generic.daysWithValue).toBe(1);
		expect(s.generic.latest.precise).toBe(47.4);
	});

	it("fetchVo2Max: a year in 28-day chunks; no data gives a message", async () => {
		const g = fakeGarmin((path) => [row(path.split("/").at(-2)!, 50)]);
		const r = (await fetchVo2Max(g.client, { startDate: "2025-01-01", endDate: "2025-12-31" })) as Record<string, any>;
		expect(g.calls).toHaveLength(14);
		for (const c of g.calls) {
			const [from, to] = c.path.split("/").slice(-2);
			expect(c.path.startsWith("/metrics-service/metrics/maxmet/daily/")).toBe(true);
			expect(spanDays(from!, to!)).toBeLessThanOrEqual(28);
		}
		expect(r.sports.generic.daysWithValue).toBe(14);
		expect(r.note).toMatch(/running\/walking/);

		const empty = (await fetchVo2Max(fakeGarmin(() => []).client, { startDate: "2025-01-01", endDate: "2025-01-10" })) as Record<string, any>;
		expect(empty.sports).toBeUndefined();
		expect(empty.message).toMatch(/No VO2 max/);
	});
});

describe("weight", () => {
	it("kg: kilograms stay, grams are converted, junk is dropped", () => {
		expect(kg(72.46)).toBe(72.5);
		expect(kg(72460)).toBe(72.5);
		expect(kg(3100)).toBe(3.1);
		expect(kg(34)).toBe(34);
		for (const junk of [0, -3, "72", null, undefined, Number.NaN]) expect(kg(junk)).toBeUndefined();
	});

	it("shapeWeight: units and rounding", () => {
		expect(
			shapeWeight({ calendarDate: "2025-03-01", weight: 72460, bmi: 22.81, bodyFat: 18.44, bodyWater: 55.06, muscleMass: 33500, boneMass: 3100, visceralFat: 7, metabolicAge: 31.2 }),
		).toEqual({
			date: "2025-03-01",
			weightKg: 72.5,
			bmi: 22.8,
			bodyFatPercent: 18.4,
			bodyWaterPercent: 55.1,
			muscleMassKg: 33.5,
			boneMassKg: 3.1,
			visceralFat: 7,
			metabolicAge: 31,
		});
	});

	const page = (...days: [string, number, { entries?: number; min?: number; max?: number }?][]) => ({
		dailyWeightSummaries: days.map(([date, weight, extra = {}]) => ({
			summaryDate: date,
			numOfWeightEntries: extra.entries ?? 1,
			minWeight: extra.min ?? weight,
			maxWeight: extra.max ?? weight,
			latestWeight: { calendarDate: date, weight, bodyFat: 18.44, muscleMass: 33500, boneMass: 3100 },
			allWeightMetrics: [],
		})),
	});

	it("weightDays: one row per day, oldest first; multi-entry days get their range", () => {
		const days = weightDays([
			page(["2025-03-02", 72000], ["2025-03-01", 73.0, { entries: 2, min: 72.8, max: 73.2 }]),
			page(["2025-03-05", 71.4]),
			{ dailyWeightSummaries: [{ summaryDate: "2025-03-06", latestWeight: null, allWeightMetrics: [] }] },
		]);
		expect(days.map((d) => d.date)).toEqual(["2025-03-01", "2025-03-02", "2025-03-05"]);
		expect(days[0]).toMatchObject({ weightKg: 73, entries: 2, dayMinKg: 72.8, dayMaxKg: 73.2 });
		expect(days[1]).toMatchObject({ weightKg: 72, muscleMassKg: 33.5, boneMassKg: 3.1, bodyFatPercent: 18.4 });
		expect(days[1]).not.toHaveProperty("entries");
	});

	it("weightDays: falls back to the last of allWeightMetrics when latestWeight is missing", () => {
		const days = weightDays([
			{
				dailyWeightSummaries: [
					{ summaryDate: "2025-03-01", allWeightMetrics: [{ weight: 70.2 }, { weight: 70.0 }] },
				],
			},
		]);
		expect(days).toEqual([{ date: "2025-03-01", weightKg: 70 }]);
	});

	it("shapeWeightGoal: goal and range in kg; nothing usable gives undefined", () => {
		expect(
			shapeWeightGoal({ userGoals: [{ goalValue: 70000 }], userGoalRanges: [{ lowWeightGoalInGrams: 69000, highWeightGoalInGrams: 71000 }] }),
		).toEqual({ weightKg: 70, rangeKg: { low: 69, high: 71 } });
		expect(shapeWeightGoal({})).toBeUndefined();
		expect(shapeWeightGoal({ userGoals: [{ goalValue: -5 }] })).toBeUndefined();
	});

	it("summarizeWeight: first/latest/extremes/change/average and daily rows", () => {
		const days = weightDays([page(["2025-03-01", 73], ["2025-03-02", 72], ["2025-03-05", 71.4])]);
		const s = summarizeWeight(days, { startDate: "2025-03-01", endDate: "2025-03-31" }, { weightKg: 70 }) as Record<string, any>;
		expect(s).toMatchObject({
			measuredDays: 3,
			first: { date: "2025-03-01", weightKg: 73 },
			latest: { weightKg: 71.4 },
			changeKg: -1.6,
			averageWeightKg: 72.1,
			lowest: { date: "2025-03-05", weightKg: 71.4 },
			highest: { date: "2025-03-01", weightKg: 73 },
			goal: { weightKg: 70 },
		});
		expect(s.days).toHaveLength(3);
	});

	it("summarizeWeight: no data gives a message; many days give monthly averages", () => {
		const none = summarizeWeight([], { startDate: "2025-01-01", endDate: "2025-01-31" }) as Record<string, any>;
		expect(none.measuredDays).toBe(0);
		expect(none.message).toMatch(/No weight/);

		const many = Array.from({ length: 90 }, (_, i) => ({
			date: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10),
			weightKg: round1(80 - i * 0.05),
			bodyFatPercent: 20,
		}));
		const s = summarizeWeight(many, { startDate: "2025-01-01", endDate: "2025-03-31" }) as Record<string, any>;
		expect(s.days).toBeUndefined();
		expect(s.monthly.map((m: { month: string; measuredDays: number }) => [m.month, m.measuredDays])).toEqual([
			["2025-01", 31],
			["2025-02", 28],
			["2025-03", 31],
		]);
		expect(s.note).toMatch(/monthly averages/);
		expect(s.changeKg).toBe(round1(s.latest.weightKg - s.first.weightKg));
	});

	it("fetchWeight: 28-day chunks with includeAll=false; a failing goal request is ignored", async () => {
		const g = fakeGarmin((path) => {
			if (path.startsWith("/goal-service")) throw new GarminApiError("nope", 404, path);
			return page([path.split("/").at(-2)!, 75]);
		});
		const r = (await fetchWeight(g.client, { startDate: "2025-01-01", endDate: "2025-03-31" })) as Record<string, any>;
		const weightCalls = g.calls.filter((c) => c.path.startsWith("/weight-service/weight/range/"));
		expect(weightCalls).toHaveLength(4);
		expect(weightCalls.every((c) => c.query.includeAll === false)).toBe(true);
		expect(g.calls.find((c) => c.path.startsWith("/goal-service"))!.path).toMatch(/\/2025-03-26\/2025-03-31$/);
		expect(r.measuredDays).toBe(4);
		expect(r.goal).toBeUndefined();
	});

	it("fetchWeight: includes the goal when Garmin returns one", async () => {
		const g = fakeGarmin((path) =>
			path.startsWith("/goal-service") ? { userGoals: [{ goalValue: 68.5 }] } : page([path.split("/").at(-2)!, 75]),
		);
		const r = (await fetchWeight(g.client, { startDate: "2025-03-01", endDate: "2025-03-10" })) as Record<string, any>;
		expect(r.goal).toEqual({ weightKg: 68.5 });
	});
});

describe("Fitness Age and heart rate zones", () => {
	const fitnessAgePayload = [
		{
			chronologicalAge: 32,
			fitnessAge: 28.46,
			achievableFitnessAge: 25.04,
			previousFitnessAge: 29.1,
			lastUpdated: "2026-11-20T08:00:00.0",
			components: {
				vigorousDaysAvg: { value: 2.14, targetValue: 4, improvementValue: 1.86, potentialAge: 26.5, priority: 1, lastMeasurementDate: "2026-11-24" },
				rhr: { value: 55, targetValue: 52, improvementValue: 3, potentialAge: 27.9, priority: 2, stale: false },
				bmi: { value: 22.84, targetValue: 22.84, improvementValue: 0, priority: 3, stale: true, staleInputs: ["weight"] },
			},
		},
	];
	const zonesPayload = [
		{ sport: "DEFAULT", trainingMethod: "HR_MAX", maxHeartRateUsed: 190, restingHeartRateUsed: 55, zone1Floor: 95, zone2Floor: 114, zone3Floor: 133, zone4Floor: 152, zone5Floor: 171 },
		{ sport: "CYCLING", trainingMethod: "LACTATE_THRESHOLD", lactateThresholdHeartRateUsed: 165, maxHeartRateUsed: 185, zone1Floor: 100, zone2Floor: 120, zone3Floor: 140, zone4Floor: 155, zone5Floor: 166 },
		{ sport: "SWIMMING" }, // no zones configured
	];

	it("shapeFitnessAge: rounded ages, components with targets, stale flag only when true", () => {
		expect(shapeFitnessAge(fitnessAgePayload)).toEqual({
			fitnessAge: 28.5,
			chronologicalAge: 32,
			achievableFitnessAge: 25,
			previousFitnessAge: 29.1,
			lastUpdated: "2026-11-20T08:00:00.0",
			components: {
				vigorousDaysAvg: { value: 2.1, target: 4, improvementNeeded: 1.9, fitnessAgeIfReached: 26.5, priority: 1, lastMeasured: "2026-11-24" },
				rhr: { value: 55, target: 52, improvementNeeded: 3, fitnessAgeIfReached: 27.9, priority: 2 },
				bmi: { value: 22.8, target: 22.8, improvementNeeded: 0, priority: 3, stale: true },
			},
		});
		expect(shapeFitnessAge(fitnessAgePayload[0])).toEqual(shapeFitnessAge(fitnessAgePayload)); // a bare object works too
		expect(shapeFitnessAge([{ invalidReason: "USER_EMPTY_AGE" }])).toEqual({ notAvailableBecause: "USER_EMPTY_AGE" });
		expect(shapeFitnessAge([])).toBeUndefined();
		expect(shapeFitnessAge(null)).toBeUndefined();
	});

	it("shapeHeartRateZones: bpm ranges per sport, zone 5 up to max, sports without zones skipped", () => {
		const zones = shapeHeartRateZones(zonesPayload)!;
		expect(zones).toHaveLength(2);
		expect(zones[0]).toEqual({
			sport: "DEFAULT",
			trainingMethod: "HR_MAX",
			maxHeartRate: 190,
			restingHeartRate: 55,
			zones: [
				{ zone: 1, fromBpm: 95, toBpm: 113 },
				{ zone: 2, fromBpm: 114, toBpm: 132 },
				{ zone: 3, fromBpm: 133, toBpm: 151 },
				{ zone: 4, fromBpm: 152, toBpm: 170 },
				{ zone: 5, fromBpm: 171, toBpm: 190 },
			],
		});
		expect(zones[1]).toMatchObject({ sport: "CYCLING", lactateThresholdHeartRate: 165 });
		expect(shapeHeartRateZones([])).toBeUndefined();
		expect(shapeHeartRateZones([{ sport: "RUNNING" }])).toBeUndefined();
	});

	it("fetchFitnessProfile: both parts in parallel, full-history Fitness Age, one token request", async () => {
		const g = fakeGarmin((path) => (path.startsWith("/fitnessage-service") ? fitnessAgePayload : zonesPayload));
		const r = (await fetchFitnessProfile(g.client, "2026-11-25")) as Record<string, any>;
		expect(g.tokenCalls).toBe(1);
		expect(g.calls).toEqual(
			expect.arrayContaining([
				{ path: "/fitnessage-service/fitnessage/v2/2026-11-25", query: { fullHistoryScan: true } },
				{ path: "/biometric-service/heartRateZones/v2", query: {} },
			]),
		);
		expect(r.fitnessAge.fitnessAge).toBe(28.5);
		expect(r.heartRateZones).toHaveLength(2);
		expect(r).not.toHaveProperty("errors");
	});

	it("fetchFitnessProfile: one failing part is reported; missing data is listed", async () => {
		const g = fakeGarmin((path) => {
			if (path.startsWith("/fitnessage-service")) throw new GarminApiError("Rate limited by Garmin - wait a bit and try again.", 429, path);
			return [];
		});
		const r = (await fetchFitnessProfile(g.client, "2026-11-25")) as Record<string, any>;
		expect(r.errors.fitnessAge).toMatch(/Rate limited/);
		expect(r.noData).toEqual(["heartRateZones"]);
	});
});
