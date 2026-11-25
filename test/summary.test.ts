import { afterEach, describe, expect, it, vi } from "vitest";
import { GarminApiError } from "../src/garmin";
import {
	formatMorningMessage,
	localTime,
	logDailySummary,
	type MorningData,
	runDailySummary,
	SENT_KEY_PREFIX,
	summaryConfigured,
	summaryHour,
	type SummaryEnv,
} from "../src/summary";
import { FakeKV, fakeGarmin } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const TOKEN = "123456789:test-telegram-token-not-a-real-one-xx";
const CHAT = "424242";

// ------------------------------------------------------------------ synthetic Garmin answers

const sleepFor = (date: string, seconds = 7 * 3600 + 12 * 60) => ({
	dailySleepDTO: { calendarDate: date, sleepTimeSeconds: seconds, sleepScores: { overall: { value: 82, qualifierKey: "GOOD" } } },
});

function garminFor(date: string, opts: { sleep?: boolean; fail?: (path: string) => boolean } = {}) {
	return fakeGarmin((path, query) => {
		if (opts.fail?.(path)) throw new GarminApiError("Rate limited", 429, path);
		if (path === "/sleep-service/sleep/dailySleep") return opts.sleep === false ? null : sleepFor(String(query.date));
		if (path === "/usersummary-service/usersummary/daily") {
			return query.calendarDate === date
				? { calendarDate: date, restingHeartRate: 54, lastSevenDaysAvgRestingHeartRate: 56, bodyBatteryAtWakeTime: 78, bodyBatteryDuringSleep: 52 }
				: { calendarDate: query.calendarDate, totalSteps: 9812, dailyStepGoal: 8000 };
		}
		if (path.startsWith("/hrv-service/hrv/daily/")) return { hrvSummaries: [{ calendarDate: date, lastNightAvg: 48, weeklyAvg: 46, status: "BALANCED" }] };
		if (path === "/activitylist-service/activities/search/activities") {
			return [
				{ activityName: "Morning <Run>", activityType: { typeKey: "running" }, distance: 8210, duration: 2530 },
				{ activityName: "Strength", activityType: { typeKey: "strength_training" }, duration: 2100 },
			];
		}
		if (path === "/sleep-service/sleep/dailySleepSummariesByDate") {
			return [
				{ calendarDate: "a", sleepTimeSeconds: 6 * 3600 + 40 * 60, sleepScores: { overall: { value: 74 } } },
				{ calendarDate: "b", sleepTimeSeconds: 7 * 3600, sleepScores: { overall: { value: 78 } } },
			];
		}
		return [];
	});
}

function makeEnv(overrides: Partial<SummaryEnv> = {}) {
	const kv = new FakeKV();
	const env = {
		GARMIN_PERSONAL_API_KEY: "test-key",
		MCP_ADMIN_PASSWORD: "test-password-123",
		TIMEZONE: "Asia/Tbilisi",
		CYCLE_TRACKING: "off",
		DAILY_SUMMARY_HOUR: "8",
		TELEGRAM_BOT_TOKEN: TOKEN,
		TELEGRAM_CHAT_ID: CHAT,
		OAUTH_KV: kv.asKV(),
		...overrides,
	} as unknown as SummaryEnv;
	return { env, kv };
}

/** A fetch stand-in for Telegram that records the messages. */
function telegramFetch(status = 200) {
	const sent: { url: string; body: Record<string, unknown> }[] = [];
	const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
		return new Response(JSON.stringify({ ok: status === 200 }), { status });
	});
	return { sent, fetch: fn as unknown as typeof fetch };
}

// 2026-11-24 is a Tuesday, 2026-11-23 a Monday; Tbilisi is UTC+4.
const at = (localIso: string) => new Date(Date.parse(`${localIso}+04:00`));

// ------------------------------------------------------------------ settings and time

