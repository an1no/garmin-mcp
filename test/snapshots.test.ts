import { describe, expect, it } from "vitest";
import { GarminApiError } from "../src/garmin";
import { fetchHealthSnapshots, shapeSnapshot, SNAPSHOT_MAX_LISTED } from "../src/snapshots";
import { fakeGarmin } from "./helpers";

// Synthetic WellnessActivitySummaryDTO, shaped like /wellnessactivity-service/activity/summary/range/{from}/{until}.
function snapshot(day: string, time: string, hr: number, overrides: Record<string, unknown> = {}) {
	return {
		userProfilePk: 99999,
		activityUuid: { baseUUID: "00000000-0000-0000-0000-000000000000" },
		calendarDate: { date: `${day}T00:00:00.0`, localDate: day },
		rulePK: 2,
		activityName: "Health Snapshot",
		notes: "PRIVATE-NOTE",
		wellnessActivityType: "HEALTH_MONITORING",
		startTimestampGMT: { date: `${day}T${time}:00.0` },
		endTimestampGMT: { date: `${day}T${time.slice(0, 3)}${String(Number(time.slice(3)) + 2).padStart(2, "0")}:00.0` },
		startTimestampLocal: { date: `${day}T${time}:00.0` },
		endTimestampLocal: { date: `${day}T${time.slice(0, 3)}${String(Number(time.slice(3)) + 2).padStart(2, "0")}:00.0` },
		summaryTypeDataList: [
			{ summaryType: "HEART_RATE", minValue: hr - 4, maxValue: hr + 6, avgValue: hr + 0.4 },
			{ summaryType: "STRESS", minValue: 10, maxValue: 40, avgValue: 22.6 },
			{ summaryType: "RESPIRATION", minValue: 12.04, maxValue: 16.96, avgValue: 14.44 },
			{ summaryType: "SPO2", minValue: 94, maxValue: 99, avgValue: 96.7 },
			{ summaryType: "RMSSD_HRV", minValue: 30, maxValue: 70, avgValue: 48.2 },
			{ summaryType: "SDRR_HRV", minValue: 40, maxValue: 90, avgValue: 61.5 },
			{ summaryType: "SOMETHING_NEW", minValue: 1, maxValue: 2, avgValue: 1.5 },
		],
		timeInZoneList: [{ zoneNumber: 1, millisInZone: 120000, zoneLowBoundary: 50 }],
		deviceMetaData: { deviceId: 123456 },
		...overrides,
	};
}

describe("shapeSnapshot", () => {
	it("date, local times, duration and avg/min/max per metric", () => {
		expect(shapeSnapshot(snapshot("2026-11-20", "08:15", 60))).toEqual({
			date: "2026-11-20",
			start: "2026-11-20T08:15:00",
			end: "2026-11-20T08:17:00",
			durationSeconds: 120,
			name: "Health Snapshot",
			heartRate: { avg: 60, min: 56, max: 66 },
			stress: { avg: 23, min: 10, max: 40 },
			respiration: { avg: 14.4, min: 12, max: 17 },
			spo2: { avg: 97, min: 94, max: 99 },
			hrvRmssd: { avg: 48, min: 30, max: 70 },
			hrvSdrr: { avg: 62, min: 40, max: 90 },
		});
	});

	it("never passes on notes, IDs, the device or the access rule", () => {
		const text = JSON.stringify(shapeSnapshot(snapshot("2026-11-20", "08:15", 60)));
		for (const word of ["PRIVATE", "notes", "userProfilePk", "Uuid", "deviceMetaData", "rulePK", "123456", "99999"]) {
			expect(text).not.toContain(word);
		}
	});

	it("epoch timestamps, wrist heart rate, and UTC only when local times are missing", () => {
		const shaped = shapeSnapshot({
			calendarDate: "2026-11-21",
			startTimestampGMT: Date.parse("2026-11-21T06:00:00Z"),
			endTimestampGMT: Date.parse("2026-11-21T06:02:30Z"),
			wellnessActivityType: "UNKNOWN",
			summaryTypeDataList: [{ summaryType: "WRIST_HEART_RATE", minValue: 50, maxValue: 70, avgValue: 61 }],
		});
		expect(shaped).toEqual({
			date: "2026-11-21",
			startUtc: "2026-11-21T06:00:00Z",
			durationSeconds: 150,
			type: "UNKNOWN",
			wristHeartRate: { avg: 61, min: 50, max: 70 },
		});
	});
});

