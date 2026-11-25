import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKV } from "./helpers";

type GarminModule = typeof import("../src/garmin");

const BASE = "https://personal.connectapi.garmin.com";
const TOKEN_URL = `${BASE}/personalapitoken-service/personal-api/personal-api-key/token`;

/** A fresh module per test: the in-memory token cache lives at module level (per isolate). */
let garmin: GarminModule;
beforeEach(async () => {
	vi.resetModules();
	garmin = await import("../src/garmin");
});

type Route = (request: Request) => Response | Promise<Response>;

/** Stubs global fetch: token requests go to `token`, everything else to `data`. */
function stubFetch(routes: { token?: Route; data?: Route }) {
	const calls: Request[] = [];
	const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		calls.push(request);
		if (request.url === TOKEN_URL) {
			return (routes.token ?? (() => Response.json({ access_token: "tok-1", expires_in: 86400 })))(request);
		}
		return (routes.data ?? (() => Response.json({ ok: true })))(request);
	});
	vi.stubGlobal("fetch", fetchMock);
	return { calls, tokenCalls: () => calls.filter((r) => r.url === TOKEN_URL), dataCalls: () => calls.filter((r) => r.url !== TOKEN_URL) };
}

describe("GarminClient", () => {
	it("refuses an empty API key", () => {
		const kv = new FakeKV().asKV();
		expect(() => new garmin.GarminClient("", kv)).toThrow(/not configured/);
		expect(() => new garmin.GarminClient("   ", kv)).toThrow(garmin.GarminApiError);
	});

	it("requests a token with ApiKey auth and the Accept header Garmin needs, then calls with Bearer", async () => {
		const f = stubFetch({});
		const client = new garmin.GarminClient("  my-key  ", new FakeKV().asKV());
		expect(await client.get("/usersummary-service/usersummary/daily", { calendarDate: "2025-03-01" })).toEqual({ ok: true });

		const [token] = f.tokenCalls();
		expect(token!.method).toBe("POST");
		expect(token!.headers.get("Authorization")).toBe("ApiKey my-key");
		// application/json alone gets 406 from Garmin's token endpoint.
		expect(token!.headers.get("Accept")).toBe("application/json, text/plain, */*");

		const [data] = f.dataCalls();
		expect(data!.url).toBe(`${BASE}/usersummary-service/usersummary/daily?calendarDate=2025-03-01`);
		expect(data!.headers.get("Authorization")).toBe("Bearer tok-1");
	});

	it("drops undefined, null and empty query values", async () => {
		const f = stubFetch({});
		const client = new garmin.GarminClient("k", new FakeKV().asKV());
		await client.get("/x", { a: 1, b: undefined, c: null, d: "", e: false, f: "text" });
		expect(f.dataCalls()[0]!.url).toBe(`${BASE}/x?a=1&e=false&f=text`);
	});

	it("reuses the token: one token request for many calls and clients in the same isolate", async () => {
		const f = stubFetch({});
		const kv = new FakeKV();
		const a = new garmin.GarminClient("k", kv.asKV());
		await a.get("/x");
		await a.get("/y");
		await new garmin.GarminClient("k", kv.asKV()).get("/z");
		expect(f.tokenCalls()).toHaveLength(1);
		expect(f.dataCalls()).toHaveLength(3);
	});

	it("caches the token in KV encrypted, and a new isolate reads it back without a token request", async () => {
		const f = stubFetch({ token: () => Response.json({ access_token: "secret-token-value", expires_in: 86400 }) });
		const kv = new FakeKV();
		await new garmin.GarminClient("k", kv.asKV()).get("/x");

		const [put] = kv.puts;
		expect(put!.key).toMatch(/^garmin:access-token:[0-9a-f]{24}$/);
		expect(put!.key).not.toContain("k:");
		expect(put!.value).not.toContain("secret-token-value");
		expect(put!.options!.expirationTtl).toBeLessThanOrEqual(23 * 3600);
		expect(put!.options!.expirationTtl).toBeGreaterThan(22 * 3600);

		vi.resetModules();
		const fresh: GarminModule = await import("../src/garmin");
		await new fresh.GarminClient("k", kv.asKV()).get("/y");
		expect(f.tokenCalls()).toHaveLength(1);
		expect(f.dataCalls().at(-1)!.headers.get("Authorization")).toBe("Bearer secret-token-value");
	});

	it("a different API key doesn't use (or decrypt) another key's cached token", async () => {
		const f = stubFetch({});
		const kv = new FakeKV();
		await new garmin.GarminClient("key-one", kv.asKV()).get("/x");
		await new garmin.GarminClient("key-two", kv.asKV()).get("/x");
		expect(f.tokenCalls()).toHaveLength(2);
		expect(new Set(kv.puts.map((p) => p.key)).size).toBe(2);
	});

	it("a corrupt KV entry is ignored and replaced", async () => {
		stubFetch({});
		const kv = new FakeKV();
		await new garmin.GarminClient("k", kv.asKV()).get("/x");
		const key = kv.puts[0]!.key;
		kv.store.set(key, JSON.stringify({ iv: "AAAAAAAAAAAAAAAA", data: "bm9wZQ==", expiresAt: Date.now() + 3600_000 }));

		vi.resetModules();
		const fresh: GarminModule = await import("../src/garmin");
		const f2 = stubFetch({});
		await new fresh.GarminClient("k", kv.asKV()).get("/y");
		expect(f2.tokenCalls()).toHaveLength(1);
	});

	it("on a 401 it drops the cached token, gets a new one and retries once", async () => {
		let tokenNo = 0;
		const f = stubFetch({
			token: () => Response.json({ access_token: `tok-${++tokenNo}`, expires_in: 86400 }),
			data: (req) =>
				req.headers.get("Authorization") === "Bearer tok-1" ? new Response("expired", { status: 401 }) : Response.json({ ok: 2 }),
		});
		const kv = new FakeKV();
		expect(await new garmin.GarminClient("k", kv.asKV()).get("/x")).toEqual({ ok: 2 });
		expect(f.tokenCalls()).toHaveLength(2);
		expect(f.dataCalls()).toHaveLength(2);
		expect(kv.deletes).toHaveLength(1);
	});

	it("gives up after one retry when Garmin keeps answering 401", async () => {
		stubFetch({ data: () => new Response("no", { status: 401 }) });
		await expect(new garmin.GarminClient("k", new FakeKV().asKV()).get("/x")).rejects.toMatchObject({ status: 401 });
	});

	it("explains a rejected API key", async () => {
		stubFetch({ token: () => new Response("invalid key", { status: 401 }) });
		const error = await new garmin.GarminClient("k", new FakeKV().asKV()).get("/x").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(garmin.GarminApiError);
		expect((error as Error).message).toMatch(/rejected the Personal API key/);
	});

	it.each([
		[400, /Bad request/],
		[404, /Not found/],
		[429, /Rate limited/],
		[503, /Garmin service error/],
	])("maps HTTP %i to a readable GarminApiError", async (status, message) => {
		stubFetch({ data: () => new Response("details here", { status }) });
		const error = (await new garmin.GarminClient("k", new FakeKV().asKV()).get("/x").catch((e: unknown) => e)) as InstanceType<
			GarminModule["GarminApiError"]
		>;
		expect(error).toBeInstanceOf(garmin.GarminApiError);
		expect(error.status).toBe(status);
		expect(error.path).toBe("/x");
		expect(error.message).toMatch(message);
		expect(error.message).toContain("details here");
	});

	it("handles empty, 204 and non-JSON responses", async () => {
		const bodies = [new Response(null, { status: 204 }), new Response("   "), new Response("<html>oops</html>")];
		stubFetch({ data: () => bodies.shift()! });
		const client = new garmin.GarminClient("k", new FakeKV().asKV());
		expect(await client.get("/a")).toBeNull();
		expect(await client.get("/b")).toBeNull();
		await expect(client.get("/c")).rejects.toMatchObject({ status: 502 });
	});
});