describe("settings", () => {
	it("needs both Telegram secrets", () => {
		expect(summaryConfigured({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT })).toBe(true);
		expect(summaryConfigured({ TELEGRAM_BOT_TOKEN: TOKEN })).toBe(false);
		expect(summaryConfigured({ TELEGRAM_BOT_TOKEN: " ", TELEGRAM_CHAT_ID: CHAT })).toBe(false);
		expect(summaryConfigured({})).toBe(false);
	});

	it("DAILY_SUMMARY_HOUR is a whole hour 0-23, otherwise 8", () => {
		expect(summaryHour("7")).toBe(7);
		expect(summaryHour(" 0 ")).toBe(0);
		for (const bad of [undefined, "", "24", "-1", "7.5", "seven"]) expect(summaryHour(bad), String(bad)).toBe(8);
	});

	it("localTime gives the local date, hour and weekday", () => {
		expect(localTime(new Date("2026-11-23T04:30:00Z"), "Asia/Tbilisi")).toEqual({ date: "2026-11-23", hour: 8, weekday: 1 });
		expect(localTime(new Date("2026-11-23T22:30:00Z"), "Asia/Tbilisi")).toEqual({ date: "2026-11-24", hour: 2, weekday: 2 });
		expect(localTime(new Date("2026-11-29T23:00:00Z"), "UTC")).toEqual({ date: "2026-11-29", hour: 23, weekday: 7 });
	});
});

// ------------------------------------------------------------------ the message

const morning: MorningData = {
	date: "2026-11-24",
	sleep: { totalSleepSeconds: 7 * 3600 + 12 * 60, sleepScore: 82, sleepScoreQualifier: "GOOD" },
	sleepWeek: { avgSleepHours: 6.83, avgSleepScore: 76 },
	today: { heartRate: { resting: 54, lastSevenDaysAvgResting: 56 }, bodyBattery: { atWakeTime: 78, duringSleep: 52 } },
	hrv: { lastNightAvg: 48, weeklyAvg: 46, status: "BALANCED" },
	yesterday: { steps: { total: 9812, goal: 8000 } },
	activities: [
		{ activityName: "Morning <Run>", activityType: "running", distance: 8210, durationFormatted: "42:10" },
		{ activityName: "Strength", activityType: "strength_training", durationFormatted: "35:00" },
	],
	errors: [],
};

