import { afterEach, describe, expect, it, vi } from "vitest";
import {
	addDays,
	compact,
	daysInclusive,
	formatTimestamp,
	hms,
	hours,
	isValidDate,
	resolveRange,
	round,
	shapeActivityDetails,
	summarizeActivity,
	summarizeBodyBattery,
	summarizeDailySummary,
	summarizeDailySummaryV2,
	summarizeHrv,
	summarizeSleep,
	todayIn,
} from "../src/format";

describe("dates", () => {
	afterEach(() => vi.useRealTimers());

	it("todayIn: the calendar date in a timezone, UTC for bad input", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-25T21:30:00Z"));
		expect(todayIn("UTC")).toBe("2026-11-25");
		expect(todayIn("Indian/Mauritius")).toBe("2026-11-26"); // already past midnight at +4
		expect(todayIn("America/Los_Angeles")).toBe("2026-11-25");
		expect(todayIn(undefined)).toBe("2026-11-25");
		expect(todayIn("Not/AZone")).toBe("2026-11-25");
	});

	it("addDays / daysInclusive across months, years and leap days", () => {
		expect(addDays("2025-01-31", 1)).toBe("2025-02-01");
		expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
		expect(addDays("2025-01-01", -1)).toBe("2024-12-31");
		expect(daysInclusive("2025-01-01", "2025-01-01")).toBe(1);
		expect(daysInclusive("2025-01-01", "2025-12-31")).toBe(365);
		expect(daysInclusive("2024-01-01", "2024-12-31")).toBe(366);
	});

	it("isValidDate: real calendar dates only", () => {
		expect(isValidDate("2024-02-29")).toBe(true);
		for (const bad of ["2025-02-29", "2025-13-01", "2025-1-01", "20250101", "", "2025-01-01T00:00"]) {
			expect(isValidDate(bad), bad).toBe(false);
		}
	});

	describe("resolveRange", () => {
		const opts = { today: "2025-03-10", defaultDays: 7, maxDays: 31 };

		it("defaults to the last N days ending today", () => {
			expect(resolveRange(undefined, undefined, opts)).toEqual({ startDate: "2025-03-04", endDate: "2025-03-10" });
		});

		it("one date means a single day", () => {
			expect(resolveRange("2025-03-01", undefined, opts)).toEqual({ startDate: "2025-03-01", endDate: "2025-03-01" });
			expect(resolveRange(undefined, "2025-03-02", opts)).toEqual({ startDate: "2025-03-02", endDate: "2025-03-02" });
		});

		it("accepts exactly maxDays and rejects more, with a readable error", () => {
			expect(resolveRange("2025-03-01", "2025-03-31", opts)).toEqual({ startDate: "2025-03-01", endDate: "2025-03-31" });
			expect(() => resolveRange("2025-03-01", "2025-04-01", opts)).toThrow(/32 days.*at most 31/);
		});

		it("rejects inverted and invalid dates", () => {
			expect(() => resolveRange("2025-03-05", "2025-03-01", opts)).toThrow(RangeError);
			expect(() => resolveRange("2025-02-30", "2025-03-01", opts)).toThrow(/startDate must be a valid date/);
			expect(() => resolveRange("2025-03-01", "tomorrow", opts)).toThrow(/endDate/);
		});
	});

	it("formatTimestamp: local epochs without Z, GMT epochs with Z, strings unchanged", () => {
		const ms = Date.UTC(2025, 2, 1, 7, 5, 9);
		expect(formatTimestamp(ms, "local")).toBe("2025-03-01T07:05:09");
		expect(formatTimestamp(ms, "gmt")).toBe("2025-03-01T07:05:09Z");
		expect(formatTimestamp("2025-03-01 07:05:09", "local")).toBe("2025-03-01 07:05:09");
		expect(formatTimestamp(null, "gmt")).toBeUndefined();
		expect(formatTimestamp("", "gmt")).toBeUndefined();
	});
});

