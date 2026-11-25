/**
 * Helpers that turn raw Garmin payloads into compact, LLM-friendly JSON.
 * Field names follow the Garmin Personal API Swagger schemas.
 */

type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Today's calendar date (YYYY-MM-DD) in the given IANA timezone. */
export function todayIn(timeZone: string | undefined): string {
	const zone = timeZone?.trim() || "UTC";
	try {
		return new Intl.DateTimeFormat("en-CA", {
			timeZone: zone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).format(new Date());
	} catch {
		return new Date().toISOString().slice(0, 10);
	}
}

export function addDays(date: string, days: number): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

/** Inclusive number of days between two YYYY-MM-DD dates. */
export function daysInclusive(startDate: string, endDate: string): number {
	const ms = Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`);
	return Math.round(ms / 86_400_000) + 1;
}

export function isValidDate(value: string): boolean {
	if (!DATE_RE.test(value)) return false;
	const d = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Resolves an optional [startDate, endDate] pair:
 * - both missing  -> the `defaultDays` days ending today
 * - one missing   -> a single day
 * Throws a readable error on bad input or ranges over `maxDays`.
 */
export function resolveRange(
	startDate: string | undefined,
	endDate: string | undefined,
	opts: { today: string; defaultDays: number; maxDays: number },
): { startDate: string; endDate: string } {
	let start = startDate;
	let end = endDate;
	if (!start && !end) {
		end = opts.today;
		start = addDays(opts.today, -(opts.defaultDays - 1));
	} else if (!start) {
		start = end;
	} else if (!end) {
		end = start;
	}
	assertDate(start!, "startDate");
	assertDate(end!, "endDate");
	if (start! > end!) throw new RangeError(`startDate (${start}) must be on or before endDate (${end}).`);
	const days = daysInclusive(start!, end!);
	if (days > opts.maxDays) {
		throw new RangeError(
			`Date range is ${days} days; Garmin allows at most ${opts.maxDays} days for this endpoint. Split the request into smaller ranges.`,
		);
	}
	return { startDate: start!, endDate: end! };
}

export function assertDate(value: string, name: string): void {
	if (!isValidDate(value)) throw new RangeError(`${name} must be a valid date in YYYY-MM-DD format (got "${value}").`);
}

/**
 * Garmin returns timestamps either as ISO-like strings or as epoch milliseconds.
 * "Local" epoch values encode wall-clock time, so they are rendered without a `Z`.
 */
export function formatTimestamp(value: unknown, kind: "local" | "gmt"): string | undefined {
	if (value === null || value === undefined || value === "") return undefined;
	if (typeof value === "number" && Number.isFinite(value)) {
		const iso = new Date(value).toISOString();
		return kind === "local" ? iso.slice(0, 19) : `${iso.slice(0, 19)}Z`;
	}
	return String(value);
}

// ---------------------------------------------------------------------------
// Numbers & cleanup
// ---------------------------------------------------------------------------

export function round(value: unknown, digits = 1): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	const f = 10 ** digits;
	return Math.round(value * f) / f;
}

export function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** "1:02:03" from seconds. */
export function hms(seconds: unknown): string | undefined {
	if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return undefined;
	const total = Math.round(seconds);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function hours(seconds: unknown): number | undefined {
	return typeof seconds === "number" && Number.isFinite(seconds) ? round(seconds / 3600, 2) : undefined;
}

/** Recursively drops null/undefined values, empty strings, empty arrays and empty objects. */
export function compact<T>(value: T): T {
	if (Array.isArray(value)) {
		return value.map((v) => compact(v)).filter((v) => !isEmpty(v)) as T;
	}
	if (value && typeof value === "object") {
		const out: Json = {};
		for (const [k, v] of Object.entries(value as Json)) {
			const c = compact(v);
			if (!isEmpty(c)) out[k] = c;
		}
		return out as T;
	}
	return value;
}

function isEmpty(v: unknown): boolean {
	if (v === null || v === undefined || v === "") return true;
	if (Array.isArray(v)) return v.length === 0;
	if (typeof v === "object") return Object.keys(v as Json).length === 0;
	return false;
}

function obj(value: unknown): Json {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function arr(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------

export const ACTIVITY_UNITS = {
	distance: "meters",
	duration: "seconds",
	elevationGain: "meters",
	averageSpeed: "meters/second",
	averageHR: "bpm",
	maxHR: "bpm",
	calories: "kcal",
	averagePower: "watts",
} as const;

/** SummarizedActivityDTO -> concise summary. */
export function summarizeActivity(raw: unknown): Json {
	const a = obj(raw);
	const type = obj(a.activityType);
	const speed = num(a.averageSpeed);
	return compact({
		activityId: a.activityId,
		activityName: a.activityName,
		activityType: type.typeKey ?? a.activityType,
		eventType: obj(a.eventType).typeKey,
		startTimeLocal: formatTimestamp(a.startTimeLocal, "local"),
		locationName: a.locationName,
		distance: round(a.distance, 1),
		duration: round(a.duration, 0),
		durationFormatted: hms(a.duration),
		elevationGain: round(a.elevationGain, 1),
		averageHR: round(a.averageHR, 0),
		maxHR: round(a.maxHR, 0),
		averageSpeed: round(speed, 3),
		averageSpeedKmh: speed !== undefined ? round(speed * 3.6, 1) : undefined,
		calories: round(a.calories, 0),
		averagePower: round(a.avgPower, 0),
	});
}

/** Fields of ActivitySummaryDTO.summaryDTO that are worth surfacing by default. */
const ACTIVITY_DETAIL_FIELDS = [
	"startTimeLocal",
	"startTimeGMT",
	"distance",
	"duration",
	"movingDuration",
	"elapsedDuration",
	"elevationGain",
	"elevationLoss",
	"minElevation",
	"maxElevation",
	"averageSpeed",
	"averageMovingSpeed",
	"maxSpeed",
	"avgGradeAdjustedSpeed",
	"calories",
	"bmrCalories",
	"averageHR",
	"maxHR",
	"minHR",
	"averageRunCadence",
	"maxRunCadence",
	"averageBikeCadence",
	"maxBikeCadence",
	"averageSwimCadence",
	"averagePower",
	"maxPower",
	"normalizedPower",
	"maxPowerTwentyMinutes",
	"functionalThresholdPower",
	"totalWork",
	"leftBalance",
	"rightBalance",
	"trainingEffect",
	"anaerobicTrainingEffect",
	"trainingEffectLabel",
	"aerobicTrainingEffectMessage",
	"anaerobicTrainingEffectMessage",
	"activityTrainingLoad",
	"trainingStressScore",
	"intensityFactor",
	"groundContactTime",
	"strideLength",
	"verticalOscillation",
	"verticalRatio",
	"averageTemperature",
	"minTemperature",
	"maxTemperature",
	"avgRespirationRate",
	"minRespirationRate",
	"maxRespirationRate",
	"moderateIntensityMinutes",
	"vigorousIntensityMinutes",
	"steps",
	"differenceBodyBattery",
	"avgStress",
	"maxStress",
	"recoveryHeartRate",
	"lactateThresholdHeartRate",
	"lactateThresholdSpeed",
	"poolLength",
	"numberOfActiveLengths",
	"totalNumberOfStrokes",
	"averageSWOLF",
	"totalSets",
	"totalReps",
	"floorsClimbed",
	"floorsDescended",
	"perceivedWorkoutEffort",
	"directWorkoutFeel",
	"directWorkoutRpe",
	"avgSpo2",
	"minSpo2",
	"surfaceTypeUnpavedPercentage",
	"avgEbikeAssistLevelPercent",
] as const;

/** ActivitySummaryDTO -> curated details (or the raw payload when `raw` is true). */
export function shapeActivityDetails(rawPayload: unknown, raw: boolean): Json {
	if (raw) return compact(obj(rawPayload));
	const a = obj(rawPayload);
	const summary = obj(a.summaryDTO);
	const picked: Json = {};
	for (const field of ACTIVITY_DETAIL_FIELDS) picked[field] = summary[field];
	picked.startTimeLocal = formatTimestamp(summary.startTimeLocal, "local");
	picked.startTimeGMT = formatTimestamp(summary.startTimeGMT, "gmt");
	picked.durationFormatted = hms(summary.duration);
	picked.movingDurationFormatted = hms(summary.movingDuration);
	const speed = num(summary.averageSpeed);
	if (speed !== undefined) picked.averageSpeedKmh = round(speed * 3.6, 1);

	const splits = arr(a.splitSummaries).map((s) => {
		const split = obj(s);
		return {
			splitType: split.splitType,
			noOfSplits: split.noOfSplits,
			distance: round(split.distance, 1),
			duration: round(split.duration, 0),
			movingDuration: round(split.movingDuration, 0),
			elevationGain: round(split.elevationGain, 1),
			elevationLoss: round(split.elevationLoss, 1),
			averageSpeed: round(split.averageSpeed, 3),
			maxSpeed: round(split.maxSpeed, 3),
			averageHR: round(split.averageHR, 0),
			maxHR: round(split.maxHR, 0),
			averagePower: round(split.averagePower, 0),
			calories: round(split.calories, 0),
		};
	});

	return compact({
		activityId: a.activityId,
		activityName: a.activityName,
		description: a.description,
		activityType: obj(a.activityTypeDTO).typeKey,
		eventType: obj(a.eventTypeDTO).typeKey,
		locationName: a.locationName,
		isMultiSportParent: a.isMultiSportParent || undefined,
		parentId: a.parentId,
		units: {
			distance: "meters",
			duration: "seconds",
			speed: "meters/second",
			elevation: "meters",
			heartRate: "bpm",
			power: "watts",
			calories: "kcal",
			temperature: "celsius",
		},
		summary: picked,
		splitSummaries: splits,
	});
}

// ---------------------------------------------------------------------------
// Daily summary
// ---------------------------------------------------------------------------

/** UserDailySummaryDto (/usersummary-service/usersummary/daily) -> concise summary. */
export function summarizeDailySummary(raw: unknown): Json {
	const d = obj(raw);
	return compact({
		calendarDate: d.calendarDate,
		steps: { total: d.totalSteps, goal: d.dailyStepGoal },
		distanceMeters: d.totalDistanceMeters,
		calories: {
			total: round(d.totalKilocalories, 0),
			active: round(d.activeKilocalories, 0),
			bmr: round(d.bmrKilocalories, 0),
			consumed: round(d.consumedKilocalories, 0),
		},
		heartRate: {
			resting: d.restingHeartRate,
			min: d.minHeartRate,
			max: d.maxHeartRate,
			lastSevenDaysAvgResting: d.lastSevenDaysAvgRestingHeartRate,
		},
		stress: {
			average: d.averageStressLevel,
			max: d.maxStressLevel,
			qualifier: d.stressQualifier,
			restSeconds: d.restStressDuration,
			lowSeconds: d.lowStressDuration,
			mediumSeconds: d.mediumStressDuration,
			highSeconds: d.highStressDuration,
		},
		bodyBattery: {
			charged: d.bodyBatteryChargedValue,
			drained: d.bodyBatteryDrainedValue,
			highest: d.bodyBatteryHighestValue,
			lowest: d.bodyBatteryLowestValue,
			mostRecent: d.bodyBatteryMostRecentValue,
			atWakeTime: d.bodyBatteryAtWakeTime,
			duringSleep: d.bodyBatteryDuringSleep,
		},
		intensityMinutes: {
			moderate: d.moderateIntensityMinutes,
			vigorous: d.vigorousIntensityMinutes,
			goal: d.intensityMinutesGoal,
		},
		floors: { ascended: round(d.floorsAscended, 0), descended: round(d.floorsDescended, 0), goal: d.userFloorsAscendedGoal },
		activitySeconds: {
			highlyActive: d.highlyActiveSeconds,
			active: d.activeSeconds,
			sedentary: d.sedentarySeconds,
			sleeping: d.sleepingSeconds,
		},
		spo2: { average: round(d.averageSpo2, 0), lowest: d.lowestSpo2, latest: d.latestSpo2 },
		respiration: {
			avgWaking: round(d.avgWakingRespirationValue, 1),
			highest: round(d.highestRespirationValue, 1),
			lowest: round(d.lowestRespirationValue, 1),
		},
		hydration: { valueMl: round(d.hydrationValueInML, 0), goalMl: round(d.hydrationGoalInML, 0) },
		lastSyncTimestampGMT: d.lastSyncTimestampGMT,
	});
}

/** UserDailySummaryV2DTO (/usersummary-service/v2/dailysummaries) -> same shape as v1 summary. */
export function summarizeDailySummaryV2(raw: unknown): Json {
	const d = obj(raw);
	const movement = obj(d.movement);
	const steps = obj(movement.steps);
	const floorsUp = obj(movement.floorsAscended);
	const floorsDown = obj(movement.floorsDescended);
	const calories = obj(d.calories);
	const hr = obj(d.heartRate);
	const stress = obj(d.stress);
	const bb = obj(d.bodyBattery);
	const im = obj(d.intensityMinutes);
	const pulseOx = obj(d.pulseOx);
	const resp = obj(d.respiration);
	const hydration = obj(d.hydration);
	const ms = (v: unknown) => (typeof v === "number" ? Math.round(v / 1000) : undefined);
	return compact({
		calendarDate: d.calendarDate,
		steps: { total: steps.value, goal: steps.goal },
		distanceMeters: round(steps.distanceInMeters, 0),
		calories: {
			total: calories.burnedTotal,
			active: calories.burnedActive,
			bmr: calories.burnedResting,
			consumed: calories.consumedValue,
		},
		heartRate: { resting: hr.restingValue, min: hr.minValue, max: hr.maxValue },
		stress: {
			average: stress.avgLevel,
			max: stress.maxLevel,
			qualifier: stress.qualifier,
			restSeconds: ms(stress.restDurationInMillis),
			lowSeconds: ms(stress.lowStressDurationInMillis),
			mediumSeconds: ms(stress.mediumStressDurationInMillis),
			highSeconds: ms(stress.highStressDurationInMillis),
		},
		bodyBattery: {
			charged: bb.chargedValue,
			drained: bb.drainedValue,
			highest: bb.maxValue,
			lowest: bb.minValue,
			mostRecent: bb.latestValue,
			endOfDay: bb.endOfDayValue,
		},
		intensityMinutes: { moderate: im.moderate, vigorous: im.vigorous, goal: im.goal },
		floors: { ascended: floorsUp.value, descended: floorsDown.value, goal: floorsUp.goal },
		spo2: { average: pulseOx.avgValue, lowest: pulseOx.minValue, latest: pulseOx.latestValue },
		respiration: { average: resp.avgValue, highest: resp.maxValue, lowest: resp.minValue },
		hydration: { valueMl: round(hydration.consumedInFractionalMl, 0), goalMl: hydration.goalInMl },
	});
}

// ---------------------------------------------------------------------------
// Sleep
// ---------------------------------------------------------------------------

/** DailySleepDTO -> concise summary. Accepts the DTO or a `{ dailySleepDTO }` wrapper. */
export function summarizeSleep(raw: unknown): Json {
	const wrapper = obj(raw);
	const s = obj(wrapper.dailySleepDTO ?? raw);
	const scores = obj(s.sleepScores);
	const shapedScores: Json = {};
	for (const [key, item] of Object.entries(scores)) {
		const i = obj(item);
		shapedScores[key] = compact({ value: i.value, qualifier: i.qualifierKey });
	}
	const need = obj(s.sleepNeed);
	return compact({
		calendarDate: s.calendarDate,
		sleepStartLocal: formatTimestamp(s.sleepStartTimestampLocal, "local"),
		sleepEndLocal: formatTimestamp(s.sleepEndTimestampLocal, "local"),
		totalSleepSeconds: s.sleepTimeSeconds,
		totalSleepHours: hours(s.sleepTimeSeconds),
		stages: {
			deepSeconds: s.deepSleepSeconds,
			lightSeconds: s.lightSleepSeconds,
			remSeconds: s.remSleepSeconds,
			awakeSeconds: s.awakeSleepSeconds,
			unmeasurableSeconds: s.unmeasurableSleepSeconds || undefined,
		},
		awakeCount: s.awakeCount,
		napSeconds: s.napTimeSeconds || undefined,
		sleepScore: obj(scores.overall).value,
		sleepScoreQualifier: obj(scores.overall).qualifierKey,
		sleepScores: shapedScores,
		sleepScoreFeedback: s.sleepScoreFeedback,
		sleepScoreInsight: s.sleepScoreInsight,
		avgHeartRate: round(s.avgHeartRate, 0),
		avgSleepStress: round(s.avgSleepStress, 1),
		avgSpO2: round(s.averageSpO2Value, 0),
		lowestSpO2: s.lowestSpO2Value,
		avgRespiration: round(s.averageRespirationValue, 1),
		breathingDisruptionSeverity: s.breathingDisruptionSeverity,
		sleepNeed: { baselineMinutes: need.baseline, actualMinutes: need.actual, feedback: need.feedback },
	});
}

// ---------------------------------------------------------------------------
// HRV
// ---------------------------------------------------------------------------

/** HrvDailySummaryDTO -> list of daily HRV summaries. */
export function summarizeHrv(raw: unknown): Json[] {
	return arr(obj(raw).hrvSummaries).map((item) => {
		const h = obj(item);
		const b = obj(h.baseline);
		return compact({
			calendarDate: h.calendarDate,
			lastNightAvg: h.lastNightAvg,
			lastNight5MinHigh: h.lastNight5MinHigh,
			weeklyAvg: h.weeklyAvg,
			status: h.status,
			feedbackPhrase: h.feedbackPhrase,
			baseline: {
				balancedLow: b.balancedLow,
				balancedUpper: b.balancedUpper,
				lowUpper: b.lowUpper,
				markerValue: round(b.markerValue, 2),
			},
		});
	});
}

// ---------------------------------------------------------------------------
// Body Battery
// ---------------------------------------------------------------------------

/** BodyBatteryDailyReportDTO -> concise daily report, optionally with the level timeline. */
export function summarizeBodyBattery(raw: unknown, includeTimeline: boolean): Json {
	const r = obj(raw);

	// bodyBatteryValuesArray rows are described by bodyBatteryValueDescriptorDTOList.
	const descriptors = arr(r.bodyBatteryValueDescriptorDTOList).map(obj);
	const indexOf = (key: string) => {
		const found = descriptors.find((d) => d.bodyBatteryValueDescriptorKey === key);
		return typeof found?.bodyBatteryValueDescriptorIndex === "number" ? found.bodyBatteryValueDescriptorIndex : undefined;
	};
	const tsIdx = indexOf("timestamp") ?? 0;
	const levelIdx = indexOf("bodyBatteryLevel") ?? 2;

	const points: { time?: string; level: number }[] = [];
	for (const row of arr(r.bodyBatteryValuesArray)) {
		if (!Array.isArray(row)) continue;
		const level = row[levelIdx];
		if (typeof level !== "number") continue;
		points.push({ time: formatTimestamp(row[tsIdx], "gmt"), level });
	}
	const levels = points.map((p) => p.level);

	const events = arr(r.bodyBatteryActivityEvent).map((e) => {
		const ev = obj(e);
		return {
			eventType: ev.eventType,
			startTimeGmt: formatTimestamp(ev.eventStartTimeGmt, "gmt"),
			durationMinutes: typeof ev.durationInMilliseconds === "number" ? Math.round(ev.durationInMilliseconds / 60000) : undefined,
			impact: ev.bodyBatteryImpact,
			feedback: ev.shortFeedback ?? ev.feedbackType,
		};
	});

	const feedback = obj(r.endOfDayBodyBatteryDynamicFeedbackEvent ?? r.bodyBatteryDynamicFeedbackEvent);

	return compact({
		date: r.date,
		charged: r.charged,
		drained: r.drained,
		startLevel: levels[0],
		endLevel: levels[levels.length - 1],
		highest: levels.length ? Math.max(...levels) : undefined,
		lowest: levels.length ? Math.min(...levels) : undefined,
		startTimeLocal: formatTimestamp(r.startTimestampLocal, "local"),
		endTimeLocal: formatTimestamp(r.endTimestampLocal, "local"),
		feedback: { short: feedback.feedbackShortType, long: feedback.feedbackLongType },
		events,
		timeline: includeTimeline ? points : undefined,
	});
}