describe("formatMorningMessage", () => {
	it("last night against the 7-day averages, then yesterday", () => {
		expect(formatMorningMessage(morning, 2)).toBe(
			[
				"<b>Good morning! Tuesday, 24 November</b>",
				"",
				"😴 <b>Sleep</b>: 7 h 12 min, score 82 (good)",
				"      7-day average: 6 h 50 min, score 76",
				"💓 <b>HRV</b>: 48 ms, balanced · 7-day average 46 ms",
				"🔋 <b>Body Battery</b>: 78 on waking, +52 during sleep",
				"❤️ <b>Resting heart rate</b>: 54 bpm · 7-day average 56 bpm",
				"",
				"<b>Yesterday</b>",
				"👟 9,812 steps (goal 8,000)",
				"🏃 Morning &lt;Run&gt;: 8.2 km, 42:10",
				"🏋️ Strength: 35:00",
			].join("\n"),
		);
	});

	it("says when sleep hasn't synced, and lists the parts it couldn't read", () => {
		const text = formatMorningMessage({ date: "2026-11-24", errors: ["hrv", "activities"] }, 2);
		expect(text).toContain("Sleep</b>: not synced yet");
		expect(text).toContain("<i>Couldn't read: HRV, activities.</i>");
		expect(text).not.toContain("Yesterday");
		expect(formatMorningMessage({ date: "2026-11-24", errors: ["sleep"] }, 2)).toContain("Sleep</b>: couldn't read it.");
	});

	it("when nothing could be read, explains the likely fix", () => {
		const text = formatMorningMessage({ date: "2026-11-24", errors: [], garminError: "Garmin rejected the API key <401>" }, 2);
		expect(text).toContain("⚠️ Couldn't read your Garmin data: Garmin rejected the API key &lt;401&gt;");
		expect(text).toContain("npm run setup -- --update-key");
		expect(text).not.toContain("Sleep");
	});

	it("Mondays add last week against the week before", () => {
		const lastWeek = {
			periods: [
				{
					from: "2026-11-09",
					to: "2026-11-15",
					sleep: { avgSleepHours: 6.67 },
					daily: { avgRestingHeartRate: 56, totalSteps: 55100 },
					hrv: { avgLastNight: 45 },
					activities: { count: 4, distanceKm: 25, durationHours: 3.1 },
				},
				{
					from: "2026-11-16",
					to: "2026-11-22",
					sleep: { avgSleepHours: 7.08 },
					daily: { avgRestingHeartRate: 54, totalSteps: 61234 },
					hrv: { avgLastNight: 47 },
					activities: { count: 5, distanceKm: 32.4, durationHours: 4.2 },
				},
			],
		};
		const text = formatMorningMessage({ ...morning, date: "2026-11-23", lastWeek }, 1);
		expect(text).toContain("<b>Good morning! Monday, 23 November</b>");
		expect(text).toContain(
			[
				"<b>Last week</b> (16–22 November), compared with the week before",
				"🏃 5 activities: 32.4 km, 4.2 h (before: 4, 25 km, 3.1 h)",
				"😴 Sleep: 7 h 05 min on average (before: 6 h 40 min)",
				"❤️ Resting heart rate: 54 bpm (before: 56)",
				"💓 HRV: 47 ms (before: 45)",
				"👟 Steps: 61,234 (before: 55,100)",
			].join("\n"),
		);
		const quiet = formatMorningMessage(
			{
				...morning,
				lastWeek: { periods: [{ from: "2026-10-26", to: "2026-11-01", activities: { count: 2 } }, { from: "2026-11-02", to: "2026-11-08" }] },
			},
			1,
		);
		expect(quiet).toContain("(2–8 November)");
		expect(quiet).toContain("🏃 No activities (before: 2)");
	});

	it("a week across two months names both", () => {
		const text = formatMorningMessage({ ...morning, lastWeek: { periods: [{ from: "2026-10-19", to: "2026-10-25" }, { from: "2026-10-26", to: "2026-11-01" }] } }, 1);
		expect(text).toContain("(26 October – 1 November)");
	});
});

// ------------------------------------------------------------------ the cron job

