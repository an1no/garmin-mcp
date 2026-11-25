/**
 * Morning summary in Telegram (opt-in).
 *
 * A cron trigger runs every 15 minutes. Nothing happens unless the TELEGRAM_BOT_TOKEN and
 * TELEGRAM_CHAT_ID secrets are set (`npm run telegram`). From DAILY_SUMMARY_HOUR (local time,
 * default 8) the Worker checks whether last night's sleep has synced; once it has, or WAIT_HOURS
 * later without it, it sends one message for the day: last night's sleep, HRV, Body Battery and
 * resting heart rate against the 7-day averages, and yesterday's steps and activities. Mondays add
 * last week compared with the week before.
 *
 * The message goes from Cloudflare straight to Telegram. The only thing stored is a "sent" marker
 * per day in KV, so the summary goes out once.
 */
import { addDays, num, round, summarizeActivity, summarizeDailySummary, summarizeHrv, summarizeSleep } from "./format";
import { GarminClient } from "./garmin";
import { describeError, fetchParts } from "./parts";
import { resolveTimeZone } from "./profile";
import { aggregateSleep, collectTrends, DEFAULT_TREND_METRICS } from "./trends";

type Json = Record<string, unknown>;
type Garmin = Pick<GarminClient, "get" | "getAccessToken">;

/** The Telegram secrets are optional, so they are not in wrangler.jsonc's secrets.required. */
export type SummaryEnv = Env & { TELEGRAM_BOT_TOKEN?: string; TELEGRAM_CHAT_ID?: string };

export const DEFAULT_SUMMARY_HOUR = 8;
/** Hours after the start hour to wait for last night's sleep to sync before sending without it. */
export const WAIT_HOURS = 3;
export const SENT_KEY_PREFIX = "summary:sent:";
const SENT_TTL_SECONDS = 3 * 24 * 60 * 60;
const TELEGRAM_API = "https://api.telegram.org";
const TELEGRAM_TIMEOUT_MS = 15_000;

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

export function summaryConfigured(env: Pick<SummaryEnv, "TELEGRAM_BOT_TOKEN" | "TELEGRAM_CHAT_ID">): boolean {
	return Boolean(env.TELEGRAM_BOT_TOKEN?.trim() && env.TELEGRAM_CHAT_ID?.trim());
}

/** DAILY_SUMMARY_HOUR as a whole hour 0-23, or the default. */
export function summaryHour(value: string | undefined): number {
	const text = (value ?? "").trim();
	const hour = Number(text);
	return text !== "" && Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_SUMMARY_HOUR;
}

/** Local calendar date, hour (0-23) and weekday (1 = Monday) of `now` in `timeZone`. */
export function localTime(now: Date, timeZone: string): { date: string; hour: number; weekday: number } {
	const parts: Record<string, string> = {};
	const format = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		hourCycle: "h23",
		weekday: "short",
	});
	for (const part of format.formatToParts(now)) parts[part.type] = part.value;
	return {
		date: `${parts.year}-${parts.month}-${parts.day}`,
		hour: Number(parts.hour) % 24,
		weekday: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday ?? "") + 1,
	};
}

// ------------------------------------------------------------------------------ data

export interface MorningData {
	date: string;
	/** Last night (the night that ended on `date`), from summarizeSleep. */
	sleep?: Json;
	/** The 7 nights before, from aggregateSleep. */
	sleepWeek?: Json;
	/** Today so far (resting heart rate, Body Battery at waking), from summarizeDailySummary. */
	today?: Json;
	/** Last night's HRV, from summarizeHrv. */
	hrv?: Json;
	/** Yesterday's totals, from summarizeDailySummary. */
	yesterday?: Json;
	/** Yesterday's activities, from summarizeActivity. */
	activities?: Json[];
	/** The two weeks before `date`, by week (Mondays only), from collectTrends. */
	lastWeek?: Json;
	/** Parts that couldn't be read. */
	errors: string[];
	/** Set when no Garmin data could be read at all. */
	garminError?: string;
}

