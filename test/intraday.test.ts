import { describe, expect, it } from "vitest";
import { GarminApiError } from "../src/garmin";
import {
	bucketSeries,
	clock,
	fetchDayDetails,
	localWallClock,
	parseLocalIso,
	shapeHeartRate,
	shapeHrvNight,
	shapeSpo2,
} from "../src/intraday";
import { fakeGarmin, gmt } from "./helpers";

describe("time helpers", () => {
	it("localWallClock + clock: GMT epoch to local time, with and without DST", () => {
		expect(clock(localWallClock(gmt("2025-03-01T20:30:00"), "Indian/Mauritius"))).toBe("00:30");
		expect(new Date(localWallClock(gmt("2025-03-01T20:30:00"), "Indian/Mauritius")).toISOString().slice(0, 10)).toBe("2025-03-02");
		expect(clock(localWallClock(gmt("2025-07-01T12:00:00"), "America/New_York"))).toBe("08:00"); // EDT
		expect(clock(localWallClock(gmt("2025-01-15T12:00:00"), "America/New_York"))).toBe("07:00"); // EST
		expect(clock(localWallClock(gmt("2025-01-15T00:05:00"), "UTC"))).toBe("00:05");
	});

	it("parseLocalIso: Garmin local strings without an offset", () => {
		expect(clock(parseLocalIso("2025-03-01T02:15:00.0")!)).toBe("02:15");
		expect(clock(parseLocalIso("2025-03-01T23:59:59")!)).toBe("23:59");
		expect(parseLocalIso("nope")).toBeUndefined();
		expect(parseLocalIso(123)).toBeUndefined();
	});

	it("bucketSeries: averages per interval, single readings as value, chronological", () => {
		const base = Date.UTC(2025, 2, 1, 0, 0);
		const points = [
			{ t: base + 16 * 60_000, v: 70 },
			{ t: base, v: 60 },
			{ t: base + 2 * 60_000, v: 64 },
			{ t: base + 4 * 60_000, v: 62 },
		];
		expect(bucketSeries(points, 15)).toEqual([
			{ time: "00:00", avg: 62, min: 60, max: 64 },
			{ time: "00:15", value: 70 },
		]);
		expect(bucketSeries([], 15)).toEqual([]);
	});
});

describe("shapers", () => {
	it("shapeHeartRate: local times, series, lowest/highest, abnormal readings, gaps skipped", () => {
		const start = gmt("2025-03-01T20:00:00"); // midnight at +4
		const values: (number | null)[][] = [];
		for (let i = 0; i < 30; i++) values.push([start + i * 120_000, i === 5 ? null : 60 + (i % 10)]);
		values.push([start + 31 * 120_000, 0]);
		const hr = shapeHeartRate(
			{
				restingHeartRate: 55,
				lastSevenDaysAvgRestingHeartRate: 57,
				abnormalHrThresholdValue: 120,
				lowAbnormalHrThresholdValue: 40,
				heartRateValueDescriptors: [
					{ index: 1, key: "heartrate" },
					{ index: 0, key: "timestamp" },
				],
				heartRateValues: values,
				abnormalHRValuesArray: [[start + 10 * 120_000, 125]],
			},
			"Indian/Mauritius",
			15,
		) as Record<string, any>;
		expect(hr).toMatchObject({
			resting: 55,
			lastSevenDaysAvgResting: 57,
			readings: 29,
			min: { bpm: 60, time: "00:00" },
			max: { bpm: 69, time: "00:18" },
			abnormalThresholds: { high: 120, low: 40 },
			abnormalReadings: [{ time: "00:20", bpm: 125 }],
		});
		expect(hr.series.map((r: { time: string }) => r.time)).toEqual(["00:00", "00:15", "00:30", "00:45"]);
	});

	it("shapeHeartRate: summary-only payload, and nothing at all", () => {
		expect(shapeHeartRate({ restingHeartRate: 52, minHeartRate: 48, maxHeartRate: 140 }, "UTC", 15)).toEqual({
			resting: 52,
			min: 48,
			max: 140,
			readings: 0,
		});
		expect(shapeHeartRate({}, "UTC", 15)).toBeUndefined();
	});

	it("shapeHeartRate: caps the list of abnormal readings", () => {
		const t = gmt("2025-03-01T10:00:00");
		const abnormal = Array.from({ length: 25 }, (_, i) => [t + i * 60_000, 130]);
		const hr = shapeHeartRate({ restingHeartRate: 50, abnormalHRValuesArray: abnormal }, "UTC", 15) as Record<string, any>;
		expect(hr.abnormalReadings).toHaveLength(20);
		expect(hr.abnormalReadingsTotal).toBe(25);
	});

	it("shapeHrvNight: summary, sleep window, series across midnight", () => {
		const t0 = Date.UTC(2025, 2, 1, 23, 45);
		const readings = Array.from({ length: 9 }, (_, i) => ({
			hrvValue: 40 + i,
			readingTimeLocal: `${new Date(t0 + i * 5 * 60_000).toISOString().slice(0, 19)}.0`,
			readingTimeGMT: "ignored",
		}));
		const h = shapeHrvNight(
			{
				hrvSummary: {
					lastNightAvg: 44,
					lastNight5MinHigh: 60,
					weeklyAvg: 46,
					status: "BALANCED",
					baseline: { balancedLow: 40, balancedUpper: 52, lowUpper: 36 },
				},
				hrvReadings: readings,
				sleepStartTimestampLocal: "2025-03-01T23:40:00.0",
				sleepEndTimestampLocal: "2025-03-02T07:10:00.0",
			},
			15,
		) as Record<string, any>;
		expect(h).toMatchObject({ lastNightAvg: 44, status: "BALANCED", sleepStart: "23:40", sleepEnd: "07:10", readings: 9 });
		expect(h.series.map((r: { time: string }) => r.time)).toEqual(["23:45", "00:00", "00:15"]);
		expect(h.series[0]).toEqual({ time: "23:45", avg: 41, min: 40, max: 42 });

		const five = shapeHrvNight({ hrvReadings: readings }, 5) as Record<string, any>;
		expect(five.series).toHaveLength(9);
		expect(five.series[0]).toEqual({ time: "23:45", value: 40 });
		expect(shapeHrvNight({}, 15)).toBeUndefined();
	});

	it("shapeSpo2: summary and hourly averages in local time, empty rows skipped", () => {
		const s = shapeSpo2(
			{
				averageSpO2: 95.6,
				lowestSpO2: 88,
				latestSpO2: 96,
				latestSpO2TimestampLocal: "2025-03-02T07:05:00.0",
				avgSleepSpO2: 94.2,
				lastSevenDaysAvgSpO2: 95.1,
				spO2HourlyAveragesDescriptorList: [
					{ spo2ValueDescIndex: 0, spo2ValueDescKey: "timestamp" },
					{ spo2ValueDescIndex: 1, spo2ValueDescKey: "spo2Level" },
					{ spo2ValueDescIndex: 2, spo2ValueDescKey: "monitoringEnvironmentLevel" },
				],
				spO2HourlyAverages: [
					[gmt("2025-03-01T20:00:00"), 95, 1],
					[gmt("2025-03-01T21:00:00"), 93.6, 1],
					[gmt("2025-03-01T22:00:00"), null, 1],
				],
			},
			"Indian/Mauritius",
		);
		expect(s).toEqual({
			average: 96,
			lowest: 88,
			latest: 96,
			latestAt: "07:05",
			averageDuringSleep: 94,
			lastSevenDaysAverage: 95,
			hourly: [
				{ time: "00:00", percent: 95 },
				{ time: "01:00", percent: 94 },
			],
		});
		expect(shapeSpo2({}, "UTC")).toBeUndefined();
	});
});

