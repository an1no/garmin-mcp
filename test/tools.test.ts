/**
 * Every tool, called through a real MCP client and server (in-memory transport) with a fake
 * Garmin client: checks the tool list, argument validation, how arguments become Garmin
 * requests, defaults that depend on "today", and how errors reach the model.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GarminApiError } from "../src/garmin";
import { CHART_APP_HTML, CHART_UI_URI, MCP_APP_MIME_TYPE } from "../src/chart-app";
import { CHART_META_KEY } from "../src/charts";
import { registerTools, SERVER_INFO, SERVER_INSTRUCTIONS, type ToolOptions } from "../src/tools";
import { fakeGarmin, spanDays } from "./helpers";

const ALL_TOOLS = [
	"get_activities",
	"get_activity_details",
	"get_daily_summary",
	"get_sleep_data",
	"get_hrv_data",
	"get_body_battery",
	"get_day_details",
	"get_vo2max",
	"get_weight",
	"get_trends",
	"get_fitness_profile",
	"get_nutrition",
];

type Handler = (path: string, query: Record<string, unknown>) => unknown;

async function connect(handler: Handler = () => [], zone = "UTC", options: ToolOptions = {}) {
	const garmin = fakeGarmin(handler);
	const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
	registerTools(server, { garmin: () => garmin.client, zone: async () => zone }, options);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: "test-client", version: "1.0.0" });
	await client.connect(clientTransport);

	/** Calls a tool; returns its text, whether it is an error, and the parsed JSON (when it isn't). */
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const result = (await client.callTool({ name, arguments: args })) as {
			isError?: boolean;
			content: { type: string; text: string }[];
		};
		const text = result.content[0]?.text ?? "";
		return { isError: result.isError === true, text, json: () => JSON.parse(text) as Record<string, any> };
	};
	return { garmin, client, call };
}

/** Freezes only the clock (timers keep working), so "today" is predictable. */
function freezeDate(iso: string) {
	vi.useFakeTimers({ toFake: ["Date"], now: new Date(iso) });
}
afterEach(() => vi.useRealTimers());

describe("server", () => {
	it("lists exactly the twelve tools, all read-only, with input schemas and descriptions", async () => {
		const { client } = await connect();
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name).sort()).toEqual([...ALL_TOOLS].sort());
		for (const tool of tools) {
			expect(tool.annotations, tool.name).toMatchObject({ readOnlyHint: true, destructiveHint: false });
			expect(tool.inputSchema.type, tool.name).toBe("object");
			expect(tool.description?.length, tool.name).toBeGreaterThan(40);
		}
	});

	it("introduces itself with instructions that point to the right tools", async () => {
		const { client } = await connect();
		expect(client.getServerVersion()).toMatchObject({ name: "garmin-connect", version: SERVER_INFO.version });
		const instructions = client.getInstructions() ?? "";
		for (const word of ["Read-only", "get_trends", "get_day_details", "get_activity_details"]) {
			expect(instructions).toContain(word);
		}
	});
});

describe("argument validation", () => {
	it.each([
		["get_activities", { limit: 101 }],
		["get_activities", { startDate: "2025/03/01" }],
		["get_activities", { sortBy: "pace" }],
		["get_activities", { area: { north: 95, south: 0, east: 0, west: 0 } }],
		["get_activity_details", { activityId: "abc" }],
		["get_body_battery", { chunks: 500 }],
		["get_day_details", { intervalMinutes: 2 }],
		["get_trends", { metrics: ["steps"] }],
		["get_trends", { period: "year" }],
		["get_fitness_profile", { date: "yesterday" }],
		["get_nutrition", { startDate: "2026-11-01T00:00" }],
	])("%s rejects %j without calling Garmin", async (name, args) => {
		const { call, garmin } = await connect();
		const result = await call(name, args);
		expect(result.isError).toBe(true);
		expect(garmin.calls).toHaveLength(0);
	});

	it("readable errors for ranges and dates that pass the schema but make no sense", async () => {
		const { call, garmin } = await connect();
		expect((await call("get_sleep_data", { startDate: "2025-01-01", endDate: "2025-03-01" })).text).toMatch(/at most 31 days/);
		expect((await call("get_daily_summary", { startDate: "2024-01-01", endDate: "2025-06-01" })).text).toMatch(/at most 366 days/);
		expect((await call("get_trends", { startDate: "2024-01-01", endDate: "2025-06-01" })).text).toMatch(/at most 366 days/);
		expect((await call("get_hrv_data", { startDate: "2025-03-05", endDate: "2025-03-01" })).text).toMatch(/on or before/);
		expect((await call("get_day_details", { date: "2025-02-30" })).text).toMatch(/valid date/);
		expect((await call("get_activities", { minDistance: 10000, maxDistance: 5000 })).text).toMatch(/Distance: the minimum/);
		expect((await call("get_activities", { area: { north: 10, south: 20, east: 0, west: 0 } })).text).toMatch(/area.south/);
		expect(garmin.calls).toHaveLength(0);
	});
});