const hasSleep = (s: Json | undefined): boolean => (num(s?.totalSleepSeconds) ?? 0) > 0;

/** Last night's sleep, or undefined while it hasn't synced. */
export async function fetchLastNightSleep(garmin: Garmin, date: string): Promise<Json | undefined> {
	const raw = await garmin.get("/sleep-service/sleep/dailySleep", { date });
	const sleep = raw ? summarizeSleep(raw) : undefined;
	return hasSleep(sleep) ? sleep : undefined;
}

type MorningPart = "today" | "yesterday" | "hrv" | "activities" | "sleepWeek" | "lastWeek";

/** Everything else the message needs, in parallel; a part that fails is listed in `errors`. */
export async function collectMorning(garmin: Garmin, date: string, opts: { sleep?: Json; weekly: boolean }): Promise<MorningData> {
	const yesterday = addDays(date, -1);
	const daily = async (calendarDate: string) => {
		const raw = await garmin.get("/usersummary-service/usersummary/daily", { calendarDate });
		return raw ? summarizeDailySummary(raw) : undefined;
	};
	const fetchers: Record<MorningPart, () => Promise<unknown>> = {
		today: () => daily(date),
		yesterday: () => daily(yesterday),
		hrv: async () => summarizeHrv(await garmin.get(`/hrv-service/hrv/daily/${date}/${date}`))[0],
		activities: async () => {
			const raw = await garmin.get("/activitylist-service/activities/search/activities", {
				start: 0,
				limit: 20,
				startDate: yesterday,
				endDate: yesterday,
			});
			return (Array.isArray(raw) ? raw : []).map(summarizeActivity);
		},
		sleepWeek: async () => {
			const raw = await garmin.get("/sleep-service/sleep/dailySleepSummariesByDate", {
				startDate: addDays(date, -7),
				endDate: yesterday,
			});
			return aggregateSleep((Array.isArray(raw) ? raw : []).map(summarizeSleep));
		},
		lastWeek: () =>
			collectTrends(garmin as GarminClient, {
				startDate: addDays(date, -14),
				endDate: yesterday,
				period: "week",
				metrics: DEFAULT_TREND_METRICS,
			}),
	};
	const parts: MorningPart[] = ["today", "yesterday", "hrv", "activities", "sleepWeek"];
	if (opts.weekly) parts.push("lastWeek");

	try {
		await garmin.getAccessToken(); // one token request for the parallel calls
		const { results, errors } = await fetchParts(fetchers, parts);
		const r = results as Partial<Record<MorningPart, unknown>>;
		return {
			date,
			sleep: opts.sleep,
			today: r.today as Json | undefined,
			yesterday: r.yesterday as Json | undefined,
			hrv: r.hrv as Json | undefined,
			activities: r.activities as Json[] | undefined,
			sleepWeek: r.sleepWeek as Json | undefined,
			lastWeek: r.lastWeek as Json | undefined,
			errors: parts.filter((p) => errors[p] !== undefined),
		};
	} catch (error) {
		// Every part failed (or the token request did): there's nothing but the sleep, if any.
		return { date, sleep: opts.sleep, errors: [], garminError: describeError(error) };
	}
}

// ------------------------------------------------------------------------------ message

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 9812 -> "9,812". */
const thousands = (value: number) => String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** Seconds -> "7 h 05 min" or "45 min". */
function duration(seconds: number): string {
	const minutes = Math.round(seconds / 60);
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	return h > 0 ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min`;
}

/** Garmin's "GOOD" / "UNBALANCED_LOW" -> "good" / "unbalanced low". */
const words = (value: unknown) => (typeof value === "string" ? value.toLowerCase().replace(/_/g, " ") : undefined);

const dayMonth = (date: string) => `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;

/** "17–23 November", or "27 October – 2 November" across months. */
function dateSpan(from: string, to: string): string {
	return from.slice(5, 7) === to.slice(5, 7) ? `${Number(from.slice(8, 10))}–${dayMonth(to)}` : `${dayMonth(from)} – ${dayMonth(to)}`;
}

const obj = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});

