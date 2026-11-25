/**
 * The MCP tools, registered on a McpServer. Kept apart from the Durable Object class (mcp.ts)
 * so the tests can run every tool through a real MCP client with a fake Garmin client.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { fetchFitnessProfile, fetchVo2Max, fetchWeight } from "./fitness";
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
import { GarminApiError, type GarminClient } from "./garmin";
import { DAY_DETAIL_PARTS, fetchDayDetails } from "./intraday";
import { fetchNutrition, NUTRITION_MAX_DAYS } from "./nutrition";
import { collectTrends, TREND_MAX_DAYS, TREND_METRICS } from "./trends";

export const SERVER_INFO = { name: "garmin-connect", version: "1.4.0" } as const;

export const SERVER_INSTRUCTIONS =
	"Read-only access to the owner's Garmin Connect data (activities, daily health stats, sleep, HRV, Body Battery, " +
	"VO2 max, weight and body composition, Fitness Age, heart rate zones, logged food). Dates are YYYY-MM-DD calendar dates in the user's local time; when a " +
	"date is omitted, 'today' follows the timezone in the user's Garmin profile. Distances are meters, durations seconds, speeds m/s " +
	"unless a field name says otherwise. Use get_activities to find activityIds, then get_activity_details for one workout. " +
	"For questions about longer periods (trends, averages, totals, comparing weeks or months) use get_trends, which " +
	"summarizes up to a year per call, instead of fetching day-by-day data. For heart rate through a single day, " +
	"the overnight HRV readings or SpO2 of one night, use get_day_details.";

/** What the tools need from their host: the Garmin client and the user's timezone. */
export interface ToolContext {
	garmin(): GarminClient;
	/** IANA timezone that decides what "today" means. */
	zone(): Promise<string>;
}

const date = (what: string) =>
	z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
		.describe(what);

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

/** Today's date in the user's timezone. */
async function today(ctx: ToolContext): Promise<string> {
	return todayIn(await ctx.zone());
}

/** A range of up to a year: endDate defaults to today, startDate to `defaultDays` days ending on endDate. */
async function rangeEndingToday(
	ctx: ToolContext,
	startDate: string | undefined,
	endDate: string | undefined,
	defaultDays: number,
): Promise<{ startDate: string; endDate: string }> {
	const todayDate = await today(ctx);
	if (endDate) assertDate(endDate, "endDate");
	const end = endDate ?? todayDate;
	return resolveRange(startDate ?? addDays(end, -(defaultDays - 1)), end, { today: todayDate, defaultDays, maxDays: 366 });
}

