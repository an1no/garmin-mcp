import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearFailures,
	clientIp,
	isPasswordConfigured,
	lockoutSeconds,
	MIN_PASSWORD_LENGTH,
	recordFailure,
	verifyPassword,
} from "../src/security";
import { FakeKV } from "./helpers";

describe("passwords", () => {
	it("verifyPassword: exact match only", async () => {
		expect(await verifyPassword("correct horse battery", "correct horse battery")).toBe(true);
		expect(await verifyPassword("correct horse batter", "correct horse battery")).toBe(false);
		expect(await verifyPassword("Correct horse battery", "correct horse battery")).toBe(false);
		expect(await verifyPassword("", "correct horse battery")).toBe(false);
		// Different lengths are compared through equal-length digests, so they can't throw.
		expect(await verifyPassword("x".repeat(500), "short-one")).toBe(false);
	});

	it("isPasswordConfigured: at least MIN_PASSWORD_LENGTH characters", () => {
		expect(MIN_PASSWORD_LENGTH).toBe(8);
		expect(isPasswordConfigured("12345678")).toBe(true);
		expect(isPasswordConfigured("1234567")).toBe(false);
		expect(isPasswordConfigured("")).toBe(false);
		expect(isPasswordConfigured(undefined)).toBe(false);
	});

	it("clientIp: Cloudflare's connecting IP, or 'unknown'", () => {
		expect(clientIp(new Request("https://x/", { headers: { "CF-Connecting-IP": "203.0.113.7" } }))).toBe("203.0.113.7");
		expect(clientIp(new Request("https://x/"))).toBe("unknown");
	});
});

describe("lockout", () => {
	let kv: FakeKV;
	beforeEach(() => {
		kv = new FakeKV();
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
	});
	afterEach(() => vi.useRealTimers());

	const fail = async (ip: string, times: number) => {
		for (let i = 0; i < times; i++) await recordFailure(kv.asKV(), ip);
	};

	it("4 failures from an IP are allowed, the 5th locks it for 15 minutes", async () => {
		await fail("1.1.1.1", 4);
		expect(await lockoutSeconds(kv.asKV(), "1.1.1.1")).toBe(0);
		await fail("1.1.1.1", 1);
		expect(await lockoutSeconds(kv.asKV(), "1.1.1.1")).toBe(15 * 60);
		// Other IPs are not affected by one IP's lockout.
		expect(await lockoutSeconds(kv.asKV(), "2.2.2.2")).toBe(0);
	});

	it("the lock counts down and expires when the window ends", async () => {
		await fail("1.1.1.1", 5);
		vi.advanceTimersByTime(10 * 60 * 1000);
		expect(await lockoutSeconds(kv.asKV(), "1.1.1.1")).toBe(5 * 60);
		vi.advanceTimersByTime(5 * 60 * 1000 + 1);
		expect(await lockoutSeconds(kv.asKV(), "1.1.1.1")).toBe(0);
		// A failure after the window starts a fresh count.
		await fail("1.1.1.1", 1);
		expect(await lockoutSeconds(kv.asKV(), "1.1.1.1")).toBe(0);
	});

	it("20 failures across many IPs pause everyone for an hour", async () => {
		for (let i = 0; i < 20; i++) await fail(`10.0.0.${i}`, 1);
		expect(await lockoutSeconds(kv.asKV(), "192.168.1.1")).toBe(60 * 60);
	});

	it("clearFailures resets the IP counter but not the global one", async () => {
		await fail("1.1.1.1", 4);
		await clearFailures(kv.asKV(), "1.1.1.1");
		await fail("1.1.1.1", 4);
		expect(await lockoutSeconds(kv.asKV(), "1.1.1.1")).toBe(0);
		expect(JSON.parse(kv.store.get("auth-fail:global")!).count).toBe(8);
	});

	it("stores counters with a TTL of at least 60 seconds", async () => {
		await fail("1.1.1.1", 1);
		for (const put of kv.puts) expect(put.options?.expirationTtl).toBeGreaterThanOrEqual(60);
		expect(kv.puts.map((p) => p.key).sort()).toEqual(["auth-fail:global", "auth-fail:ip:1.1.1.1"]);
	});
});