const ACTIVITY_ICONS: [RegExp, string][] = [
	[/run/, "🏃"],
	[/cycl|bik|ride/, "🚴"],
	[/swim/, "🏊"],
	[/walk|hik/, "🥾"],
	[/strength|fitness_equipment|training/, "🏋️"],
	[/yoga|pilates|breath/, "🧘"],
];

function activityLine(a: Json): string {
	const type = String(a.activityType ?? "");
	const icon = ACTIVITY_ICONS.find(([pattern]) => pattern.test(type))?.[1] ?? "⏱️";
	const name = escapeHtml(String(a.activityName ?? words(type) ?? "Activity"));
	const details: string[] = [];
	const distance = num(a.distance);
	if (distance !== undefined && distance > 0) details.push(`${round(distance / 1000, 1)} km`);
	if (typeof a.durationFormatted === "string") details.push(a.durationFormatted);
	return `${icon} ${name}${details.length ? `: ${details.join(", ")}` : ""}`;
}

const PART_NAMES: Record<string, string> = {
	sleep: "last night's sleep",
	today: "today's summary",
	yesterday: "yesterday's summary",
	hrv: "HRV",
	activities: "activities",
	sleepWeek: "the 7-day sleep average",
	lastWeek: "last week",
};

function weeklyLines(trends: Json | undefined): string[] {
	const periods = Array.isArray(trends?.periods) ? (trends.periods as Json[]) : [];
	if (periods.length < 2) return [];
	const [before, last] = [periods[periods.length - 2]!, periods[periods.length - 1]!];
	const lines = [`<b>Last week</b> (${dateSpan(String(last.from), String(last.to))}), compared with the week before`];

	const acts = obj(last.activities);
	const actsBefore = obj(before.activities);
	const count = num(acts.count) ?? 0;
	const countBefore = num(actsBefore.count) ?? 0;
	const totals = (a: Json) =>
		[num(a.distanceKm) ? `${a.distanceKm} km` : undefined, num(a.durationHours) ? `${a.durationHours} h` : undefined]
			.filter(Boolean)
			.join(", ");
	const thisWeek = totals(acts);
	const weekBefore = totals(actsBefore);
	lines.push(
		count > 0
			? `🏃 ${count} ${count === 1 ? "activity" : "activities"}${thisWeek ? `: ${thisWeek}` : ""} (before: ${countBefore}${weekBefore ? `, ${weekBefore}` : ""})`
			: `🏃 No activities (before: ${countBefore})`,
	);

	const sleepHours = num(obj(last.sleep).avgSleepHours);
	const sleepBefore = num(obj(before.sleep).avgSleepHours);
	if (sleepHours !== undefined) {
		lines.push(
			`😴 Sleep: ${duration(sleepHours * 3600)} on average${sleepBefore !== undefined ? ` (before: ${duration(sleepBefore * 3600)})` : ""}`,
		);
	}
	const rhr = num(obj(last.daily).avgRestingHeartRate);
	const rhrBefore = num(obj(before.daily).avgRestingHeartRate);
	if (rhr !== undefined) lines.push(`❤️ Resting heart rate: ${rhr} bpm${rhrBefore !== undefined ? ` (before: ${rhrBefore})` : ""}`);
	const hrv = num(obj(last.hrv).avgLastNight);
	const hrvBefore = num(obj(before.hrv).avgLastNight);
	if (hrv !== undefined) lines.push(`💓 HRV: ${hrv} ms${hrvBefore !== undefined ? ` (before: ${hrvBefore})` : ""}`);
	const steps = num(obj(last.daily).totalSteps);
	const stepsBefore = num(obj(before.daily).totalSteps);
	if (steps !== undefined) lines.push(`👟 Steps: ${thousands(steps)}${stepsBefore !== undefined ? ` (before: ${thousands(stepsBefore)})` : ""}`);
	return lines;
}