describe("runDailySummary", () => {
	it("does nothing at all without the Telegram secrets", async () => {
		const { env } = makeEnv({ TELEGRAM_BOT_TOKEN: undefined });
		const g = garminFor("2026-11-24");
		const tg = telegramFetch();
		expect(await runDailySummary(env, at("2026-11-24T08:15:00"), { garmin: g.client, fetch: tg.fetch })).toEqual({ outcome: "not_configured" });
		expect(g.calls).toHaveLength(0);
		expect(tg.sent).toHaveLength(0);
	});

	it("outside the window it doesn't call Garmin", async () => {
		const { env } = makeEnv();
		const g = garminFor("2026-11-24");
		for (const time of ["2026-11-24T07:45:00", "2026-11-24T12:00:00", "2026-11-24T23:30:00"]) {
			expect((await runDailySummary(env, at(time), { garmin: g.client })).outcome, time).toBe("outside_window");
		}
		expect(g.calls).toHaveLength(0);
	});

	it("waits while last night's sleep hasn't synced", async () => {
		const { env, kv } = makeEnv();
		const g = garminFor("2026-11-24", { sleep: false });
		const tg = telegramFetch();
		expect((await runDailySummary(env, at("2026-11-24T08:15:00"), { garmin: g.client, fetch: tg.fetch })).outcome).toBe("waiting_for_sleep");
		expect(g.calls.map((c) => c.path)).toEqual(["/sleep-service/sleep/dailySleep"]);
		expect(g.calls[0]!.query).toEqual({ date: "2026-11-24" });
		expect(tg.sent).toHaveLength(0);
		expect(kv.puts).toHaveLength(0);
	});

	it("sends once the sleep is there, then not again that day", async () => {
		const { env, kv } = makeEnv();
		const g = garminFor("2026-11-24");
		const tg = telegramFetch();
		const result = await runDailySummary(env, at("2026-11-24T08:30:00"), { garmin: g.client, fetch: tg.fetch });
		expect(result).toEqual({ outcome: "sent", telegramStatus: 200 });
		expect(tg.sent).toHaveLength(1);
		expect(tg.sent[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
		expect(tg.sent[0]!.body).toMatchObject({ chat_id: CHAT, parse_mode: "HTML" });
		expect(tg.sent[0]!.body.text).toBe(formatMorningMessage({ ...morning, sleepWeek: { avgSleepHours: 6.83, avgSleepScore: 76 } }, 2));
		expect(kv.puts).toEqual([expect.objectContaining({ key: `${SENT_KEY_PREFIX}2026-11-24`, options: { expirationTtl: 259200 } })]);
		// Yesterday's data, the 7 nights before and today's summary; no weekly trends on a Tuesday.
		expect(g.calls.map((c) => c.path).sort()).toEqual(
			[
				"/activitylist-service/activities/search/activities",
				"/hrv-service/hrv/daily/2026-11-24/2026-11-24",
				"/sleep-service/sleep/dailySleep",
				"/sleep-service/sleep/dailySleepSummariesByDate",
				"/usersummary-service/usersummary/daily",
				"/usersummary-service/usersummary/daily",
			].sort(),
		);
		expect(g.calls.find((c) => c.path.startsWith("/activitylist"))!.query).toMatchObject({ startDate: "2026-11-23", endDate: "2026-11-23" });
		expect(g.calls.find((c) => c.path.includes("SummariesByDate"))!.query).toEqual({ startDate: "2026-11-17", endDate: "2026-11-23" });

		const calls = g.calls.length;
		expect((await runDailySummary(env, at("2026-11-24T08:45:00"), { garmin: g.client, fetch: tg.fetch })).outcome).toBe("already_sent");
		expect(g.calls).toHaveLength(calls);
		expect(tg.sent).toHaveLength(1);
	});

	it("at the last hour it sends without the sleep", async () => {
		const { env } = makeEnv();
		const tg = telegramFetch();
		const result = await runDailySummary(env, at("2026-11-24T11:00:00"), { garmin: garminFor("2026-11-24", { sleep: false }).client, fetch: tg.fetch });
		expect(result.outcome).toBe("sent");
		expect(tg.sent[0]!.body.text).toContain("Sleep</b>: not synced yet");
	});

	it("follows DAILY_SUMMARY_HOUR", async () => {
		const { env } = makeEnv({ DAILY_SUMMARY_HOUR: "6" });
		const tg = telegramFetch();
		expect((await runDailySummary(env, at("2026-11-24T06:00:00"), { garmin: garminFor("2026-11-24").client, fetch: tg.fetch })).outcome).toBe("sent");
		expect((await runDailySummary(env, at("2026-11-25T10:00:00"), { garmin: garminFor("2026-11-25").client, fetch: tg.fetch })).outcome).toBe(
			"outside_window",
		);
	});

	it("Mondays also fetch the last two weeks", async () => {
		const { env } = makeEnv();
		const g = garminFor("2026-11-23");
		const tg = telegramFetch();
		await runDailySummary(env, at("2026-11-23T08:00:00"), { garmin: g.client, fetch: tg.fetch });
		const v2 = g.calls.find((c) => c.path === "/usersummary-service/v2/dailysummaries");
		expect(v2?.query).toEqual({ startDate: "2026-11-09", endDate: "2026-11-22" });
		expect(tg.sent[0]!.body.text).toContain("<b>Last week</b> (16–22 November)");
	});

	it("a part that fails is named in the message; the rest still arrives", async () => {
		const { env } = makeEnv();
		const tg = telegramFetch();
		const result = await runDailySummary(env, at("2026-11-24T08:00:00"), {
			garmin: garminFor("2026-11-24", { fail: (p) => p.startsWith("/hrv-service") }).client,
			fetch: tg.fetch,
		});
		expect(result).toEqual({ outcome: "sent", telegramStatus: 200, partialErrors: ["hrv"] });
		expect(tg.sent[0]!.body.text).toContain("Couldn't read: HRV.");
		expect(tg.sent[0]!.body.text).toContain("Sleep</b>: 7 h 12 min");
	});

	it("when Garmin can't be reached at all, the last-hour message says so", async () => {
		const { env } = makeEnv();
		const tg = telegramFetch();
		const g = garminFor("2026-11-24", { fail: () => true });
		expect((await runDailySummary(env, at("2026-11-24T09:00:00"), { garmin: g.client, fetch: tg.fetch })).outcome).toBe("waiting_for_sleep");
		const result = await runDailySummary(env, at("2026-11-24T11:15:00"), { garmin: g.client, fetch: tg.fetch });
		expect(result).toMatchObject({ outcome: "sent", garminUnavailable: true });
		expect(tg.sent[0]!.body.text).toContain("Couldn't read your Garmin data");
	});

	it("a rejected Telegram request isn't retried that day; a server error is", async () => {
		for (const [status, retried] of [
			[401, false],
			[403, false],
			[429, true],
			[502, true],
		] as const) {
			const { env, kv } = makeEnv();
			const tg = telegramFetch(status);
			const result = await runDailySummary(env, at("2026-11-24T08:00:00"), { garmin: garminFor("2026-11-24").client, fetch: tg.fetch });
			expect(result.outcome, String(status)).toBe("send_failed");
			expect(result.telegramStatus).toBe(status);
			expect(kv.store.has(`${SENT_KEY_PREFIX}2026-11-24`), String(status)).toBe(!retried);
		}
	});

	it("a network error is retried on the next tick", async () => {
		const { env, kv } = makeEnv();
		const failing = vi.fn(async () => {
			throw new TypeError("fetch failed");
		}) as unknown as typeof fetch;
		const result = await runDailySummary(env, at("2026-11-24T08:00:00"), { garmin: garminFor("2026-11-24").client, fetch: failing });
		expect(result.outcome).toBe("send_failed");
		expect(result.telegramStatus).toBeUndefined();
		expect(kv.puts).toHaveLength(0);
	});

	it("uses the Garmin profile's zone when TIMEZONE is auto", async () => {
		const { env } = makeEnv({ TIMEZONE: "auto" });
		const g = fakeGarmin((path) => (path === "/userprofile-service/userprofile/settings" ? { timeZone: "America/New_York" } : null));
		// 13:15 UTC = 08:15 in New York: inside the window there, waiting for sleep.
		expect((await runDailySummary(env, new Date("2026-11-24T13:15:00Z"), { garmin: g.client })).outcome).toBe("waiting_for_sleep");
	});
});

describe("logDailySummary", () => {
	it("logs what happened, never dates, data, the token or the chat", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		logDailySummary({ outcome: "not_configured" });
		logDailySummary({ outcome: "outside_window" });
		logDailySummary({ outcome: "already_sent" });
		expect(spy).not.toHaveBeenCalled();
		logDailySummary({ outcome: "sent", telegramStatus: 200, partialErrors: ["hrv"] });
		logDailySummary({ outcome: "send_failed", telegramStatus: 401, garminUnavailable: true });
		expect(spy.mock.calls.map((c) => c[0])).toEqual([
			{ event: "daily_summary", outcome: "sent", telegramStatus: 200, partialErrors: ["hrv"] },
			{ event: "daily_summary", outcome: "send_failed", telegramStatus: 401, garminUnavailable: true },
		]);
	});

	it("a whole run logs nothing that identifies the user", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { env } = makeEnv();
		logDailySummary(await runDailySummary(env, at("2026-11-24T08:00:00"), { garmin: garminFor("2026-11-24").client, fetch: telegramFetch().fetch }));
		const text = JSON.stringify(spy.mock.calls);
		for (const secret of [TOKEN, CHAT, "2026-", "9812", "Morning"]) expect(text).not.toContain(secret);
	});
});