describe("numbers and cleanup", () => {
	it("round / hours / hms", () => {
		expect(round(1.25, 1)).toBe(1.3);
		expect(round(1234.5678, 0)).toBe(1235);
		expect(round("1", 1)).toBeUndefined();
		expect(round(Number.NaN)).toBeUndefined();
		expect(hours(5400)).toBe(1.5);
		expect(hms(59)).toBe("0:59");
		expect(hms(3723)).toBe("1:02:03");
		expect(hms(-1)).toBeUndefined();
	});

	it("compact drops null/undefined/empty values recursively but keeps 0 and false", () => {
		expect(
			compact({ a: 0, b: false, c: null, d: undefined, e: "", f: [], g: {}, h: { i: null, j: [null, 1, { k: "" }] }, l: "x" }),
		).toEqual({ a: 0, b: false, h: { j: [1] }, l: "x" });
	});
});

describe("activities", () => {
	it("summarizeActivity: concise summary with units-friendly extras", () => {
		expect(
			summarizeActivity({
				activityId: 42,
				activityName: "Morning Run",
				activityType: { typeKey: "running" },
				eventType: { typeKey: "race" },
				startTimeLocal: "2025-03-01 07:00:00",
				locationName: "Lisbon",
				distance: 10012.34,
				duration: 3000.4,
				elevationGain: 55.55,
				averageHR: 151.6,
				maxHR: 178,
				averageSpeed: 3.337,
				calories: 650.2,
				avgPower: 250.4,
				someOtherField: "ignored",
			}),
		).toEqual({
			activityId: 42,
			activityName: "Morning Run",
			activityType: "running",
			eventType: "race",
			startTimeLocal: "2025-03-01 07:00:00",
			locationName: "Lisbon",
			distance: 10012.3,
			duration: 3000,
			durationFormatted: "50:00",
			elevationGain: 55.6,
			averageHR: 152,
			maxHR: 178,
			averageSpeed: 3.337,
			averageSpeedKmh: 12,
			calories: 650,
			averagePower: 250,
		});
	});

	it("shapeActivityDetails: curated fields and splits; raw=true returns the payload", () => {
		const payload = {
			activityId: 7,
			activityName: "Ride",
			activityTypeDTO: { typeKey: "cycling" },
			eventTypeDTO: { typeKey: "training" },
			summaryDTO: { distance: 40000, duration: 5400, movingDuration: 5000, averageSpeed: 7.5, averageHR: 140, notAField: 1 },
			splitSummaries: [{ splitType: "INTERVAL_ACTIVE", noOfSplits: 1, distance: 40000.04, duration: 5400.2 }],
			unrelated: { deep: true },
		};
		const d = shapeActivityDetails(payload, false) as Record<string, any>;
		expect(d).toMatchObject({ activityId: 7, activityType: "cycling", eventType: "training" });
		expect(d.summary).toMatchObject({ distance: 40000, durationFormatted: "1:30:00", averageSpeedKmh: 27, averageHR: 140 });
		expect(d.summary).not.toHaveProperty("notAField");
		expect(d.splitSummaries).toEqual([{ splitType: "INTERVAL_ACTIVE", noOfSplits: 1, distance: 40000, duration: 5400 }]);
		expect(d).not.toHaveProperty("unrelated");
		expect(shapeActivityDetails(payload, true)).toHaveProperty("unrelated");
	});
});

describe("daily summaries", () => {
	it("v1 (single day)", () => {
		const d = summarizeDailySummary({
			calendarDate: "2025-03-01",
			totalSteps: 9000,
			dailyStepGoal: 8000,
			restingHeartRate: 55,
			averageStressLevel: 30,
			bodyBatteryHighestValue: 90,
			hydrationValueInML: 1500.4,
		}) as Record<string, any>;
		expect(d).toMatchObject({
			calendarDate: "2025-03-01",
			steps: { total: 9000, goal: 8000 },
			heartRate: { resting: 55 },
			stress: { average: 30 },
			bodyBattery: { highest: 90 },
			hydration: { valueMl: 1500 },
		});
		expect(d).not.toHaveProperty("spo2");
	});

	it("v2 (range rows) maps to the same shape, durations from milliseconds", () => {
		const d = summarizeDailySummaryV2({
			calendarDate: "2025-03-01",
			movement: { steps: { value: 9000, goal: 8000, distanceInMeters: 7200.4 } },
			heartRate: { restingValue: 55 },
			stress: { avgLevel: 30, highStressDurationInMillis: 600_000 },
			bodyBattery: { maxValue: 90, endOfDayValue: 40 },
		}) as Record<string, any>;
		expect(d).toMatchObject({
			steps: { total: 9000, goal: 8000 },
			distanceMeters: 7200,
			heartRate: { resting: 55 },
			stress: { average: 30, highSeconds: 600 },
			bodyBattery: { highest: 90, endOfDay: 40 },
		});
	});
});