/** The Telegram message (HTML parse mode). `weekday` is 1 for Monday. */
export function formatMorningMessage(data: MorningData, weekday: number): string {
	const lines = [`<b>Good morning! ${DAYS[weekday - 1] ?? ""}, ${dayMonth(data.date)}</b>`, ""];

	if (data.garminError && !data.sleep) {
		lines.push(
			`⚠️ Couldn't read your Garmin data: ${escapeHtml(data.garminError)}`,
			"If your Garmin Personal API key has expired, create a new one and run <code>npm run setup -- --update-key</code>.",
		);
		return lines.join("\n");
	}

	// Last night
	const sleep = data.sleep;
	if (sleep && hasSleep(sleep)) {
		const score = num(sleep.sleepScore);
		const quality = words(sleep.sleepScoreQualifier);
		lines.push(
			`😴 <b>Sleep</b>: ${duration(sleep.totalSleepSeconds as number)}${score !== undefined ? `, score ${score}${quality ? ` (${quality})` : ""}` : ""}`,
		);
		const avgHours = num(data.sleepWeek?.avgSleepHours);
		const avgScore = num(data.sleepWeek?.avgSleepScore);
		if (avgHours !== undefined) {
			lines.push(`      7-day average: ${duration(avgHours * 3600)}${avgScore !== undefined ? `, score ${avgScore}` : ""}`);
		}
	} else if (data.errors.includes("sleep")) {
		lines.push("😴 <b>Sleep</b>: couldn't read it.");
	} else {
		lines.push("😴 <b>Sleep</b>: not synced yet. Open Garmin Connect on your phone to sync the watch.");
	}

	const hrv = data.hrv;
	const hrvValue = num(hrv?.lastNightAvg);
	if (hrvValue !== undefined) {
		const status = words(hrv?.status);
		const weekly = num(hrv?.weeklyAvg);
		lines.push(`💓 <b>HRV</b>: ${hrvValue} ms${status && status !== "none" ? `, ${status}` : ""}${weekly !== undefined ? ` · 7-day average ${weekly} ms` : ""}`);
	}

	const battery = obj(data.today?.bodyBattery);
	const atWake = num(battery.atWakeTime);
	const charged = num(battery.duringSleep);
	const latest = num(battery.mostRecent);
	if (atWake !== undefined) {
		lines.push(`🔋 <b>Body Battery</b>: ${atWake} on waking${charged !== undefined && charged > 0 ? `, +${charged} during sleep` : ""}`);
	} else if (latest !== undefined) {
		lines.push(`🔋 <b>Body Battery</b>: ${latest} now`);
	}

	const heart = obj(data.today?.heartRate);
	const resting = num(heart.resting);
	const restingWeek = num(heart.lastSevenDaysAvgResting);
	if (resting !== undefined) {
		lines.push(`❤️ <b>Resting heart rate</b>: ${resting} bpm${restingWeek !== undefined ? ` · 7-day average ${restingWeek} bpm` : ""}`);
	}

	// Yesterday
	const yesterdayLines: string[] = [];
	const steps = obj(data.yesterday?.steps);
	const stepTotal = num(steps.total);
	const stepGoal = num(steps.goal);
	if (stepTotal !== undefined) {
		yesterdayLines.push(`👟 ${thousands(stepTotal)} steps${stepGoal ? ` (goal ${thousands(stepGoal)})` : ""}`);
	}
	for (const activity of data.activities ?? []) yesterdayLines.push(activityLine(activity));
	if (yesterdayLines.length) lines.push("", "<b>Yesterday</b>", ...yesterdayLines);

	const weekly = weeklyLines(data.lastWeek);
	if (weekly.length) lines.push("", ...weekly);

	if (data.garminError) {
		lines.push("", `<i>Couldn't read the rest of your Garmin data: ${escapeHtml(data.garminError)}</i>`);
	} else if (data.errors.length) {
		lines.push("", `<i>Couldn't read: ${data.errors.map((p) => PART_NAMES[p] ?? p).join(", ")}.</i>`);
	}
	return lines.join("\n");
}

