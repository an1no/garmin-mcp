import { describe, expect, it } from "vitest";
import { GarminApiError } from "../src/garmin";
import { isValidTimeZone, resolveTimeZone } from "../src/profile";
import { FakeKV, fakeGarmin } from "./helpers";

const KV_KEY = "garmin:profile:timezone";
const profile = (timeZone: unknown) => fakeGarmin(() => ({ timeZone, displayName: "someone" }));

describe("isValidTimeZone", () => {
	it("accepts IANA names (and gmt), rejects everything else", () => {
		for (const zone of ["Indian/Mauritius", "Asia/Tokyo", "America/Chicago", "Europe/Berlin", "UTC", "gmt"]) {
			expect(isValidTimeZone(zone), zone).toBe(true);
		}
		for (const zone of ["auto", "Mars/Olympus", "", "   ", null, undefined]) {
			expect(isValidTimeZone(zone), String(zone)).toBe(false);
		}
	});
});

describe("resolveTimeZone", () => {
	it("an explicit TIMEZONE wins without calling Garmin", async () => {
		const g = profile("Indian/Mauritius");
		expect(await resolveTimeZone("Europe/Berlin", g.client, new FakeKV().asKV())).toEqual({
			zone: "Europe/Berlin",
			source: "config",
			cacheable: true,
		});
		expect(g.calls).toHaveLength(0);
	});

	it("auto reads the Garmin profile, caches it in KV for a day, then reuses it", async () => {
		const g = profile("Indian/Mauritius");
		const kv = new FakeKV();
		expect(await resolveTimeZone("auto", g.client, kv.asKV())).toEqual({
			zone: "Indian/Mauritius",
			source: "garmin-profile",
			cacheable: true,
		});
		expect(g.calls[0]!.path).toBe("/userprofile-service/userprofile/settings");
		expect(kv.puts).toEqual([{ key: KV_KEY, value: "Indian/Mauritius", options: { expirationTtl: 86400 } }]);
		// Only the zone is stored, nothing else from the profile.
		expect(kv.puts[0]!.value).not.toContain("someone");

		expect((await resolveTimeZone("AUTO", g.client, kv.asKV())).zone).toBe("Indian/Mauritius");
		expect(g.calls).toHaveLength(1);
	});

	it.each([undefined, "", "  ", "Not/AZone"])("TIMEZONE %j behaves like auto", async (configured) => {
		const g = profile("America/Chicago");
		expect((await resolveTimeZone(configured, g.client, new FakeKV().asKV())).zone).toBe("America/Chicago");
	});

	it("an unusable profile zone gives UTC (cached for a day)", async () => {
		const kv = new FakeKV();
		expect(await resolveTimeZone("auto", profile("???").client, kv.asKV())).toEqual({
			zone: "UTC",
			source: "fallback",
			cacheable: true,
		});
		expect(kv.store.get(KV_KEY)).toBe("UTC");
	});

	it("a Garmin error gives UTC without caching, so the next call tries again", async () => {
		const failing = fakeGarmin(() => {
			throw new GarminApiError("Garmin rejected the Personal API key.", 401, "/x");
		});
		const kv = new FakeKV();
		expect(await resolveTimeZone("auto", failing.client, kv.asKV())).toEqual({
			zone: "UTC",
			source: "fallback",
			cacheable: false,
		});
		expect(kv.puts).toHaveLength(0);
	});

	it("an invalid cached value is ignored and refreshed", async () => {
		const kv = new FakeKV();
		kv.store.set(KV_KEY, "Broken/Zone");
		const g = profile("Indian/Mauritius");
		expect((await resolveTimeZone("auto", g.client, kv.asKV())).zone).toBe("Indian/Mauritius");
		expect(kv.store.get(KV_KEY)).toBe("Indian/Mauritius");
	});

	it("survives KV failures", async () => {
		const brokenKv = {
			get: async () => {
				throw new Error("kv down");
			},
			put: async () => {
				throw new Error("kv down");
			},
		} as unknown as KVNamespace;
		expect((await resolveTimeZone("auto", profile("Indian/Mauritius").client, brokenKv)).zone).toBe("Indian/Mauritius");
	});
});
