import { describe, expect, it } from "vitest";
import { cycleTrackingEnabled, fetchCycle, fetchCycleDay, fetchCycleHistory, shapeCycleDay } from "../src/cycle";
import { GarminApiError } from "../src/garmin";
import { fakeGarmin } from "./helpers";

// Synthetic day view shaped like /periodichealth-service/menstrualcycle/dayview/{date}.
const dayView = {
	daySummary: {
		dayInCycle: 9,
		startDate: { date: "2026-11-17T00:00:00.0", localDate: "2026-11-17" },
		predictedCycleLength: 29,
		periodLength: 5,
		fertileWindowStart: 10,
		lengthOfFertileWindow: 6,
		lutealPhaseStart: 16,
		predictedOvulationDate: { localDate: "2026-11-30" },
		currentPhase: 2,
		lengthOfCurrentPhase: 4,
		daysUntilNextPhase: 1,
		predictedCycle: false,
		pregnancyCycle: false,
		cycleType: "REGULAR",
		educationContentMod: 3,
		analysis: { perimenopauseDetected: false },
	},
	dayLog: {
		calendarDate: "2026-11-25",
		flow: "LIGHT",
		symptoms: ["CRAMPS", "HEADACHE"],
		moods: ["CALM"],
		ovulationDay: false,
		sexualActivity: "PRIVATE-VALUE",
		sexDrive: "PRIVATE-VALUE",
		discharge: ["PRIVATE-VALUE"],
		notes: "PRIVATE-NOTE",
		babyMovements: [],
	},
	weightGoals: null,
};

describe("cycleTrackingEnabled", () => {
	it("is on only for explicit values", () => {
		for (const on of ["on", "ON", " true ", "1", "yes"]) expect(cycleTrackingEnabled(on), on).toBe(true);
		for (const off of ["off", "", "false", "0", "no", undefined, "auto"]) expect(cycleTrackingEnabled(off), String(off)).toBe(false);
	});
});

describe("shapeCycleDay", () => {
	it("day numbers, dates and the day's flow/symptoms/moods", () => {
		expect(shapeCycleDay(dayView, "2026-11-25")).toEqual({
			date: "2026-11-25",
			note: expect.stringContaining("Day numbers count from day 1"),
			cycle: {
				dayInCycle: 9,
				cycleStartDate: "2026-11-17",
				predictedCycleLength: 29,
				periodDays: { fromDay: 1, toDay: 5 },
				fertileWindow: { fromDay: 10, toDay: 15 },
				lutealPhaseStartsOnDay: 16,
				predictedOvulationDate: "2026-11-30",
				currentPhaseId: 2,
				lengthOfCurrentPhase: 4,
				daysUntilNextPhase: 1,
				cycleType: "REGULAR",
			},
			dayLog: { flow: "LIGHT", symptoms: ["CRAMPS", "HEADACHE"], moods: ["CALM"] },
		});
	});

	it("never passes on sexual activity, sex drive, discharge, notes or the cycle analysis", () => {
		const text = JSON.stringify(shapeCycleDay(dayView, "2026-11-25"));
		for (const word of ["PRIVATE", "sexual", "sexDrive", "discharge", "notes", "perimenopause", "analysis"]) {
			expect(text).not.toContain(word);
		}
	});

	it("pregnancy tracking shows the week and due date", () => {
		const shaped = shapeCycleDay(
			{ daySummary: { pregnancyCycle: true, numberOfWeek: 20, dueDate: { localDate: "2027-04-01" } } },
			"2026-11-25",
		) as Record<string, any>;
		expect(shaped.pregnancy).toEqual({ week: 20, dueDate: "2027-04-01" });
	});

	it("no data gives a message", () => {
		for (const raw of [null, {}, { daySummary: {}, dayLog: { symptoms: [] } }]) {
			expect(shapeCycleDay(raw, "2026-11-25")).toEqual({
				date: "2026-11-25",
				message: expect.stringMatching(/No cycle data/),
			});
		}
	});
});

describe("fetchCycleDay", () => {
	it("asks for the day view with today as the reference, without baby movements or analysis", async () => {
		const g = fakeGarmin(() => dayView);
		await fetchCycleDay(g.client, "2026-11-20", "2026-11-25");
		expect(g.calls).toEqual([
			{
				path: "/periodichealth-service/menstrualcycle/dayview/2026-11-20",
				query: { todayDate: "2026-11-25", skipbm: true, includeAnalysis: false },
			},
		]);
	});

	it("404 means no cycle data; other errors are thrown", async () => {
		const none = fakeGarmin((path) => {
			throw new GarminApiError("Not found", 404, path);
		});
		expect(await fetchCycleDay(none.client, "2026-11-25", "2026-11-25")).toMatchObject({ message: expect.stringMatching(/No cycle data/) });
		const failing = fakeGarmin((path) => {
			throw new GarminApiError("Rate limited", 429, path);
		});
		await expect(fetchCycleDay(failing.client, "2026-11-25", "2026-11-25")).rejects.toThrow(/Rate limited/);
	});
});

// Synthetic cycle summaries, keyed by the date asked for (the day before the next cycle's start).
const SUMMARY = "/periodichealth-service/menstrualcycle/summary/";
const pastCycles: Record<string, unknown> = {
	"2026-11-16": { startDate: { date: "2026-10-19T00:00:00.0", localDate: "2026-10-19" }, periodLength: 5, cycleType: "REGULAR" },
	"2026-10-18": { startDate: { localDate: "2026-09-18" }, periodLength: 4 },
	"2026-09-17": { daySummary: { startDate: { localDate: "2026-08-22" }, periodLength: 6, predictedCycle: true } },
};
const historyGarmin = (extra: Record<string, unknown> = {}) =>
	fakeGarmin((path) => {
		const day = path.split("/").pop()!;
		const known = { ...pastCycles, ...extra };
		if (path.startsWith(SUMMARY) && day in known) return known[day];
		if (path.startsWith("/periodichealth-service/menstrualcycle/dayview/")) return dayView;
		throw new GarminApiError("Not found", 404, path);
	});