describe("get_activities", () => {
	it("maps every filter to Garmin's parameter names", async () => {
		const { call, garmin } = await connect(() => []);
		await call("get_activities", {
			start: 20,
			limit: 10,
			startDate: "2025-01-01",
			endDate: "2025-12-31",
			activityType: "running",
			activitySubType: "trail_running",
			search: "park",
			sortBy: "distance",
			sortOrder: "asc",
			eventType: "race",
			minDistance: 5000,
			maxDistance: 50000,
			minDuration: 600,
			maxDuration: 7200,
			minElevation: 10,
			maxElevation: 500,
			minAvgPower: 150,
			favoritesOnly: true,
			area: { north: 41.8, south: 41.6, east: 44.9, west: 44.7 },
		});
		expect(garmin.calls).toHaveLength(1);
		expect(garmin.calls[0]!.path).toBe("/activitylist-service/activities/search/activities");
		expect(garmin.calls[0]!.query).toEqual({
			start: 20,
			limit: 10,
			startDate: "2025-01-01",
			endDate: "2025-12-31",
			activityType: "running",
			activitySubType: "trail_running",
			search: "park",
			sortBy: "distance",
			sortOrder: "asc",
			eventType: "race",
			minDistance: 5000,
			maxDistance: 50000,
			minDuration: 600,
			maxDuration: 7200,
			minElevation: 10,
			maxElevation: 500,
			minAvgPower: 150,
			favorite: 1,
			upperLatitude: 41.8,
			lowerLatitude: 41.6,
			rightLongitude: 44.9,
			leftLongitude: 44.7,
		});
	});

	it("defaults to the first 20 and reports hasMore when the page is full", async () => {
		const activity = (i: number) => ({ activityId: i, activityType: { typeKey: "running" }, distance: 1000 });
		const { call, garmin } = await connect((_p, q) => Array.from({ length: Number(q.limit) }, (_, i) => activity(i)));
		const r = (await call("get_activities")).json();
		expect(garmin.calls[0]!.query).toMatchObject({ start: 0, limit: 20, favorite: undefined, upperLatitude: undefined });
		expect(r).toMatchObject({ count: 20, start: 0, limit: 20, hasMore: true });
		expect(r.units).toMatchObject({ distance: "meters" });
		expect(r.activities[0]).toMatchObject({ activityId: 0, activityType: "running" });
	});
});