export function registerTools(server: McpServer, ctx: ToolContext): void {
	// ------------------------------------------------------------------ activities
	server.registerTool(
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
				const result = await ctx.garmin().get<unknown[]>("/activitylist-service/activities/search/activities", {
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

	server.registerTool(
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
				const result = await ctx.garmin().get(`/activity-service/activity/${encodeURIComponent(id)}`);
				return shapeActivityDetails(result, raw);
			}),
	);

	// ------------------------------------------------------------------ daily summary
	server.registerTool(
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
					const range = resolveRange(startDate, endDate, { today: await today(ctx), defaultDays: 1, maxDays: 366 });
					const result = await ctx.garmin().get<{ data?: unknown[] }>("/usersummary-service/v2/dailysummaries", range);
					const days = (result?.data ?? []).map(summarizeDailySummaryV2);
					return { ...range, count: days.length, days };
				}
				const calendarDate = day ?? (await today(ctx));
				assertDate(calendarDate, "date");
				const result = await ctx.garmin().get("/usersummary-service/usersummary/daily", { calendarDate });
				return result ? summarizeDailySummary(result) : { calendarDate, message: "No data for this date." };
			}),
	);

	// ------------------------------------------------------------------ sleep
	server.registerTool(
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
					const range = resolveRange(startDate, endDate, { today: await today(ctx), defaultDays: 1, maxDays: 31 });
					const result = await ctx.garmin().get<unknown[]>("/sleep-service/sleep/dailySleepSummariesByDate", range);
					const nights = (Array.isArray(result) ? result : []).map(summarizeSleep);
					return { ...range, count: nights.length, units: { stages: "seconds" }, nights };
				}
				const calendarDate = day ?? (await today(ctx));
				assertDate(calendarDate, "date");
				const result = await ctx.garmin().get("/sleep-service/sleep/dailySleep", { date: calendarDate });
				return result ? summarizeSleep(result) : { calendarDate, message: "No sleep recorded for this date." };
			}),
	);

	// ------------------------------------------------------------------ HRV
	server.registerTool(
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
				const todayDate = await today(ctx);
				const end = endDate ?? todayDate;
				const range = resolveRange(startDate ?? addDays(end, -6), end, { today: todayDate, defaultDays: 7, maxDays: 366 });
				const result = await ctx.garmin().get(
					`/hrv-service/hrv/daily/${range.startDate}/${range.endDate}`,
				);
				const days = summarizeHrv(result);
				return { ...range, units: { hrv: "milliseconds" }, count: days.length, days };
			}),
	);

	// ------------------------------------------------------------------ Body Battery
	server.registerTool(
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
				const range = resolveRange(startDate, endDate, { today: await today(ctx), defaultDays: 1, maxDays: 31 });
				const result = await ctx.garmin().get<unknown[]>("/wellness-service/wellness/bodyBattery/reports/daily", {
					...range,
					chunks: includeTimeline ? (chunks ?? 24) : chunks,
				});
				const days = (Array.isArray(result) ? result : []).map((r) => summarizeBodyBattery(r, includeTimeline));
				return { ...range, count: days.length, days };
			}),
	);

	// ------------------------------------------------------------------ day details
	server.registerTool(
		"get_day_details",
		{
			title: "Get Garmin day details",
			description:
				"Intraday detail for one day, in local time: heart rate through the day (average/min/max per interval, " +
				"resting, the day's lowest and highest reading with times, readings flagged as abnormal), the overnight " +
				"HRV readings of the night that ended on this date (with sleep start/end) and SpO2 (hourly averages, " +
				"sleep average, latest). Use for questions about a specific day or night, e.g. 'what was my heart rate " +
				"this afternoon?' or 'how did my HRV look overnight?'. For several days use the daily tools or get_trends.",
			inputSchema: {
				date: date("Calendar date, YYYY-MM-DD. Defaults to today.").optional(),
				include: z
					.array(z.enum(DAY_DETAIL_PARTS))
					.min(1)
					.describe("Which data to include: heartRate, hrv, spo2. Defaults to all three.")
					.optional(),
				intervalMinutes: z
					.number()
					.int()
					.min(5)
					.max(60)
					.default(15)
					.describe("Length of each averaged interval in minutes, 5-60 (default 15). HRV is measured every 5 minutes."),
			},
			annotations: { title: "Get Garmin day details", ...READ_ONLY },
		},
		async ({ date: day, include, intervalMinutes }) =>
			run(async () => {
				const calendarDate = day ?? (await today(ctx));
				assertDate(calendarDate, "date");
				return fetchDayDetails(ctx.garmin(), {
					date: calendarDate,
					timeZone: await ctx.zone(),
					intervalMinutes,
					parts: [...new Set(include ?? DAY_DETAIL_PARTS)],
				});
			}),
	);

	// ------------------------------------------------------------------ fitness profile
	server.registerTool(
		"get_fitness_profile",
		{
			title: "Get Garmin Fitness Age and heart rate zones",
			description:
				"Fitness Age (the latest as of the date) with the components behind it, e.g. vigorous days or minutes, resting " +
				"heart rate, BMI or body fat, each with its target and the Fitness Age reachable by meeting it; plus the heart " +
				"rate zones Garmin uses per sport (bpm ranges for zones 1-5, max, resting and lactate-threshold heart rate, " +
				"training method). Use for 'how fit am I?', 'what are my heart rate zones?' or 'what should I improve?'.",
			inputSchema: {
				date: date("Fitness Age as of this date, YYYY-MM-DD. Defaults to today.").optional(),
			},
			annotations: { title: "Get Garmin Fitness Age and heart rate zones", ...READ_ONLY },
		},
		async ({ date: day }) =>
			run(async () => {
				const calendarDate = day ?? (await today(ctx));
				assertDate(calendarDate, "date");
				return fetchFitnessProfile(ctx.garmin(), calendarDate);
			}),
	);

	// ------------------------------------------------------------------ nutrition
	server.registerTool(
		"get_nutrition",
		{
			title: "Get Garmin nutrition log",
			description:
				"Food logged in Garmin Connect: calories, carbs, protein and fat against the day's goals. For one day (default " +
				"today) also each meal with its foods and servings; for a range (up to " +
				`${NUTRITION_MAX_DAYS} days) daily totals and averages over the logged days. Only has data if the user logs ` +
				"food in Garmin Connect.",
			inputSchema: {
				date: date("Single calendar date, YYYY-MM-DD. Defaults to today.").optional(),
				startDate: date("Range start (inclusive), YYYY-MM-DD. Use with endDate instead of date.").optional(),
				endDate: date("Range end (inclusive), YYYY-MM-DD.").optional(),
			},
			annotations: { title: "Get Garmin nutrition log", ...READ_ONLY },
		},
		async ({ date: day, startDate, endDate }) =>
			run(async () => {
				if (startDate || endDate) {
					const range = resolveRange(startDate, endDate, {
						today: await today(ctx),
						defaultDays: 1,
						maxDays: NUTRITION_MAX_DAYS,
					});
					return fetchNutrition(ctx.garmin(), range);
				}
				const calendarDate = day ?? (await today(ctx));
				assertDate(calendarDate, "date");
				return fetchNutrition(ctx.garmin(), { startDate: calendarDate, endDate: calendarDate });
			}),
	);

	// ------------------------------------------------------------------ VO2 max
	server.registerTool(
		"get_vo2max",
		{
			title: "Get Garmin VO2 max",
			description:
				"VO2 max history (Garmin's estimate of aerobic fitness, ml/kg/min) for generic (running/walking), cycling " +
				"and rowing, where available. Per sport: first and latest value in the range, the change, min/max and the " +
				"dates the whole-number value changed. Defaults to the last 365 days; up to 366 days per call.",
			inputSchema: {
				startDate: date("Range start (inclusive), YYYY-MM-DD. Defaults to 364 days before endDate.").optional(),
				endDate: date("Range end (inclusive), YYYY-MM-DD. Defaults to today.").optional(),
			},
			annotations: { title: "Get Garmin VO2 max", ...READ_ONLY },
		},
		async ({ startDate, endDate }) =>
			run(async () => {
				const range = await rangeEndingToday(ctx, startDate, endDate, 365);
				return fetchVo2Max(ctx.garmin(), range);
			}),
	);

	// ------------------------------------------------------------------ weight
	server.registerTool(
		"get_weight",
		{
			title: "Get Garmin weight and body composition",
			description:
				"Weight and body composition from a Garmin scale or manual entries: weight (kg), BMI, body fat %, body " +
				"water %, muscle and bone mass (kg), visceral fat, metabolic age. Returns the first, latest, lowest and " +
				"highest values, the change and average over the range, the weight goal if one is set, and daily values " +
				"(monthly averages when there are many measurements). Defaults to the last 90 days; up to 366 days per call.",
			inputSchema: {
				startDate: date("Range start (inclusive), YYYY-MM-DD. Defaults to 89 days before endDate.").optional(),
				endDate: date("Range end (inclusive), YYYY-MM-DD. Defaults to today.").optional(),
			},
			annotations: { title: "Get Garmin weight and body composition", ...READ_ONLY },
		},
		async ({ startDate, endDate }) =>
			run(async () => {
				const range = await rangeEndingToday(ctx, startDate, endDate, 90);
				return fetchWeight(ctx.garmin(), range);
			}),
	);

	// ------------------------------------------------------------------ trends
	server.registerTool(
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
				const todayDate = await today(ctx);
				const end = endDate ?? todayDate;
				if (endDate) assertDate(endDate, "endDate");
				const range = resolveRange(startDate ?? addDays(end, -83), end, {
					today: todayDate,
					defaultDays: 84,
					maxDays: TREND_MAX_DAYS,
				});
				const days = (Date.parse(range.endDate) - Date.parse(range.startDate)) / 86_400_000 + 1;
				return collectTrends(ctx.garmin(), {
					...range,
					period: period ?? (days <= 92 ? "week" : "month"),
					metrics: [...new Set(metrics ?? TREND_METRICS)],
					activityType,
				});
			}),
	);
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
