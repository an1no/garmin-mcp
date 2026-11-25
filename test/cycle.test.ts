import { describe, expect, it } from "vitest";
import { cycleTrackingEnabled, fetchCycleDay, shapeCycleDay } from "../src/cycle";
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