describe("fetchHealthSnapshots", () => {
	it("asks for the range in 28-day requests, sorts oldest first and averages each metric", async () => {
		const g = fakeGarmin((path) => {
			if (path.endsWith("/2026-10-01/2026-10-28")) return [snapshot("2026-10-20", "07:00", 70)];
			if (path.endsWith("/2026-10-29/2026-11-25")) return [snapshot("2026-11-20", "08:15", 60), snapshot("2026-11-02", "21:40", 65)];
			throw new GarminApiError("Not found", 404, path);
		});
		const r = await fetchHealthSnapshots(g.client, { startDate: "2026-10-01", endDate: "2026-11-30" });
		expect(g.calls.map((c) => c.path)).toEqual([
			"/wellnessactivity-service/activity/summary/range/2026-10-01/2026-10-28",
			"/wellnessactivity-service/activity/summary/range/2026-10-29/2026-11-25",
			"/wellnessactivity-service/activity/summary/range/2026-11-26/2026-11-30",
		]);
		expect(g.tokenCalls).toBe(1);
		expect(r).toMatchObject({ startDate: "2026-10-01", endDate: "2026-11-30", count: 3 });
		expect((r.snapshots as { date: string }[]).map((s) => s.date)).toEqual(["2026-10-20", "2026-11-02", "2026-11-20"]);
		expect(r.averages).toEqual({ heartRate: 65, stress: 23, respiration: 14.4, spo2: 97, hrvRmssd: 48, hrvSdrr: 62 });
		expect(r.units).toMatchObject({ heartRate: "bpm", hrvRmssd: expect.stringContaining("milliseconds") });
	});

	it("no sessions gives a message", async () => {
		const none = fakeGarmin((path) => {
			throw new GarminApiError("Not found", 404, path);
		});
		expect(await fetchHealthSnapshots(none.client, { startDate: "2026-11-01", endDate: "2026-11-25" })).toEqual({
			startDate: "2026-11-01",
			endDate: "2026-11-25",
			units: expect.any(Object),
			count: 0,
			message: expect.stringMatching(/No Health Snapshots/),
		});
		const empty = fakeGarmin(() => []);
		expect(await fetchHealthSnapshots(empty.client, { startDate: "2026-11-01", endDate: "2026-11-25" })).toMatchObject({ count: 0 });
	});

	it(`lists the newest ${SNAPSHOT_MAX_LISTED} sessions and averages all of them`, async () => {
		const days = Array.from({ length: 70 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10));
		const g = fakeGarmin((path) => {
			const [from, until] = path.split("/").slice(-2);
			return days.filter((d) => d >= from! && d <= until!).map((d, i) => snapshot(d, "08:00", 50 + (i % 2) * 10));
		});
		const r = await fetchHealthSnapshots(g.client, { startDate: "2026-01-01", endDate: "2026-03-11" });
		const listed = r.snapshots as { date: string }[];
		expect(r.count).toBe(70);
		expect(listed).toHaveLength(SNAPSHOT_MAX_LISTED);
		expect(listed[0]!.date).toBe(days[10]);
		expect(listed.at(-1)!.date).toBe("2026-03-11");
		expect(r.note).toMatch(/newest 60 of 70/);
	});

	it("other Garmin errors are thrown", async () => {
		const failing = fakeGarmin((path) => {
			throw new GarminApiError("Rate limited", 429, path);
		});
		await expect(fetchHealthSnapshots(failing.client, { startDate: "2026-11-01", endDate: "2026-11-25" })).rejects.toThrow(/Rate limited/);
	});
});