describe("fetchDayDetails", () => {
	const hrPayload = {
		restingHeartRate: 55,
		heartRateValueDescriptors: [
			{ index: 0, key: "timestamp" },
			{ index: 1, key: "heartrate" },
		],
		heartRateValues: [[gmt("2025-03-02T08:00:00"), 70]],
	};

	it("calls the right endpoints with one token request; reports failures and missing data", async () => {
		const g = fakeGarmin((path, query) => {
			if (path === "/wellness-service/wellness/dailyHeartRate") {
				expect(query).toEqual({ date: "2025-03-02" });
				return hrPayload;
			}
			if (path === "/hrv-service/hrv/2025-03-02") throw new GarminApiError("Rate limited by Garmin - wait a bit and try again.", 429, path);
			if (path === "/wellness-service/wellness/daily/spo2acclimation/2025-03-02") return {};
			throw new Error(`unexpected ${path}`);
		});
		const r = (await fetchDayDetails(g.client, {
			date: "2025-03-02",
			timeZone: "Indian/Mauritius",
			intervalMinutes: 15,
			parts: ["heartRate", "hrv", "spo2"],
		})) as Record<string, any>;
		expect(g.tokenCalls).toBe(1);
		expect(g.calls).toHaveLength(3);
		expect(r.heartRate.series[0].time).toBe("12:00");
		expect(r.errors.hrv).toMatch(/Rate limited/);
		expect(r.noData).toEqual(["spo2"]);
		expect(r.timeZone).toBe("Indian/Mauritius");
		expect(r.spo2).toBeUndefined();
	});

	it("fetches only the requested parts", async () => {
		const g = fakeGarmin(() => hrPayload);
		const r = (await fetchDayDetails(g.client, { date: "2025-03-02", timeZone: "UTC", intervalMinutes: 30, parts: ["heartRate"] })) as Record<string, any>;
		expect(g.calls).toHaveLength(1);
		expect(r).not.toHaveProperty("hrv");
		expect(r).not.toHaveProperty("errors");
		expect(r).not.toHaveProperty("noData");
	});

	it("throws when every part fails", async () => {
		const failing = fakeGarmin(() => {
			throw new GarminApiError("Garmin rejected the Personal API key.", 401, "/x");
		});
		await expect(
			fetchDayDetails(failing.client, { date: "2025-03-02", timeZone: "UTC", intervalMinutes: 15, parts: ["hrv", "spo2"] }),
		).rejects.toThrow(/rejected/);
	});
});
