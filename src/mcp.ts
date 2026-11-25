import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GarminApiError, GarminClient } from "./garmin";
import {
	ACTIVITY_UNITS,
	addDays,
	assertDate,
	resolveRange,
	shapeActivityDetails,
	summarizeActivity,
	summarizeBodyBattery,
	summarizeDailySummary,
	summarizeDailySummaryV2,
	summarizeHrv,
	summarizeSleep,
	todayIn,
} from "./format";
import { collectTrends, TREND_MAX_DAYS, TREND_METRICS } from "./trends";

/** Props stored in the OAuth grant by the /authorize handler (see auth-handler.ts). */
export type AuthProps = {
	user: string;
	authorizedAt: string;
};

const date = (what: string) =>
	z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
		.describe(what);

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

/**
 * One Durable Object instance per MCP session. Tools call the Garmin Connect Personal API
 * using the API key stored as the GARMIN_PERSONAL_API_KEY secret.
 */
export class GarminMCP extends McpAgent<Env, Record<string, never>, AuthProps> {
	server = new McpServer(
		{ name: "garmin-connect", version: "1.1.0" },
		{
			instructions:
				"Read-only access to the owner's Garmin Connect data (activities, daily health stats, sleep, HRV, Body Battery). " +
				"Dates are YYYY-MM-DD calendar dates in the user's local time. Distances are meters, durations seconds, speeds m/s " +
				"unless a field name says otherwise. Use get_activities to find activityIds, then get_activity_details for one workout. " +
				"For questions about longer periods (trends, averages, totals, comparing weeks or months) use get_trends, which " +
				"summarizes up to a year per call, instead of fetching day-by-day data.",
		},
	);

	private client?: GarminClient;

	private garmin(): GarminClient {
		this.client ??= new GarminClient(this.env.GARMIN_PERSONAL_API_KEY, this.env.OAUTH_KV);
		return this.client;
	}

	private today(): string {
		return todayIn(this.env.TIMEZONE);
	}