describe("fetchCycleHistory", () => {
	it("walks back one cycle at a time, newest first, averaging the logged cycles", async () => {
		const g = historyGarmin();
		const { history, error } = await fetchCycleHistory(g.client, "2026-11-17", 6);
		expect(error).toBeUndefined();
		expect(g.calls.map((c) => c.path)).toEqual([`${SUMMARY}2026-11-16`, `${SUMMARY}2026-10-18`, `${SUMMARY}2026-09-17`, `${SUMMARY}2026-08-21`]);
		expect(history).toEqual({
			note: expect.stringContaining("newest first"),
			cyclesFound: 3,
			averageCycleLengthDays: 30,
			shortestCycleDays: 29,
			longestCycleDays: 31,
			averagePeriodDays: 4.5,
			cycles: [
				{ startDate: "2026-10-19", endDate: "2026-11-16", lengthDays: 29, periodDays: 5 },
				{ startDate: "2026-09-18", endDate: "2026-10-18", lengthDays: 31, periodDays: 4 },
				{ startDate: "2026-08-22", endDate: "2026-09-17", lengthDays: 27, periodDays: 6, isPrediction: true },
			],
		});
	});

	it("stops at the requested count", async () => {
		const g = historyGarmin();
		const { history } = await fetchCycleHistory(g.client, "2026-11-17", 1);
		expect(g.calls).toHaveLength(1);
		expect(history).toMatchObject({ cyclesFound: 1, averageCycleLengthDays: 29 });
	});

	it("stops when Garmin returns no start or a start that doesn't move back", async () => {
		const noStart = historyGarmin({ "2026-11-16": { periodLength: 5 } });
		expect((await fetchCycleHistory(noStart.client, "2026-11-17", 6)).history).toEqual({
			note: expect.any(String),
			cyclesFound: 0,
			message: "No earlier cycles found in Garmin Connect.",
		});
		const stuck = historyGarmin({ "2026-11-16": { startDate: { localDate: "2026-11-17" } } });
		expect((await fetchCycleHistory(stuck.client, "2026-11-17", 6)).history).toMatchObject({ cyclesFound: 0 });
		expect(stuck.calls).toHaveLength(1);
	});

	it("leaves pregnancies out of the averages", async () => {
		const g = historyGarmin({ "2026-10-18": { startDate: { localDate: "2026-01-10" }, pregnancyCycle: true } });
		const { history } = await fetchCycleHistory(g.client, "2026-11-17", 2);
		expect(history).toMatchObject({
			cyclesFound: 2,
			averageCycleLengthDays: 29,
			shortestCycleDays: 29,
			longestCycleDays: 29,
			cycles: [{ startDate: "2026-10-19" }, { startDate: "2026-01-10", lengthDays: 282, pregnancy: true }],
		});
	});

	it("a failed request keeps the cycles found so far and reports the error", async () => {
		const g = fakeGarmin((path) => {
			if (path === `${SUMMARY}2026-11-16`) return pastCycles["2026-11-16"];
			throw new GarminApiError("Rate limited", 429, path);
		});
		const { history, error } = await fetchCycleHistory(g.client, "2026-11-17", 6);
		expect(error).toMatch(/Rate limited/);
		expect(history).toMatchObject({ cyclesFound: 1, cycles: [{ startDate: "2026-10-19" }] });
		expect(history.message).toBeUndefined();
	});
});

describe("fetchCycle", () => {
	it("counts back from the start of the cycle on the date", async () => {
		const g = historyGarmin();
		const r = await fetchCycle(g.client, "2026-11-25", "2026-11-25", 2);
		expect(g.calls.map((c) => c.path)).toEqual([
			"/periodichealth-service/menstrualcycle/dayview/2026-11-25",
			`${SUMMARY}2026-11-16`,
			`${SUMMARY}2026-10-18`,
		]);
		expect(r).toMatchObject({ cycle: { cycleStartDate: "2026-11-17" }, history: { cyclesFound: 2 } });
		expect(r.historyError).toBeUndefined();
	});

	it("no history unless asked; a message when there is no cycle start; errors as historyError", async () => {
		const g = historyGarmin();
		expect(await fetchCycle(g.client, "2026-11-25", "2026-11-25")).not.toHaveProperty("history");
		expect(g.calls).toHaveLength(1);

		const empty = fakeGarmin(() => ({ daySummary: { dayInCycle: 3 } }));
		expect(await fetchCycle(empty.client, "2026-11-25", "2026-11-25", 3)).toMatchObject({
			history: { message: expect.stringMatching(/No current cycle start/) },
		});
		expect(empty.calls).toHaveLength(1);

		const failing = fakeGarmin((path) => {
			if (path.includes("/dayview/")) return dayView;
			throw new GarminApiError("Rate limited", 429, path);
		});
		const r = await fetchCycle(failing.client, "2026-11-25", "2026-11-25", 3);
		expect(r.historyError).toMatch(/Rate limited/);
		expect(r).toMatchObject({ cycle: { dayInCycle: 9 }, history: { cyclesFound: 0 } });
	});
});
