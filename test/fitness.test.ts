import { describe, expect, it } from "vitest";
import { GarminApiError } from "../src/garmin";
import {
	fetchVo2Max,
	fetchWeight,
	kg,
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
