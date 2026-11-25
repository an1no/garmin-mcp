/**
 * The morning summary's cron handler inside a local workerd: Garmin and Telegram are answered by
 * MSW, KV lives in Miniflare, and the Telegram secrets are the test values from vitest.config.ts.
 */
import { exports } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { network } from "./network";

const GARMIN = "https://personal.connectapi.garmin.com";
const TELEGRAM_TOKEN = "123456789:e2e-test-telegram-token-not-real-xx"; // matches vitest.config.ts

type Scheduled = { scheduled(options: { scheduledTime: number; cron: string }): Promise<{ outcome: string }> };
const worker = () => (exports as unknown as { default: Scheduled }).default;
const tick = (iso: string) => worker().scheduled({ scheduledTime: Date.parse(iso), cron: "*/15 * * * *" });

let garminPaths: string[] = [];
let messages: { url: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
	garminPaths = [];
	messages = [];
	network.use(
		http.post(`${GARMIN}/personalapitoken-service/personal-api/personal-api-key/token`, () =>
			HttpResponse.json({ access_token: "e2e-garmin-access-token", expires_in: 86400 }),
		),
		http.get(`${GARMIN}/*`, ({ request }) => {
			const url = new URL(request.url);
			garminPaths.push(url.pathname);
			if (url.pathname === "/sleep-service/sleep/dailySleep") {
				return HttpResponse.json({
					dailySleepDTO: { calendarDate: url.searchParams.get("date"), sleepTimeSeconds: 27000, sleepScores: { overall: { value: 84, qualifierKey: "GOOD" } } },
				});
			}
			if (url.pathname === "/usersummary-service/usersummary/daily") {
				return HttpResponse.json({ calendarDate: url.searchParams.get("calendarDate"), totalSteps: 10234, restingHeartRate: 52 });
			}
			if (url.pathname.startsWith("/hrv-service/")) return HttpResponse.json({ hrvSummaries: [{ lastNightAvg: 51, status: "BALANCED" }] });
			return HttpResponse.json([]);
		}),
		http.post("https://api.telegram.org/*", async ({ request }) => {
			messages.push({ url: request.url, body: (await request.json()) as Record<string, unknown> });
			return HttpResponse.json({ ok: true, result: {} });
		}),
	);
});

describe("morning summary (cron)", () => {
	it("before the start hour, nothing is fetched or sent", async () => {
		await tick("2026-11-10T07:45:00Z");
		expect(garminPaths).toEqual([]);
		expect(messages).toEqual([]);
	});

	it("sends one message for the day through Telegram, then stops", async () => {
		await tick("2026-11-10T08:15:00Z");
		expect(messages).toHaveLength(1);
		expect(messages[0]!.url).toBe(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`);
		expect(messages[0]!.body).toMatchObject({ chat_id: "424242", parse_mode: "HTML" });
		const text = String(messages[0]!.body.text);
		expect(text).toContain("<b>Good morning! Tuesday, 10 November</b>");
		expect(text).toContain("😴 <b>Sleep</b>: 7 h 30 min, score 84 (good)");
		expect(text).toContain("💓 <b>HRV</b>: 51 ms, balanced");
		expect(text).toContain("❤️ <b>Resting heart rate</b>: 52 bpm");
		expect(text).toContain("👟 10,234 steps");

		garminPaths = [];
		await tick("2026-11-10T08:30:00Z");
		expect(messages).toHaveLength(1);
		expect(garminPaths).toEqual([]);
	});
});
