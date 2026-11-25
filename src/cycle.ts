/**
 * get_menstrual_cycle (opt-in): the cycle on a date from Garmin's women's health data.
 *
 * Off unless CYCLE_TRACKING is "on" in wrangler.jsonc; when off, the tool isn't registered, so
 * MCP clients don't even see it. It returns the cycle's day numbers and the day's flow, symptoms
 * and moods, and deliberately leaves out sexual activity, sex drive, discharge and free-text notes.
 * Garmin reports the current phase only as an undocumented number, so the tool passes on the day
 * numbers (period, fertile window, luteal phase start) rather than guessing phase names.
 * On request it also counts back through earlier cycles (start, length, period days, averages).
 */
import { GarminApiError, type GarminClient } from "./garmin";
import { addDays, compact, connectDate, daysInclusive, isValidDate, num, round } from "./format";
import { describeError } from "./parts";

type Json = Record<string, unknown>;

/** Most past cycles per call: one Garmin request each, made one after another. */
export const CYCLE_HISTORY_MAX = 12;

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

/** The summary block, whether Garmin sends it at the top level (summary) or as daySummary (day view). */
function summaryOf(raw: unknown): Json {
	const r = obj(raw);
	return r.daySummary ? obj(r.daySummary) : r;
}

function mean(values: number[], digits: number): number | undefined {
	return values.length ? round(values.reduce((a, b) => a + b, 0) / values.length, digits) : undefined;
}

/**
 * Up to `count` completed cycles before the one that started on `currentStart`, newest first.
 * The day before a cycle's start belongs to the previous cycle, so each step asks Garmin for the
 * cycle summary of that day. A failed request ends the walk; the cycles found so far are kept.
 */
export async function fetchCycleHistory(
	garmin: GarminClient,
	currentStart: string,
	count: number,
): Promise<{ history: Json; error?: string }> {
	const cycles: Json[] = [];
	let nextStart = currentStart;
	let error: string | undefined;
	while (cycles.length < count) {
		const lastDay = addDays(nextStart, -1);
		let raw: unknown;
		try {
			raw = await garmin.get(`/periodichealth-service/menstrualcycle/summary/${lastDay}`);
		} catch (e) {
			if (!(e instanceof GarminApiError && e.status === 404)) error = describeError(e);
			break;
		}
		const s = summaryOf(raw);
		const start = connectDate(s.startDate);
		// No cycle on that day, or one that doesn't end before the next: nothing further back to count.
		if (!start || !isValidDate(start) || start >= nextStart) break;
		const period = num(s.periodLength);
		cycles.push(
			compact({
				startDate: start,
				endDate: lastDay,
				lengthDays: daysInclusive(start, lastDay),
				periodDays: period !== undefined && period > 0 ? period : undefined,
				isPrediction: s.predictedCycle === true ? true : undefined,
				pregnancy: s.pregnancyCycle === true ? true : undefined,
			}),
		);
		nextStart = start;
	}

	const logged = cycles.filter((c) => c.isPrediction !== true && c.pregnancy !== true);
	const lengths = logged.map((c) => c.lengthDays as number);
	const periods = logged.map((c) => num(c.periodDays)).filter((v): v is number => v !== undefined);
	const history = compact({
		note:
			"Completed cycles before the current one, newest first. lengthDays runs from a cycle's first day to the day " +
			"before the next cycle started. The averages leave out predicted (not logged) cycles and pregnancies.",
		cyclesFound: cycles.length,
		averageCycleLengthDays: mean(lengths, 1),
		shortestCycleDays: lengths.length ? Math.min(...lengths) : undefined,
		longestCycleDays: lengths.length ? Math.max(...lengths) : undefined,
		averagePeriodDays: mean(periods, 1),
		cycles,
		message: cycles.length || error ? undefined : "No earlier cycles found in Garmin Connect.",
	});
	return { history, error };
}

/** The cycle on `date` and, when `historyCount` > 0, the completed cycles before it. */
export async function fetchCycle(garmin: GarminClient, date: string, today: string, historyCount = 0): Promise<Json> {
	const day = await fetchCycleDay(garmin, date, today);
	if (historyCount <= 0) return day;
	const start = obj(day.cycle).cycleStartDate;
	if (typeof start !== "string" || !isValidDate(start)) {
		return { ...day, history: { message: "No current cycle start to count back from." } };
	}
	const { history, error } = await fetchCycleHistory(garmin, start, historyCount);
	return compact({ ...day, history, historyError: error });
}