describe("single-resource tools", () => {
	it("get_activity_details: curated by default, raw on request", async () => {
		const payload = { activityId: 9, summaryDTO: { distance: 1000 }, extra: { x: 1 } };
		const { call, garmin } = await connect(() => payload);
		expect((await call("get_activity_details", { activityId: 9 })).json()).not.toHaveProperty("extra");
		expect((await call("get_activity_details", { activityId: "9", raw: true })).json()).toHaveProperty("extra");
		expect(garmin.calls.map((c) => c.path)).toEqual(["/activity-service/activity/9", "/activity-service/activity/9"]);
	});

	it("get_daily_summary: one day uses v1 (default today in the user's zone), a range uses v2", async () => {
		freezeDate("2026-11-25T21:30:00Z"); // already 26 November at UTC+4
		const { call, garmin } = await connect((path) => (path.includes("/v2/") ? { data: [{ calendarDate: "2026-11-20" }] } : null), "Indian/Mauritius");
		expect((await call("get_daily_summary")).json()).toEqual({ calendarDate: "2026-11-26", message: "No data for this date." });
		expect(garmin.calls[0]).toEqual({ path: "/usersummary-service/usersummary/daily", query: { calendarDate: "2026-11-26" } });
		const r = (await call("get_daily_summary", { startDate: "2026-11-20", endDate: "2026-11-25" })).json();
		expect(r).toMatchObject({ startDate: "2026-11-20", endDate: "2026-11-25", count: 1 });
		expect(garmin.calls[1]).toEqual({ path: "/usersummary-service/v2/dailysummaries", query: { startDate: "2026-11-20", endDate: "2026-11-25" } });
	});

	it("get_sleep_data: one night by date, a range by summaries", async () => {
		freezeDate("2026-11-25T08:00:00Z");
		const { call, garmin } = await connect((path) => (path.endsWith("dailySleep") ? { dailySleepDTO: { calendarDate: "2026-11-25", sleepTimeSeconds: 28800 } } : []));
		expect((await call("get_sleep_data")).json()).toMatchObject({ calendarDate: "2026-11-25", totalSleepHours: 8 });
		expect(garmin.calls[0]).toEqual({ path: "/sleep-service/sleep/dailySleep", query: { date: "2026-11-25" } });
		await call("get_sleep_data", { startDate: "2026-11-01", endDate: "2026-11-07" });
		expect(garmin.calls[1]).toEqual({
			path: "/sleep-service/sleep/dailySleepSummariesByDate",
			query: { startDate: "2026-11-01", endDate: "2026-11-07" },
		});
	});

	it("get_hrv_data: the last 7 days by default", async () => {
		freezeDate("2026-11-25T08:00:00Z");
		const { call, garmin } = await connect(() => ({ hrvSummaries: [] }));
		expect((await call("get_hrv_data")).json()).toMatchObject({ startDate: "2026-11-19", endDate: "2026-11-25", count: 0 });
		expect(garmin.calls[0]!.path).toBe("/hrv-service/hrv/daily/2026-11-19/2026-11-25");
	});

	it("get_body_battery: hourly chunks when the timeline is requested", async () => {
		freezeDate("2026-11-25T08:00:00Z");
		const { call, garmin } = await connect(() => []);
		await call("get_body_battery");
		await call("get_body_battery", { includeTimeline: true });
		await call("get_body_battery", { includeTimeline: true, chunks: 48 });
		expect(garmin.calls.map((c) => c.query)).toEqual([
			{ startDate: "2026-11-25", endDate: "2026-11-25", chunks: undefined },
			{ startDate: "2026-11-25", endDate: "2026-11-25", chunks: 24 },
			{ startDate: "2026-11-25", endDate: "2026-11-25", chunks: 48 },
		]);
	});

	it("get_day_details: today in the user's zone, all three parts, 15-minute intervals", async () => {
		freezeDate("2026-11-25T21:30:00Z");
		const { call, garmin } = await connect(() => ({}), "Indian/Mauritius");
		const r = (await call("get_day_details")).json();
		expect(r).toMatchObject({ date: "2026-11-26", timeZone: "Indian/Mauritius", intervalMinutes: 15 });
		expect(r.noData).toEqual(["heartRate", "hrv", "spo2"]);
		expect(garmin.calls.map((c) => c.path).sort()).toEqual([
			"/hrv-service/hrv/2026-11-26",
			"/wellness-service/wellness/daily/spo2acclimation/2026-11-26",
			"/wellness-service/wellness/dailyHeartRate",
		]);
	});
});

describe("get_activity_details with the planned workout", () => {
	const details = { activityId: 9, summaryDTO: { distance: 5000 } };
	const workout = { workoutName: "Tempo", sport: "RUNNING", steps: [{ stepIndex: 0, durationType: "TIME", durationValue: 600 }] };

	it("adds plannedWorkouts only when asked, fetching both in parallel", async () => {
		const { call, garmin } = await connect((path) => (path.endsWith("/workouts") ? [workout] : details));
		expect((await call("get_activity_details", { activityId: 9 })).json()).not.toHaveProperty("plannedWorkouts");
		expect(garmin.calls).toHaveLength(1);
		const r = (await call("get_activity_details", { activityId: 9, includeWorkout: true })).json();
		expect(r.plannedWorkouts).toEqual([{ name: "Tempo", sport: "RUNNING", steps: [{ step: 0, ends: "10:00" }] }]);
		expect(garmin.calls.map((c) => c.path).slice(1).sort()).toEqual(["/activity-service/activity/9", "/activity-service/activity/9/workouts"]);
	});

	it("says so when no workout was followed (404)", async () => {
		const { call } = await connect((path) => {
			if (path.endsWith("/workouts")) throw new GarminApiError("Not found", 404, path);
			return details;
		});
		const r = (await call("get_activity_details", { activityId: 9, includeWorkout: true })).json();
		expect(r.plannedWorkout).toMatch(/didn.t follow a planned workout/);
		expect(r.summary).toMatchObject({ distance: 5000 });
	});

	it("still returns the details when only the workout request fails", async () => {
		const { call } = await connect((path) => {
			if (path.endsWith("/workouts")) throw new GarminApiError("Rate limited by Garmin - wait a bit and try again.", 429, path);
			return details;
		});
		const result = await call("get_activity_details", { activityId: 9, includeWorkout: true });
		expect(result.isError).toBe(false);
		expect(result.json().plannedWorkoutError).toMatch(/Rate limited/);
	});
});