describe("sleep and HRV", () => {
	it("summarizeSleep accepts the DTO or the { dailySleepDTO } wrapper", () => {
		const dto = {
			calendarDate: "2025-03-01",
			sleepTimeSeconds: 27000,
			deepSleepSeconds: 4500,
			sleepScores: { overall: { value: 84, qualifierKey: "GOOD" }, remPercentage: { value: 18, qualifierKey: "FAIR" } },
			avgHeartRate: 61.4,
		};
		const direct = summarizeSleep(dto) as Record<string, any>;
		expect(direct).toMatchObject({
			calendarDate: "2025-03-01",
			totalSleepSeconds: 27000,
			totalSleepHours: 7.5,
			stages: { deepSeconds: 4500 },
			sleepScore: 84,
			sleepScoreQualifier: "GOOD",
			sleepScores: { remPercentage: { value: 18, qualifier: "FAIR" } },
			avgHeartRate: 61,
		});
		expect(summarizeSleep({ dailySleepDTO: dto })).toEqual(direct);
	});

	it("summarizeHrv: one row per day", () => {
		expect(
			summarizeHrv({
				hrvSummaries: [
					{ calendarDate: "2025-03-01", lastNightAvg: 44, status: "BALANCED", baseline: { balancedLow: 40, markerValue: 0.456 } },
				],
			}),
		).toEqual([{ calendarDate: "2025-03-01", lastNightAvg: 44, status: "BALANCED", baseline: { balancedLow: 40, markerValue: 0.46 } }]);
		expect(summarizeHrv({})).toEqual([]);
	});
});

describe("Body Battery", () => {
	const report = {
		date: "2025-03-01",
		charged: 60,
		drained: 55,
		bodyBatteryValueDescriptorDTOList: [
			{ bodyBatteryValueDescriptorIndex: 0, bodyBatteryValueDescriptorKey: "timestamp" },
			{ bodyBatteryValueDescriptorIndex: 1, bodyBatteryValueDescriptorKey: "bodyBatteryLevel" },
		],
		bodyBatteryValuesArray: [
			[Date.UTC(2025, 2, 1, 0, 0), 30],
			[Date.UTC(2025, 2, 1, 6, 0), 90],
			[Date.UTC(2025, 2, 1, 12, 0), null],
			[Date.UTC(2025, 2, 1, 22, 0), 25],
		],
		bodyBatteryActivityEvent: [{ eventType: "SLEEP", durationInMilliseconds: 27_000_000, bodyBatteryImpact: 60, shortFeedback: "GOOD" }],
	};

	it("levels follow the descriptor columns; the timeline only on request", () => {
		const r = summarizeBodyBattery(report, false) as Record<string, any>;
		expect(r).toMatchObject({ date: "2025-03-01", charged: 60, drained: 55, startLevel: 30, endLevel: 25, highest: 90, lowest: 25 });
		expect(r.events).toEqual([{ eventType: "SLEEP", durationMinutes: 450, impact: 60, feedback: "GOOD" }]);
		expect(r).not.toHaveProperty("timeline");

		const withTimeline = summarizeBodyBattery(report, true) as Record<string, any>;
		expect(withTimeline.timeline).toEqual([
			{ time: "2025-03-01T00:00:00Z", level: 30 },
			{ time: "2025-03-01T06:00:00Z", level: 90 },
			{ time: "2025-03-01T22:00:00Z", level: 25 },
		]);
	});
});
