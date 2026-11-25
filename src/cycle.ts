/**
 * get_menstrual_cycle (opt-in): the cycle on a date from Garmin's women's health data.
 *
 * Off unless CYCLE_TRACKING is "on" in wrangler.jsonc; when off, the tool isn't registered, so
 * MCP clients don't even see it. It returns the cycle's day numbers and the day's flow, symptoms
 * and moods, and deliberately leaves out sexual activity, sex drive, discharge and free-text notes.
 * Garmin reports the current phase only as an undocumented number, so the tool passes on the day
 * numbers (period, fertile window, luteal phase start) rather than guessing phase names.
 */
import { GarminApiError, type GarminClient } from "./garmin";
import { compact, num } from "./format";

type Json = Record<string, unknown>;

/** Values of CYCLE_TRACKING that turn the tool on. */
export function cycleTrackingEnabled(value: string | undefined): boolean {
	return ["on", "true", "1", "yes"].includes((value ?? "").trim().toLowerCase());
}

function obj(value: unknown): Json {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function strings(value: unknown): string[] | undefined {
	const list = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "") : [];
	return list.length ? list : undefined;
}

/** Garmin's ConnectDate ({ date, localDate }) or a plain string -> YYYY-MM-DD. */
function connectDate(value: unknown): string | undefined {
	if (typeof value === "string") return value.slice(0, 10);
	const d = obj(value);
	const s = typeof d.localDate === "string" ? d.localDate : typeof d.date === "string" ? d.date : undefined;
	return s?.slice(0, 10);
}

/** /periodichealth-service/menstrualcycle/dayview/{date} -> concise cycle summary and day log. */
export function shapeCycleDay(raw: unknown, date: string): Json {
	const r = obj(raw);
	const s = obj(r.daySummary);
	const log = obj(r.dayLog);
	const fertileStart = num(s.fertileWindowStart);
	const fertileLength = num(s.lengthOfFertileWindow);
	const periodLength = num(s.periodLength);

	const cycle = compact({
		dayInCycle: s.dayInCycle,
		cycleStartDate: connectDate(s.startDate),
		cycleEndDate: connectDate(s.endDate),
		predictedCycleLength: s.predictedCycleLength,
		periodDays: periodLength !== undefined && periodLength > 0 ? { fromDay: 1, toDay: periodLength } : undefined,
		fertileWindow:
			fertileStart !== undefined && fertileLength !== undefined && fertileLength > 0
				? { fromDay: fertileStart, toDay: fertileStart + fertileLength - 1 }
				: undefined,
		lutealPhaseStartsOnDay: s.lutealPhaseStart,
		predictedOvulationDate: connectDate(s.predictedOvulationDate),
		currentPhaseId: s.currentPhase,
		lengthOfCurrentPhase: s.lengthOfCurrentPhase,
		daysUntilNextPhase: s.daysUntilNextPhase,
		isPrediction: s.predictedCycle === true ? true : undefined,
		cycleType: s.cycleType,
		feedbackPhrase: s.feedbackPhrase,
	});
	const pregnancy =
		s.pregnancyCycle === true ? compact({ week: s.numberOfWeek, dueDate: connectDate(s.dueDate), deliveryDate: connectDate(s.deliveryDate) }) : undefined;
	const dayLog = compact({
		flow: typeof log.flow === "string" && log.flow.trim() ? log.flow : undefined,
		symptoms: strings(log.symptoms),
		moods: strings(log.moods),
		ovulationDay: log.ovulationDay === true ? true : undefined,
	});

	if (!Object.keys(cycle).length && !pregnancy && !Object.keys(dayLog).length) {
		return { date, message: "No cycle data for this date. Cycle tracking may not be set up in Garmin Connect." };
	}
	return compact({
		date,
		note: "Day numbers count from day 1 of the cycle. currentPhaseId is Garmin's own phase number; use the day numbers to describe the phase.",
		cycle,
		pregnancy,
		dayLog,
	});
}

/** The cycle on `date`; `today` is the caller's current date, which Garmin uses for predictions. */
export async function fetchCycleDay(garmin: GarminClient, date: string, today: string): Promise<Json> {
	try {
		const raw = await garmin.get(`/periodichealth-service/menstrualcycle/dayview/${date}`, {
			todayDate: today,
			skipbm: true,
			includeAnalysis: false,
		});
		return shapeCycleDay(raw, date);
	} catch (error) {
		if (error instanceof GarminApiError && error.status === 404) return shapeCycleDay(null, date);
		throw error;
	}
}