// ------------------------------------------------------------------------------ sending

/** Sends one message; never throws for an HTTP error, only returns its status. */
export async function sendTelegram(
	token: string,
	chatId: string,
	text: string,
	fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number }> {
	const response = await fetchImpl(`${TELEGRAM_API}/bot${token}/sendMessage`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
		signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
	});
	return { ok: response.ok, status: response.status };
}

// ------------------------------------------------------------------------------ the cron job

export type SummaryOutcome =
	| "not_configured"
	| "outside_window"
	| "already_sent"
	| "waiting_for_sleep"
	| "sent"
	| "send_failed";

export interface SummaryResult {
	outcome: SummaryOutcome;
	telegramStatus?: number;
	partialErrors?: string[];
	garminUnavailable?: boolean;
}

/**
 * One cron tick: decides whether today's summary is due and, if so, sends it.
 * `deps` replaces the Garmin client and fetch in tests.
 */
export async function runDailySummary(
	env: SummaryEnv,
	now: Date,
	deps: { garmin?: Garmin; fetch?: typeof fetch } = {},
): Promise<SummaryResult> {
	if (!summaryConfigured(env)) return { outcome: "not_configured" };

	const garmin = deps.garmin ?? new GarminClient(env.GARMIN_PERSONAL_API_KEY, env.OAUTH_KV);
	const { zone } = await resolveTimeZone(env.TIMEZONE, garmin, env.OAUTH_KV);
	const local = localTime(now, zone);
	const start = summaryHour(env.DAILY_SUMMARY_HOUR);
	const deadline = Math.min(start + WAIT_HOURS, 23);
	if (local.hour < start || local.hour > deadline) return { outcome: "outside_window" };

	const sentKey = `${SENT_KEY_PREFIX}${local.date}`;
	if (await env.OAUTH_KV.get(sentKey)) return { outcome: "already_sent" };

	let sleep: Json | undefined;
	let sleepError: string | undefined;
	try {
		sleep = await fetchLastNightSleep(garmin, local.date);
	} catch (error) {
		sleepError = describeError(error);
	}
	if (!sleep && local.hour < deadline) return { outcome: "waiting_for_sleep" };

	const data = await collectMorning(garmin, local.date, { sleep, weekly: local.weekday === 1 });
	if (sleepError) data.errors.unshift("sleep");
	const text = formatMorningMessage(data, local.weekday);

	let status = 0;
	try {
		status = (await sendTelegram(env.TELEGRAM_BOT_TOKEN!.trim(), env.TELEGRAM_CHAT_ID!.trim(), text, deps.fetch)).status;
	} catch {
		status = 0; // network error or timeout: try again on the next tick
	}
	const ok = status >= 200 && status < 300;
	// A rejected request (bad token, blocked bot) won't succeed later today either.
	const permanent = status >= 400 && status < 500 && status !== 429;
	if (ok || permanent) await env.OAUTH_KV.put(sentKey, "1", { expirationTtl: SENT_TTL_SECONDS });

	return {
		outcome: ok ? "sent" : "send_failed",
		telegramStatus: status || undefined,
		partialErrors: data.errors.length ? data.errors : undefined,
		garminUnavailable: data.garminError !== undefined ? true : undefined,
	};
}

/**
 * One structured log line per tick that did something (Workers Logs: filter on event = "daily_summary").
 * Only the outcome: never dates, health data, the chat ID or the bot token.
 */
export function logDailySummary(result: SummaryResult): void {
	if (result.outcome === "not_configured" || result.outcome === "outside_window" || result.outcome === "already_sent") return;
	const entry: Record<string, unknown> = { event: "daily_summary", outcome: result.outcome };
	if (result.telegramStatus !== undefined) entry.telegramStatus = result.telegramStatus;
	if (result.partialErrors) entry.partialErrors = result.partialErrors;
	if (result.garminUnavailable) entry.garminUnavailable = true;
	console.log(entry);
}