describe("get_trends metrics", () => {
	it("VO2 max and weight only when asked for", async () => {
		freezeDate("2026-11-25T08:00:00Z");
		const { call, garmin } = await connect((path) => (path.startsWith("/usersummary") ? { data: [] } : path.startsWith("/hrv") ? {} : []));
		await call("get_trends");
		expect(garmin.calls.some((c) => c.path.includes("/maxmet/") || c.path.includes("/weight/"))).toBe(false);
		garmin.calls.length = 0;
		const r = (await call("get_trends", { metrics: ["vo2max", "weight"] })).json();
		expect(garmin.calls.some((c) => c.path.includes("/maxmet/"))).toBe(true);
		expect(garmin.calls.some((c) => c.path.includes("/weight-service/weight/all/"))).toBe(true);
		expect(garmin.calls.some((c) => c.path.startsWith("/sleep-service"))).toBe(false);
		expect(r.units).toMatchObject({ vo2max: "ml/kg/min" });
	});
});

describe("fitness profile and nutrition", () => {
	it("get_fitness_profile: today in the user's zone, both parts", async () => {
		freezeDate("2026-11-25T21:30:00Z");
		const { call, garmin } = await connect((path) => (path.startsWith("/fitnessage") ? [{ fitnessAge: 30.04 }] : []), "Indian/Mauritius");
		const r = (await call("get_fitness_profile")).json();
		expect(r).toMatchObject({ date: "2026-11-26", fitnessAge: { fitnessAge: 30 }, noData: ["heartRateZones"] });
		expect(garmin.calls.map((c) => c.path).sort()).toEqual(["/biometric-service/heartRateZones/v2", "/fitnessage-service/fitnessage/v2/2026-11-26"]);
	});

	it("get_nutrition: today by default, a range day by day, at most 14 days", async () => {
		freezeDate("2026-11-25T08:00:00Z");
		const { call, garmin } = await connect(() => null);
		expect((await call("get_nutrition")).json()).toMatchObject({ date: "2026-11-25", logged: false });
		expect(garmin.calls[0]).toEqual({ path: "/nutrition-service/food/logs/2026-11-25", query: { includeMedia: false } });

		const week = (await call("get_nutrition", { startDate: "2026-11-19", endDate: "2026-11-25" })).json();
		expect(week).toMatchObject({ startDate: "2026-11-19", endDate: "2026-11-25", daysLogged: 0 });
		expect(garmin.calls).toHaveLength(1 + 7);

		const tooLong = await call("get_nutrition", { startDate: "2026-11-01", endDate: "2026-11-25" });
		expect(tooLong.isError).toBe(true);
		expect(tooLong.text).toMatch(/at most 14 days/);
		expect(garmin.calls).toHaveLength(8);
	});
});