	async init(): Promise<void> {
		// ------------------------------------------------------------------ activities
		this.server.registerTool(
			"get_activities",
			{
				title: "List Garmin activities",
				description:
					"Search the user's Garmin activities (runs, rides, swims, workouts...), newest first by default. " +
					"Returns concise summaries: activityId, activityName, activityType, eventType, startTimeLocal, locationName, " +
					"distance (m), duration (s), elevationGain (m), averageHR, maxHR, averageSpeed (m/s). Use the activityId with " +
					"get_activity_details. Filters can be combined, e.g. the longest runs (activityType=running, sortBy=distance), " +
					"races only (eventType=race), rides over 50 km (minDistance=50000) or activities that started in an area. " +
					"For totals over long periods, prefer get_trends.",
				inputSchema: {
					start: z.number().int().min(0).default(0).describe("Zero-based offset for pagination (default 0)."),
					limit: z.number().int().min(1).max(100).default(20).describe("Max activities to return, 1-100 (default 20)."),
					startDate: date("Earliest activity start date (inclusive), YYYY-MM-DD, local time.").optional(),
					endDate: date("Latest activity start date (inclusive), YYYY-MM-DD, local time.").optional(),
					activityType: z
						.string()
						.min(1)
						.max(64)
						.describe(
							"Parent activity type key, e.g. running, cycling, swimming, walking, hiking, fitness_equipment, other.",
						)
						.optional(),
					activitySubType: z
						.string()
						.min(1)
						.max(64)
						.describe("Activity subtype key, e.g. trail_running, road_biking, mountain_biking, indoor_cycling, lap_swimming.")
						.optional(),
					search: z.string().min(1).max(200).describe("Text to search for in activity names and descriptions.").optional(),
					sortBy: z
						.enum(["startLocal", "distance", "duration", "name"])
						.describe("Field to sort by. Defaults to startLocal (start time).")
						.optional(),
					sortOrder: z.enum(["desc", "asc"]).describe("Sort direction. Defaults to desc (newest / largest first).").optional(),
					eventType: z
						.enum(["race", "training", "recreation", "fitness", "specialEvent", "uncategorized"])
						.describe("Only activities with this event type, e.g. race.")
						.optional(),
					minDistance: z.number().min(0).describe("Minimum distance in meters (10 km = 10000).").optional(),
					maxDistance: z.number().min(0).describe("Maximum distance in meters.").optional(),
					minDuration: z.number().min(0).describe("Minimum timer duration in seconds (1 hour = 3600).").optional(),
					maxDuration: z.number().min(0).describe("Maximum timer duration in seconds.").optional(),
					minElevation: z.number().min(0).describe("Minimum total elevation gain in meters.").optional(),
					maxElevation: z.number().min(0).describe("Maximum total elevation gain in meters.").optional(),
					minAvgPower: z.number().min(0).describe("Minimum average power in watts.").optional(),
					favoritesOnly: z.boolean().describe("Only activities marked as favorites.").optional(),
					area: z
						.object({
							north: z.number().min(-90).max(90).describe("Northern latitude, decimal degrees."),
							south: z.number().min(-90).max(90).describe("Southern latitude, decimal degrees."),
							east: z.number().min(-180).max(180).describe("Eastern longitude, decimal degrees."),
							west: z.number().min(-180).max(180).describe("Western longitude, decimal degrees."),
						})
						.describe("Only activities that started inside this bounding box, e.g. a city.")
						.optional(),
				},
				annotations: { title: "List Garmin activities", ...READ_ONLY },
			},
			async ({ start, limit, startDate, endDate, activityType, activitySubType, search, area, favoritesOnly, ...filters }) =>
				run(async () => {
					if (startDate) assertDate(startDate, "startDate");
					if (endDate) assertDate(endDate, "endDate");
					assertMinMax(filters.minDistance, filters.maxDistance, "Distance");
					assertMinMax(filters.minDuration, filters.maxDuration, "Duration");
					assertMinMax(filters.minElevation, filters.maxElevation, "Elevation");
					if (area && area.south > area.north) throw new RangeError("area.south must not be north of area.north.");
					const result = await this.garmin().get<unknown[]>("/activitylist-service/activities/search/activities", {
						start,
						limit,
						startDate,
						endDate,
						activityType,
						activitySubType,
						search,
						...filters,
						favorite: favoritesOnly === undefined ? undefined : favoritesOnly ? 1 : -1,
						upperLatitude: area?.north,
						lowerLatitude: area?.south,
						rightLongitude: area?.east,
						leftLongitude: area?.west,
					});
					const activities = (Array.isArray(result) ? result : []).map(summarizeActivity);
					return {
						count: activities.length,
						start,
						limit,
						hasMore: activities.length === limit,
						units: ACTIVITY_UNITS,
						activities,
					};
				}),
		);

		this.server.registerTool(
			"get_activity_details",
			{
				title: "Get Garmin activity details",
				description:
					"Detailed metrics for one activity (workout/ride/run): distance, moving/elapsed time, speed, heart rate, power, " +
					"cadence, elevation, training effect & load, temperature, plus split/lap summaries. " +
					"Set raw=true for the complete unfiltered Garmin payload.",
				inputSchema: {
					activityId: z
						.union([z.number().int().positive(), z.string().regex(/^\d+$/, "Numeric activityId")])
						.describe("The activityId returned by get_activities."),
					raw: z.boolean().default(false).describe("Return the full Garmin payload instead of the curated summary."),
				},
				annotations: { title: "Get Garmin activity details", ...READ_ONLY },
			},
			async ({ activityId, raw }) =>
				run(async () => {
					const id = String(activityId);
					const result = await this.garmin().get(`/activity-service/activity/${encodeURIComponent(id)}`);
					return shapeActivityDetails(result, raw);
				}),
		);

		// ------------------------------------------------------------------ daily summary
		this.server.registerTool(
			"get_daily_summary",
			{
				title: "Get Garmin daily health summary",
				description:
					"Daily health stats: steps, distance, calories, resting/min/max heart rate, stress, Body Battery, intensity minutes, " +
					"floors, SpO2, respiration, hydration. Pass `date` for one day (defaults to today), or startDate+endDate for a range " +
					"(up to 366 days).",
				inputSchema: {
					date: date("Single calendar date, YYYY-MM-DD. Defaults to today.").optional(),
					startDate: date("Range start (inclusive), YYYY-MM-DD. Use with endDate instead of date.").optional(),
					endDate: date("Range end (inclusive), YYYY-MM-DD.").optional(),
				},
				annotations: { title: "Get Garmin daily health summary", ...READ_ONLY },
			},
			async ({ date: day, startDate, endDate }) =>
				run(async () => {
					if (startDate || endDate) {
						const range = resolveRange(startDate, endDate, { today: this.today(), defaultDays: 1, maxDays: 366 });
						const result = await this.garmin().get<{ data?: unknown[] }>("/usersummary-service/v2/dailysummaries", range);
						const days = (result?.data ?? []).map(summarizeDailySummaryV2);
						return { ...range, count: days.length, days };
					}
					const calendarDate = day ?? this.today();
					assertDate(calendarDate, "date");
					const result = await this.garmin().get("/usersummary-service/usersummary/daily", { calendarDate });
					return result ? summarizeDailySummary(result) : { calendarDate, message: "No data for this date." };
				}),
		);

		// ------------------------------------------------------------------ sleep
		this.server.registerTool(
			"get_sleep_data",
			{
				title: "Get Garmin sleep data",
				description:
					"Sleep for a night (the calendar date you woke up): total sleep, deep/light/REM/awake stage durations, sleep score " +
					"and sub-scores, average overnight heart rate, stress, SpO2, respiration and sleep need. Pass `date` for one night " +
					"(defaults to today) or startDate+endDate for a range (up to 31 days).",
				inputSchema: {
					date: date("Calendar date of the wake-up morning, YYYY-MM-DD. Defaults to today.").optional(),
					startDate: date("Range start (inclusive), YYYY-MM-DD. Use with endDate instead of date.").optional(),
					endDate: date("Range end (inclusive), YYYY-MM-DD.").optional(),
				},
				annotations: { title: "Get Garmin sleep data", ...READ_ONLY },
			},
			async ({ date: day, startDate, endDate }) =>
				run(async () => {
					if (startDate || endDate) {
						const range = resolveRange(startDate, endDate, { today: this.today(), defaultDays: 1, maxDays: 31 });
						const result = await this.garmin().get<unknown[]>("/sleep-service/sleep/dailySleepSummariesByDate", range);
						const nights = (Array.isArray(result) ? result : []).map(summarizeSleep);
						return { ...range, count: nights.length, units: { stages: "seconds" }, nights };
					}
					const calendarDate = day ?? this.today();
					assertDate(calendarDate, "date");
					const result = await this.garmin().get("/sleep-service/sleep/dailySleep", { date: calendarDate });
					return result ? summarizeSleep(result) : { calendarDate, message: "No sleep recorded for this date." };
				}),
		);

		// ------------------------------------------------------------------ HRV
		this.server.registerTool(
			"get_hrv_data",
			{
				title: "Get Garmin HRV status",
				description:
					"Daily heart-rate-variability summaries: last-night average and 5-min high (ms), 7-day average, HRV status " +
					"(e.g. BALANCED, UNBALANCED, LOW) and the personal baseline range. Defaults to the last 7 days.",
				inputSchema: {
					startDate: date("Range start (inclusive), YYYY-MM-DD. Defaults to 6 days before endDate.").optional(),
					endDate: date("Range end (inclusive), YYYY-MM-DD. Defaults to today.").optional(),
				},
				annotations: { title: "Get Garmin HRV status", ...READ_ONLY },
			},
			async ({ startDate, endDate }) =>
				run(async () => {
					const today = this.today();
					const end = endDate ?? today;
					const range = resolveRange(startDate ?? addDays(end, -6), end, { today, defaultDays: 7, maxDays: 366 });
					const result = await this.garmin().get(
						`/hrv-service/hrv/daily/${range.startDate}/${range.endDate}`,
					);
					const days = summarizeHrv(result);
					return { ...range, units: { hrv: "milliseconds" }, count: days.length, days };
				}),
		);

		// ------------------------------------------------------------------ Body Battery
		this.server.registerTool(
			"get_body_battery",
			{
				title: "Get Garmin Body Battery",
				description:
					"Daily Body Battery reports: energy charged/drained, start/end/highest/lowest level (0-100) and the events that " +
					"moved it (sleep, activities, stress, recovery). Defaults to today; ranges up to 31 days. " +
					"Set includeTimeline=true for the level readings through the day.",
				inputSchema: {
					startDate: date("Range start (inclusive), YYYY-MM-DD. Defaults to today.").optional(),
					endDate: date("Range end (inclusive), YYYY-MM-DD. Defaults to startDate.").optional(),
					includeTimeline: z.boolean().default(false).describe("Include the intraday level timeline."),
					chunks: z
						.number()
						.int()
						.min(1)
						.max(96)
						.describe(
							"Number of intervals each day is divided into for the timeline (Garmin returns the low and high reading " +
								"of each). Only used with includeTimeline; e.g. 24 = hourly.",
						)
						.optional(),
				},
				annotations: { title: "Get Garmin Body Battery", ...READ_ONLY },
			},
			async ({ startDate, endDate, includeTimeline, chunks }) =>
				run(async () => {
					const range = resolveRange(startDate, endDate, { today: this.today(), defaultDays: 1, maxDays: 31 });
					const result = await this.garmin().get<unknown[]>("/wellness-service/wellness/bodyBattery/reports/daily", {
						...range,
						chunks: includeTimeline ? (chunks ?? 24) : chunks,
					});
					const days = (Array.isArray(result) ? result : []).map((r) => summarizeBodyBattery(r, includeTimeline));
					return { ...range, count: days.length, days };
				}),
		);

		// ------------------------------------------------------------------ trends
		this.server.registerTool(
			"get_trends",
			{
				title: "Get Garmin trends",
				description:
					"Weekly or monthly statistics over up to a year, computed on the server in one call. Sleep: nights, average " +
					"hours and stage minutes, sleep score (avg/min/max), best and worst night. Daily: steps (total/avg/best day), " +
					"distance, resting heart rate (avg/min/max), stress, Body Battery, intensity minutes. HRV: average/min/max, " +
					"latest status, status counts. Activities: count, distance, time, elevation and calories, per type, plus the " +
					"longest. Each period row and an `overall` block cover the whole range. Use this for trends, averages, totals " +
					"and comparisons (e.g. 'how did my sleep change this year?', 'how far did I run in 2025?', 'compare March " +
					"and April') instead of fetching day-by-day data.",
				inputSchema: {
					startDate: date("Range start (inclusive), YYYY-MM-DD. Defaults to 12 weeks before endDate.").optional(),
					endDate: date("Range end (inclusive), YYYY-MM-DD. Defaults to today.").optional(),
					period: z
						.enum(["week", "month"])
						.describe("Group by week (Monday start) or calendar month. Defaults to week up to 92 days, month beyond.")
						.optional(),
					metrics: z
						.array(z.enum(TREND_METRICS))
						.min(1)
						.describe("Which data to include: sleep, daily, hrv, activities. Defaults to all four.")
						.optional(),
					activityType: z
						.string()
						.min(1)
						.max(64)
						.describe("Limit the activity statistics to one parent type key, e.g. running or cycling.")
						.optional(),
				},
				annotations: { title: "Get Garmin trends", ...READ_ONLY },
			},
			async ({ startDate, endDate, period, metrics, activityType }) =>
				run(async () => {
					const today = this.today();
					const end = endDate ?? today;
					if (endDate) assertDate(endDate, "endDate");
					const range = resolveRange(startDate ?? addDays(end, -83), end, {
						today,
						defaultDays: 84,
						maxDays: TREND_MAX_DAYS,
					});
					const days = (Date.parse(range.endDate) - Date.parse(range.startDate)) / 86_400_000 + 1;
					return collectTrends(this.garmin(), {
						...range,
						period: period ?? (days <= 92 ? "week" : "month"),
						metrics: [...new Set(metrics ?? TREND_METRICS)],
						activityType,
					});
				}),
		);
	}
}

/** Throws a readable error when a min/max filter pair is inverted. */
function assertMinMax(min: number | undefined, max: number | undefined, name: string): void {
	if (min !== undefined && max !== undefined && min > max) {
		throw new RangeError(`${name}: the minimum (${min}) is larger than the maximum (${max}).`);
	}
}

/** Runs a tool body and converts its result (or error) into an MCP tool result. */
async function run(body: () => Promise<unknown>): Promise<CallToolResult> {
	try {
		const data = await body();
		return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
	} catch (error) {
		let message: string;
		if (error instanceof GarminApiError || error instanceof RangeError) {
			message = error.message;
		} else if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
			message = "Garmin did not respond in time. Please try again.";
		} else {
			console.error("Unexpected tool error", error);
			message = `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
		}
		return { isError: true, content: [{ type: "text", text: message }] };
	}
}