describe("token response formats", () => {
	/**
	 * KV TTL chosen for a token response, in a fresh isolate (so nothing is cached yet).
	 * The clock is frozen so the result doesn't depend on how many milliseconds the call takes.
	 */
	const ttlFor = async (token: Route) => {
		vi.resetModules();
		const fresh: GarminModule = await import("../src/garmin");
		stubFetch({ token });
		const kv = new FakeKV();
		vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
		try {
			await new fresh.GarminClient("k", kv.asKV()).get("/x");
		} finally {
			vi.useRealTimers();
		}
		return kv.puts[0]?.options?.expirationTtl;
	};

	it("accepts accessToken / token field names", async () => {
		const f = stubFetch({ token: () => Response.json({ accessToken: "camel" }) });
		await new garmin.GarminClient("k", new FakeKV().asKV()).get("/x");
		expect(f.dataCalls()[0]!.headers.get("Authorization")).toBe("Bearer camel");
	});

	it("accepts a bare token string", async () => {
		const f = stubFetch({ token: () => new Response("bare-token-123") });
		await new garmin.GarminClient("k", new FakeKV().asKV()).get("/x");
		expect(f.dataCalls()[0]!.headers.get("Authorization")).toBe("Bearer bare-token-123");
	});

	it("caches for at most 23 hours, 10 minutes before expiry", async () => {
		expect(await ttlFor(() => Response.json({ access_token: "t", expires_in: 86400 }))).toBe(23 * 3600);
		expect(await ttlFor(() => Response.json({ access_token: "t", expires_in: 3600 }))).toBe(3000);
	});

	it("understands expires_at in seconds or milliseconds", async () => {
		const inSeconds = Math.floor(Date.now() / 1000) + 7200;
		expect(await ttlFor(() => Response.json({ access_token: "t", expires_at: inSeconds }))).toBeCloseTo(6600, -1);
		expect(await ttlFor(() => Response.json({ access_token: "t", expiresAt: inSeconds * 1000 }))).toBeCloseTo(6600, -1);
	});

	it("reads the expiry from a JWT when the response has none", async () => {
		const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).replace(/=+$/, "");
		expect(await ttlFor(() => Response.json({ access_token: `h.${payload}.s` }))).toBeCloseTo(3000, -1);
	});

	it("fails clearly when there is no token", async () => {
		stubFetch({ token: () => Response.json({ something: "else" }) });
		await expect(new garmin.GarminClient("k", new FakeKV().asKV()).get("/x")).rejects.toThrow(/no access_token/);
	});
});
