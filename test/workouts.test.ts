import { describe, expect, it } from "vitest";
import { GarminApiError } from "../src/garmin";
import { distance, fetchActivityWorkouts, heartRate, power, shapeWorkout, speed, stepEnd, stepTarget } from "../src/workouts";
import { fakeGarmin } from "./helpers";

describe("Garmin's workout value encoding", () => {
	it("heart rate: above 100 is bpm + 100, otherwise % of max", () => {
		expect(heartRate(250)).toBe("150 bpm");
		expect(heartRate(85)).toBe("85% of max HR");
	});

	it("power: above 1000 is watts + 1000, otherwise % of FTP", () => {
		expect(power(1250)).toBe("250 W");
		expect(power(95)).toBe("95% of FTP");
	});

	it("speed: pace for foot sports, km/h otherwise; distance in m or km", () => {
		expect(speed(1000 / 300, "RUNNING")).toBe("5:00 /km");
		expect(speed(10, "CYCLING")).toBe("36 km/h");
		expect(speed(10, undefined)).toBe("36 km/h");
		expect(distance(400)).toBe("400 m");
		expect(distance(10000)).toBe("10 km");
	});
});

describe("steps", () => {
	it("how each kind of step ends", () => {
		expect(stepEnd({ durationType: "TIME", durationValue: 300 })).toBe("5:00");
		expect(stepEnd({ durationType: "DISTANCE", durationValue: 1600 })).toBe("1.6 km");
		expect(stepEnd({ durationType: "REPS", durationValue: 12 })).toBe("12 reps");
		expect(stepEnd({ durationType: "HR_LESS_THAN", durationValue: 230 })).toBe("until heart rate < 130 bpm");
		expect(stepEnd({ durationType: "HR_GREATER_THAN", durationValue: 80 })).toBe("until heart rate > 80% of max HR");
		expect(stepEnd({ durationType: "POWER_GREATER_THAN", durationValue: 1300 })).toBe("until power > 300 W");
		expect(stepEnd({ durationType: "OPEN" })).toBe("open (until lap button)");
		expect(stepEnd({ durationType: "REPEAT_UNTIL_STEPS_CMPLT", durationValue: 1, targetValue: 4 })).toBe(
			"repeat from step 1, 4 times in total",
		);
		expect(stepEnd({ durationType: "REPEAT_UNTIL_TIME", durationValue: 2, targetValue: 1200 })).toBe("repeat from step 2 until 20:00");
		expect(stepEnd({})).toBeUndefined();
	});

	it("targets: zones, custom ranges in real units, nothing for open steps or repeats", () => {
		expect(stepTarget({ targetType: "HEART_RATE", targetValue: 2 }, "RUNNING")).toBe("heart rate zone 2");
		expect(stepTarget({ targetType: "HEART_RATE", targetValue: 0, targetValueLow: 250, targetValueHigh: 270 }, "RUNNING")).toBe(
			"heart rate 150–170 bpm",
		);
		expect(stepTarget({ targetType: "HEART_RATE", targetValue: 0, targetValueLow: 70, targetValueHigh: 80 }, "RUNNING")).toBe(
			"heart rate 70% of max HR–80% of max HR",
		);
		// Higher speed = lower pace, so the range is written faster pace first, as runners do.
		expect(stepTarget({ targetType: "SPEED", targetValue: 0, targetValueLow: 1000 / 330, targetValueHigh: 1000 / 300 }, "RUNNING")).toBe(
			"pace 5:00 /km–5:30 /km",
		);
		expect(stepTarget({ targetType: "SPEED", targetValueLow: 8, targetValueHigh: 9 }, "CYCLING")).toBe("speed 28.8 km/h–32.4 km/h");
		expect(stepTarget({ targetType: "POWER", targetValueLow: 1250, targetValueHigh: 1270 }, "CYCLING")).toBe("power 250–270 W");
		expect(stepTarget({ targetType: "CADENCE", targetValueLow: 85, targetValueHigh: 95 }, "CYCLING")).toBe("cadence 85–95 rpm");
		expect(stepTarget({ targetType: "CADENCE", targetValueLow: 170, targetValueHigh: 180 }, "RUNNING")).toBe("cadence 170–180 spm");
		expect(stepTarget({ targetType: "OPEN" }, "RUNNING")).toBeUndefined();
		expect(stepTarget({ targetType: "HEART_RATE", durationType: "REPEAT_UNTIL_STEPS_CMPLT", targetValue: 4 }, "RUNNING")).toBeUndefined();
	});
});