describe("range tools", () => {
	it("get_vo2max: the last 365 days by default", async () => {
		freezeDate("2026-11-25T08:00:00Z");
		const { call, garmin } = await connect(() => []);
		const r = (await call("get_vo2max")).json();
		expect(r).toMatchObject({ startDate: "2025-11-26", endDate: "2026-11-25" });
		expect(spanDays(r.startDate, r.endDate)).toBe(365);
		expect(garmin.calls).toHaveLength(14);
	});

	it("get_weight: the last 90 days by default", async () => {
		freezeDate("2026-11-25T08:00:00Z");
		const { call } = await connect(() => ({}));
		const r = (await call("get_weight")).json();
		expect(spanDays(r.startDate, r.endDate)).toBe(90);
		expect(r.endDate).toBe("2026-11-25");
		expect(r.measuredDays).toBe(0);
	});

	it("get_trends: 12 weeks by default, months for long ranges, metrics de-duplicated", async () => {
		freezeDate("2026-11-25T08:00:00Z");
		const { call, garmin } = await connect((path) => (path.startsWith("/usersummary") ? { data: [] } : path.startsWith("/hrv") ? {} : []));
		const weekly = (await call("get_trends", { metrics: ["sleep"] })).json();
		expect(spanDays(weekly.startDate, weekly.endDate)).toBe(84);
		expect(weekly.groupedBy).toMatch(/^week/);

		const monthly = (await call("get_trends", { startDate: "2026-01-01", endDate: "2026-06-30", metrics: ["daily", "daily"] })).json();
		expect(monthly.groupedBy).toBe("month");
		expect(monthly.periods).toHaveLength(6);
		expect(garmin.calls.filter((c) => c.path.startsWith("/usersummary"))).toHaveLength(1); // 181 days = one chunk
	});
});

describe("errors reach the model as readable tool errors", () => {
	it.each([
		[new GarminApiError("Garmin API 429 on /x. Rate limited by Garmin - wait a bit and try again.", 429, "/x"), /Rate limited/],
		[Object.assign(new Error("The operation timed out."), { name: "TimeoutError" }), /did not respond in time/],
		[new Error("something odd"), /Unexpected error: something odd/],
	])("%s", async (error, message) => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { call } = await connect(() => {
			throw error;
		});
		const result = await call("get_activity_details", { activityId: 1 });
		expect(result.isError).toBe(true);
		expect(result.text).toMatch(message);
		spy.mockRestore();
	});
});

describe("logging", () => {
	const ALLOWED_KEYS = ["event", "tool", "ok", "durationMs", "errorKind", "garminStatus", "partialErrors"];
	const toolLogs = (spy: { mock: { calls: unknown[][] } }) =>
		spy.mock.calls.map((args) => args[0] as Record<string, unknown>).filter((e) => e?.event === "tool_call");

	it("one line per call: tool, outcome and duration only, never arguments or data", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { call } = await connect(() => ({ activityId: 24681281056, activityName: "Secret Morning Run", summaryDTO: { distance: 5075 } }));
		await call("get_activity_details", { activityId: 24681281056 });
		const logs = toolLogs(spy);
		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatchObject({ event: "tool_call", tool: "get_activity_details", ok: true });
		expect(typeof logs[0]!.durationMs).toBe("number");
		for (const key of Object.keys(logs[0]!)) expect(ALLOWED_KEYS).toContain(key);
		const everything = JSON.stringify(spy.mock.calls);
		for (const secret of ["24681281056", "Secret Morning Run", "5075"]) expect(everything).not.toContain(secret);
	});

	it.each([
		[new GarminApiError("Garmin API 429 ...", 429, "/x"), { errorKind: "garmin", garminStatus: 429 }],
		[new RangeError("startDate must be a valid date"), { errorKind: "invalid_input" }],
		[Object.assign(new Error("timed out"), { name: "TimeoutError" }), { errorKind: "timeout" }],
		[new Error("boom"), { errorKind: "unexpected" }],
	])("failures are logged with their kind (%s)", async (error, expected) => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { call } = await connect(() => {
			throw error;
		});
		await call("get_activity_details", { activityId: 1 });
		expect(toolLogs(spy)).toEqual([expect.objectContaining({ tool: "get_activity_details", ok: false, ...expected })]);
	});

	it("partial failures inside a successful result are named", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { call } = await connect((path) => {
			if (path.endsWith("/workouts") || path.startsWith("/hrv-service")) throw new GarminApiError("Rate limited", 429, path);
			if (path.startsWith("/sleep-service")) return [];
			return { activityId: 1 };
		});
		await call("get_activity_details", { activityId: 1, includeWorkout: true });
		await call("get_trends", { startDate: "2026-11-01", endDate: "2026-11-07", metrics: ["sleep", "hrv"] });
		expect(toolLogs(spy)).toEqual([
			expect.objectContaining({ tool: "get_activity_details", ok: true, partialErrors: ["plannedWorkout"] }),
			expect.objectContaining({ tool: "get_trends", ok: true, partialErrors: ["hrv"] }),
		]);
	});

	it("calls rejected by the schema never reach the tool, so they aren't logged as tool calls", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { call } = await connect();
		await call("get_activities", { limit: 1000 });
		expect(toolLogs(spy)).toEqual([]);
	});
});

