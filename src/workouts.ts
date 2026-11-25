/**
 * The planned (structured) workout an activity followed, from
 * /activity-service/activity/{id}/workouts, turned into readable steps.
 *
 * Garmin uses the FIT workout encoding: heart rate values above 100 are bpm + 100 (otherwise
 * % of max HR), power values above 1000 are watts + 1000 (otherwise % of FTP), speed is m/s,
 * and a repeat step's durationValue is the step to jump back to while targetValue is the count.
 */
import { GarminApiError, type GarminClient } from "./garmin";
import { compact, hms, num, round } from "./format";

type Json = Record<string, unknown>;

function obj(value: unknown): Json {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function arr(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

const PACE_SPORTS = new Set(["RUNNING", "WALKING", "HIKING", "TRAIL_RUNNING"]);

export function heartRate(value: number): string {
	return value > 100 ? `${round(value - 100, 0)} bpm` : `${round(value, 0)}% of max HR`;
}

export function power(value: number): string {
	return value > 1000 ? `${round(value - 1000, 0)} W` : `${round(value, 0)}% of FTP`;
}

/** Pace (min:ss per km) for foot sports, km/h otherwise. */
export function speed(metersPerSecond: number, sport: string | undefined): string {
	if (sport && PACE_SPORTS.has(sport.toUpperCase()) && metersPerSecond > 0) {
		return `${hms(1000 / metersPerSecond)} /km`;
	}
	return `${round(metersPerSecond * 3.6, 1)} km/h`;
}

export function distance(meters: number): string {
	return meters >= 1000 ? `${round(meters / 1000, 2)} km` : `${round(meters, 0)} m`;
}

/** How a step ends ("5:00", "1 km", "until heart rate < 130 bpm", "repeat from step 1, 4 times in total"). */
export function stepEnd(step: Json): string | undefined {
	const type = typeof step.durationType === "string" ? step.durationType.toUpperCase() : undefined;
	const value = num(step.durationValue);
	const count = num(step.targetValue);
	switch (type) {
		case "TIME":
			return value !== undefined ? hms(value) : undefined;
		case "DISTANCE":
			return value !== undefined ? distance(value) : undefined;
		case "REPS":
			return value !== undefined ? `${round(value, 0)} reps` : undefined;
		case "CALORIES":
			return value !== undefined ? `${round(value, 0)} kcal` : undefined;
		case "HR_LESS_THAN":
			return value !== undefined ? `until heart rate < ${heartRate(value)}` : undefined;
		case "HR_GREATER_THAN":
			return value !== undefined ? `until heart rate > ${heartRate(value)}` : undefined;
		case "POWER_LESS_THAN":
			return value !== undefined ? `until power < ${power(value)}` : undefined;
		case "POWER_GREATER_THAN":
			return value !== undefined ? `until power > ${power(value)}` : undefined;
		case "OPEN":
			return "open (until lap button)";
		case "REPEAT_UNTIL_STEPS_CMPLT":
			return `repeat from step ${value ?? "?"}${count !== undefined ? `, ${round(count, 0)} times in total` : ""}`;
		case "REPEAT_UNTIL_TIME":
			return `repeat from step ${value ?? "?"} until ${count !== undefined ? hms(count) : "the time is up"}`;
		case "REPEAT_UNTIL_DISTANCE":
			return `repeat from step ${value ?? "?"} until ${count !== undefined ? distance(count) : "the distance is done"}`;
		case undefined:
			return undefined;
		default:
			return value !== undefined ? `${type.toLowerCase()} ${value}` : type.toLowerCase();
	}
}

/** The step's target ("heart rate 150–170 bpm", "heart rate zone 2", "pace 4:50 /km–5:10 /km"). */
export function stepTarget(step: Json, sport: string | undefined): string | undefined {
	const durationType = typeof step.durationType === "string" ? step.durationType.toUpperCase() : "";
	if (durationType.startsWith("REPEAT")) return undefined; // repeats use targetValue as their count
	const type = typeof step.targetType === "string" ? step.targetType.toUpperCase() : undefined;
	if (!type || type === "OPEN" || type === "NO_TARGET") return undefined;
	const zone = num(step.targetValue);
	const low = num(step.targetValueLow);
	const high = num(step.targetValueHigh);
	const range = (fmt: (v: number) => string) =>
		low !== undefined && high !== undefined ? `${fmt(low)}–${fmt(high)}` : low !== undefined ? fmt(low) : undefined;

	const label: Record<string, string> = { HEART_RATE: "heart rate", SPEED: "pace", POWER: "power", CADENCE: "cadence" };
	if (zone !== undefined && zone > 0 && label[type]) return `${label[type]} zone ${round(zone, 0)}`;
	switch (type) {
		case "HEART_RATE": {
			// Both bounds in bpm: show the unit once ("150–170 bpm").
			if (low !== undefined && high !== undefined && low > 100 && high > 100) {
				return `heart rate ${round(low - 100, 0)}–${round(high - 100, 0)} bpm`;
			}
			const r = range(heartRate);
			return r ? `heart rate ${r}` : undefined;
		}
		case "SPEED": {
			const isPace = !!sport && PACE_SPORTS.has(sport.toUpperCase());
			// For pace, the higher speed is the faster (smaller) pace: write it first, as runners do ("4:00–4:10 /km").
			const r = isPace && low !== undefined && high !== undefined ? `${speed(high, sport)}–${speed(low, sport)}` : range((v) => speed(v, sport));
			return r ? `${isPace ? "pace" : "speed"} ${r}` : undefined;
		}
		case "POWER": {
			if (low !== undefined && high !== undefined && low > 1000 && high > 1000) {
				return `power ${round(low - 1000, 0)}–${round(high - 1000, 0)} W`;
			}
			const r = range(power);
			return r ? `power ${r}` : undefined;
		}
		case "CADENCE": {
			const unit = sport && PACE_SPORTS.has(sport.toUpperCase()) ? "spm" : "rpm";
			const r = range((v) => `${round(v, 0)}`);
			return r ? `cadence ${r} ${unit}` : undefined;
		}
		default: {
			const r = range((v) => `${v}`);
			return `${type.toLowerCase().replace(/_/g, " ")}${r ? ` ${r}` : zone !== undefined ? ` ${zone}` : ""}`;
		}
	}
}

/** One workout from the /workouts response -> name, sport, focus and readable steps. */
export function shapeWorkout(raw: unknown): Json {
	const w = obj(raw);
	const sport = typeof w.sport === "string" ? w.sport : undefined;
	const steps = arr(w.steps)
		.map(obj)
		.sort((a, b) => (num(a.stepIndex) ?? 0) - (num(b.stepIndex) ?? 0))
		.map((s) => {
			const weight = num(s.exerciseWeightValue);
			return compact({
				step: s.stepIndex,
				name: typeof s.name === "string" && s.name.trim() ? s.name : undefined,
				intensity: typeof s.intensity === "string" ? s.intensity.toLowerCase() : undefined,
				ends: stepEnd(s),
				target: stepTarget(s, sport),
				exercise:
					s.exerciseCategory || s.exerciseName
						? compact({ category: s.exerciseCategory, name: s.exerciseName, weightKg: weight !== undefined && weight > 0 ? weight : undefined })
						: undefined,
				equipment: s.equipmentType && s.equipmentType !== "NONE" ? s.equipmentType : undefined,
				notes: s.notes,
			});
		});
	return compact({ name: w.workoutName, sport, focus: w.workoutPhrase, created: w.timeCreated, steps });
}

/** The workouts an activity followed; an empty list when it followed none (Garmin answers 404). */
export async function fetchActivityWorkouts(garmin: GarminClient, activityId: string): Promise<Json[]> {
	try {
		const result = await garmin.get<unknown[]>(`/activity-service/activity/${encodeURIComponent(activityId)}/workouts`);
		return arr(result).map(shapeWorkout);
	} catch (error) {
		if (error instanceof GarminApiError && error.status === 404) return [];
		throw error;
	}
}