const intervalWorkout = {
	workoutName: "4x1k intervals",
	sport: "RUNNING",
	workoutPhrase: "VO2MAX",
	timeCreated: "2026-11-20T07:00:00.0",
	steps: [
		{ stepIndex: 2, intensity: "RECOVERY", durationType: "TIME", durationValue: 120, targetType: "OPEN" },
		{ stepIndex: 0, name: "Warm up", intensity: "WARMUP", durationType: "TIME", durationValue: 600, targetType: "HEART_RATE", targetValue: 2 },
		{
			stepIndex: 1,
			name: "",
			intensity: "ACTIVE",
			durationType: "DISTANCE",
			durationValue: 1000,
			targetType: "SPEED",
			targetValue: 0,
			targetValueLow: 1000 / 250,
			targetValueHigh: 1000 / 240,
			notes: "Strong but controlled.",
		},
		{ stepIndex: 3, durationType: "REPEAT_UNTIL_STEPS_CMPLT", durationValue: 1, targetValue: 4 },
		{ stepIndex: 4, intensity: "COOLDOWN", durationType: "OPEN", equipmentType: "NONE" },
	],
};

describe("shapeWorkout and fetchActivityWorkouts", () => {
	it("readable steps in step order; blank names and NONE equipment dropped", () => {
		expect(shapeWorkout(intervalWorkout)).toEqual({
			name: "4x1k intervals",
			sport: "RUNNING",
			focus: "VO2MAX",
			created: "2026-11-20T07:00:00.0",
			steps: [
				{ step: 0, name: "Warm up", intensity: "warmup", ends: "10:00", target: "heart rate zone 2" },
				{ step: 1, intensity: "active", ends: "1 km", target: "pace 4:00 /km–4:10 /km", notes: "Strong but controlled." },
				{ step: 2, intensity: "recovery", ends: "2:00" },
				{ step: 3, ends: "repeat from step 1, 4 times in total" },
				{ step: 4, intensity: "cooldown", ends: "open (until lap button)" },
			],
		});
	});

	it("strength steps keep the exercise and weight", () => {
		const w = shapeWorkout({
			sport: "STRENGTH_TRAINING",
			steps: [{ stepIndex: 0, durationType: "REPS", durationValue: 8, exerciseCategory: "BENCH_PRESS", exerciseName: "BARBELL_BENCH_PRESS", exerciseWeightValue: 60 }],
		}) as Record<string, any>;
		expect(w.steps[0]).toEqual({ step: 0, ends: "8 reps", exercise: { category: "BENCH_PRESS", name: "BARBELL_BENCH_PRESS", weightKg: 60 } });
	});

	it("fetches /activity/{id}/workouts; 404 means no planned workout; other errors are thrown", async () => {
		const g = fakeGarmin(() => [intervalWorkout]);
		expect(await fetchActivityWorkouts(g.client, "123")).toHaveLength(1);
		expect(g.calls[0]!.path).toBe("/activity-service/activity/123/workouts");

		const none = fakeGarmin((path) => {
			throw new GarminApiError("Not found", 404, path);
		});
		expect(await fetchActivityWorkouts(none.client, "123")).toEqual([]);

		const failing = fakeGarmin((path) => {
			throw new GarminApiError("Rate limited by Garmin - wait a bit and try again.", 429, path);
		});
		await expect(fetchActivityWorkouts(failing.client, "123")).rejects.toThrow(/Rate limited/);
	});
});