describe("charts (MCP Apps)", () => {
	const rawCall = async (client: Client, name: string, args: Record<string, unknown>) =>
		(await client.callTool({ name, arguments: args })) as {
			isError?: boolean;
			content: { type: string; text: string }[];
			_meta?: Record<string, unknown>;
		};

	it("only get_trends and get_day_details point to the chart app", async () => {
		const { client } = await connect();
		const { tools } = await client.listTools();
		const withUi = tools.filter((t) => (t._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri);
		expect(withUi.map((t) => t.name).sort()).toEqual(["get_day_details", "get_trends"]);
		for (const t of withUi) expect((t._meta as { ui: { resourceUri: string } }).ui.resourceUri).toBe(CHART_UI_URI);
	});

	it("serves the app as an MCP Apps resource", async () => {
		const { client } = await connect();
		const { resources } = await client.listResources();
		expect(resources).toEqual([expect.objectContaining({ uri: CHART_UI_URI, mimeType: MCP_APP_MIME_TYPE })]);
		const read = await client.readResource({ uri: CHART_UI_URI });
		expect(read.contents[0]).toMatchObject({ uri: CHART_UI_URI, mimeType: MCP_APP_MIME_TYPE, text: CHART_APP_HTML });
	});

	it("get_trends: the chart rides in _meta, the text the model reads is unchanged", async () => {
		const { client } = await connect((path, query) =>
			path.startsWith("/sleep-service")
				? [
						{ calendarDate: String(query.startDate), sleepTimeSeconds: 7 * 3600 },
						{ calendarDate: String(query.endDate), sleepTimeSeconds: 8 * 3600 },
					]
				: [],
		);
		const result = await rawCall(client, "get_trends", { startDate: "2026-01-01", endDate: "2026-02-28", period: "month", metrics: ["sleep"] });
		const charts = result._meta?.[CHART_META_KEY];
		expect(typeof charts).toBe("string");
		expect(charts as string).toContain('<figure class="chart">');
		const data = JSON.parse(result.content[0]!.text);
		expect(data.periods).toHaveLength(2);
		expect(result.content[0]!.text).not.toContain("<svg");
	});

	it("no chart when there's nothing to plot, and none on errors", async () => {
		const empty = await connect(() => []);
		const r1 = await rawCall(empty.client, "get_trends", { startDate: "2026-01-01", endDate: "2026-02-28", metrics: ["sleep"] });
		expect(r1._meta?.[CHART_META_KEY]).toBeUndefined();

		const failing = await connect((path) => {
			throw new GarminApiError("Rate limited", 429, path);
		});
		const r2 = await rawCall(failing.client, "get_day_details", { date: "2026-11-25" });
		expect(r2.isError).toBe(true);
		expect(r2._meta?.[CHART_META_KEY]).toBeUndefined();
	});
});

describe("get_menstrual_cycle (opt-in)", () => {
	it("isn't offered unless the deployment turns it on", async () => {
		const off = await connect();
		expect((await off.client.listTools()).tools.map((x) => x.name)).not.toContain("get_menstrual_cycle");
		const on = await connect(() => ({}), "UTC", { cycleTracking: true });
		const names = (await on.client.listTools()).tools.map((x) => x.name);
		expect(names).toContain("get_menstrual_cycle");
		expect(names).toHaveLength(13);
	});

	it("today in the user's zone, with today as Garmin's reference date", async () => {
		freezeDate("2026-11-25T21:30:00Z");
		const { call, garmin } = await connect(() => ({ daySummary: { dayInCycle: 3 } }), "Indian/Mauritius", { cycleTracking: true });
		const r = (await call("get_menstrual_cycle")).json();
		expect(r).toMatchObject({ date: "2026-11-26", cycle: { dayInCycle: 3 } });
		expect(garmin.calls[0]).toEqual({
			path: "/periodichealth-service/menstrualcycle/dayview/2026-11-26",
			query: { todayDate: "2026-11-26", skipbm: true, includeAnalysis: false },
		});
		await call("get_menstrual_cycle", { date: "2026-11-01" });
		expect(garmin.calls[1]!.query).toMatchObject({ todayDate: "2026-11-26" });
	});
});
