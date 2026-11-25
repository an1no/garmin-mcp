import { AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authHandler, GARMIN_READ_SCOPE } from "../src/auth-handler";
import { FakeKV } from "./helpers";

const PASSWORD = "correct horse battery staple";
const ORIGIN = "https://garmin-mcp.example.workers.dev";
const AUTHORIZE = `${ORIGIN}/authorize?response_type=code&client_id=c1&redirect_uri=https%3A%2F%2Fgemini.google.com%2Fcb&scope=garmin%3Aread&state=s1`;

function makeEnv(overrides: { password?: string; oauth?: Record<string, unknown> } = {}) {
	const authRequest = { clientId: "c1", redirectUri: "https://gemini.google.com/cb", scope: ["garmin:read"], state: "s1" };
	const oauth = {
		parseAuthRequest: vi.fn(async () => authRequest),
		describeConsent: vi.fn(async () => ({
			clientId: "c1",
			clientName: '<script>alert("x")</script>Gemini',
			redirectUri: "https://gemini.google.com/cb",
			redirectHost: "gemini.google.com",
			redirectIsLoopback: false,
			scope: ["garmin:read"],
		})),
		beginConsent: vi.fn(async () => ({ handle: "handle-123", headers: new Headers({ "Set-Cookie": "consent=abc; Secure" }) })),
		denyConsent: vi.fn(async () => ({ headers: new Headers({ Location: "https://gemini.google.com/cb?error=access_denied" }) })),
		approveConsent: vi.fn(async (_req: Request, _handle: string, opts: { scope: string[] }) => ({
			request: { ...authRequest, scope: opts.scope },
			headers: new Headers({ "Set-Cookie": "consent=; Max-Age=0" }),
		})),
		completeAuthorization: vi.fn(async () => ({ redirectTo: "https://gemini.google.com/cb?code=the-code&state=s1" })),
		...overrides.oauth,
	};
	const kv = new FakeKV();
	const env = {
		MCP_ADMIN_PASSWORD: overrides.password ?? PASSWORD,
		GARMIN_PERSONAL_API_KEY: "unused",
		TIMEZONE: "auto",
		OAUTH_KV: kv.asKV(),
		OAUTH_PROVIDER: oauth,
	} as unknown as Env;
	return { env, oauth, kv };
}

const call = (env: Env, request: Request) =>
	authHandler.fetch!(request as Request<unknown, IncomingRequestCfProperties>, env, {} as ExecutionContext);

const post = (fields: Record<string, string>, url = AUTHORIZE, ip = "198.51.100.1") =>
	new Request(url, {
		method: "POST",
		headers: { "CF-Connecting-IP": ip, "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(fields).toString(),
	});

function expectSecurityHeaders(res: Response) {
	expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
	expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
	expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
	expect(res.headers.get("X-Frame-Options")).toBe("DENY");
	expect(res.headers.get("Cache-Control")).toBe("no-store");
}

describe("static routes", () => {
	it("GET / shows the MCP URL with security headers", async () => {
		const { env } = makeEnv();
		const res = await call(env, new Request(`${ORIGIN}/`));
		expect(res.status).toBe(200);
		// escapeHtml also escapes "/", so the URL appears as https:&#47;&#47;host&#47;mcp.
		expect(await res.text()).toContain("garmin-mcp.example.workers.dev&#47;mcp");
		expectSecurityHeaders(res);
	});

	it("robots.txt disallows everything; unknown paths are 404; other methods on /authorize are 405", async () => {
		const { env } = makeEnv();
		expect(await (await call(env, new Request(`${ORIGIN}/robots.txt`))).text()).toContain("Disallow: /");
		expect((await call(env, new Request(`${ORIGIN}/nope`))).status).toBe(404);
		const put = await call(env, new Request(AUTHORIZE, { method: "PUT" }));
		expect(put.status).toBe(405);
		expect(put.headers.get("Allow")).toBe("GET, POST");
	});
});

describe("GET /authorize", () => {
	it("renders the consent page: escaped client name, destination host, handle, cookie", async () => {
		const { env, oauth } = makeEnv();
		const res = await call(env, new Request(AUTHORIZE));
		const html = await res.text();
		expect(res.status).toBe(200);
		expect(html).not.toContain("<script>");
		expect(html).toContain("&#60;script&#62;");
		expect(html).toContain("gemini.google.com");
		expect(html).toContain('name="handle" value="handle-123"');
		expect(html).toContain('type="password"');
		expect(res.headers.get("Set-Cookie")).toContain("consent=abc");
		expectSecurityHeaders(res);
		// describeConsent runs before beginConsent, so a failed lookup leaves nothing behind.
		expect(oauth.describeConsent.mock.invocationCallOrder[0]).toBeLessThan(oauth.beginConsent.mock.invocationCallOrder[0]!);
	});

	it("warns when access would go to a loopback address", async () => {
		const { env } = makeEnv({
			oauth: {
				describeConsent: vi.fn(async () => ({
					clientId: "c1",
					clientName: "Local tool",
					redirectUri: "http://127.0.0.1:3000/cb",
					redirectHost: "127.0.0.1:3000",
					redirectIsLoopback: true,
					scope: [],
				})),
			},
		});
		const html = await (await call(env, new Request(AUTHORIZE))).text();
		expect(html).toContain("an app on this computer");
	});

	it("answers 503 when the admin password is missing or too short", async () => {
		const { env, oauth } = makeEnv({ password: "short" });
		const res = await call(env, new Request(AUTHORIZE));
		expect(res.status).toBe(503);
		expect(await res.text()).toContain("Server not configured");
		expect(oauth.beginConsent).not.toHaveBeenCalled();
	});
});

describe("POST /authorize", () => {
	it("deny redirects through denyConsent without checking the password", async () => {
		const { env, oauth } = makeEnv();
		const res = await call(env, post({ handle: "handle-123", decision: "deny", password: "" }));
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toContain("error=access_denied");
		expect(oauth.denyConsent).toHaveBeenCalledWith(expect.any(Request), "handle-123");
		expect(oauth.approveConsent).not.toHaveBeenCalled();
	});

	it("a wrong password re-renders the page with 401 and counts the failure", async () => {
		const { env, oauth, kv } = makeEnv();
		const res = await call(env, post({ handle: "handle-123", decision: "approve", password: "wrong" }));
		expect(res.status).toBe(401);
		const html = await res.text();
		expect(html).toContain("Incorrect password");
		expect(html).toContain('value="handle-123"');
		expect(oauth.approveConsent).not.toHaveBeenCalled();
		expect(oauth.completeAuthorization).not.toHaveBeenCalled();
		expect(JSON.parse(kv.store.get("auth-fail:ip:198.51.100.1")!).count).toBe(1);
	});

	it("the right password approves with the fixed read scope and redirects with the code", async () => {
		const { env, oauth } = makeEnv();
		const res = await call(env, post({ handle: "handle-123", decision: "approve", password: PASSWORD }));
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe("https://gemini.google.com/cb?code=the-code&state=s1");
		expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
		expect(oauth.approveConsent).toHaveBeenCalledWith(expect.any(Request), "handle-123", { scope: [GARMIN_READ_SCOPE] });
		expect(oauth.completeAuthorization).toHaveBeenCalledWith(
			expect.objectContaining({ userId: "owner", scope: ["garmin:read"], props: expect.objectContaining({ user: "owner" }) }),
		);
	});

	it("grants offline_access only when the client asked for it, never other requested scopes", async () => {
		const { env, oauth } = makeEnv();
		const url = AUTHORIZE.replace("scope=garmin%3Aread", "scope=garmin%3Aread%20offline_access%20admin%3Awrite");
		await call(env, post({ handle: "h", decision: "approve", password: PASSWORD }, url));
		expect(oauth.approveConsent).toHaveBeenCalledWith(expect.any(Request), "h", { scope: ["garmin:read", "offline_access"] });
	});

	it("locks an IP out after 5 wrong passwords, even for the right one", async () => {
		const { env, oauth } = makeEnv();
		for (let i = 0; i < 5; i++) {
			expect((await call(env, post({ handle: "h", decision: "approve", password: `wrong-${i}` }))).status).toBe(401);
		}
		const locked = await call(env, post({ handle: "h", decision: "approve", password: PASSWORD }));
		expect(locked.status).toBe(429);
		expect(Number(locked.headers.get("Retry-After"))).toBeGreaterThan(0);
		expect(await locked.text()).toContain("Too many attempts");
		expect(oauth.approveConsent).not.toHaveBeenCalled();
		// A different IP is still allowed.
		expect((await call(env, post({ handle: "h", decision: "approve", password: PASSWORD }, AUTHORIZE, "198.51.100.2"))).status).toBe(302);
	});

	it("a successful login clears that IP's failure count", async () => {
		const { env, kv } = makeEnv();
		for (let i = 0; i < 4; i++) await call(env, post({ handle: "h", decision: "approve", password: "wrong" }));
		expect((await call(env, post({ handle: "h", decision: "approve", password: PASSWORD }))).status).toBe(302);
		expect(kv.store.has("auth-fail:ip:198.51.100.1")).toBe(false);
		for (let i = 0; i < 4; i++) {
			expect((await call(env, post({ handle: "h", decision: "approve", password: "wrong" }))).status).toBe(401);
		}
	});

	it("answers 503 when the admin password is not configured", async () => {
		const { env } = makeEnv({ password: "" });
		expect((await call(env, post({ handle: "h", decision: "approve", password: "" }))).status).toBe(503);
	});
});

describe("OAuth errors", () => {
	it("an AuthorizationError with a validated redirect goes back to the client", async () => {
		const error = new AuthorizationError("invalid_scope", {
			description: "bad scope",
			redirectUri: "https://gemini.google.com/cb",
			state: "s1",
		});
		const { env } = makeEnv({ oauth: { parseAuthRequest: vi.fn(async () => Promise.reject(error)) } });
		const res = await call(env, new Request(AUTHORIZE));
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toContain("https://gemini.google.com/cb");
		expect(res.headers.get("Location")).toContain("error=invalid_scope");
	});

	it("an AuthorizationError without a safe redirect is shown locally (400)", async () => {
		const error = new AuthorizationError("invalid_request", { description: "Unknown client." });
		const { env } = makeEnv({ oauth: { parseAuthRequest: vi.fn(async () => Promise.reject(error)) } });
		const res = await call(env, new Request(AUTHORIZE));
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("Unknown client.");
	});

	it("a failed client metadata lookup is shown locally (400)", async () => {
		const error = new CimdFetchError("https://app.example/client.json", new Error("HTTP 403"));
		const { env } = makeEnv({ oauth: { parseAuthRequest: vi.fn(async () => Promise.reject(error)) } });
		const res = await call(env, new Request(AUTHORIZE));
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("could not be verified");
	});

	it("unexpected errors are not swallowed", async () => {
		const { env } = makeEnv({ oauth: { parseAuthRequest: vi.fn(async () => Promise.reject(new Error("boom"))) } });
		await expect(call(env, new Request(AUTHORIZE))).rejects.toThrow("boom");
	});
});

describe("logging", () => {
	const authLogs = (spy: { mock: { calls: unknown[][] } }) =>
		spy.mock.calls.map((args) => args[0] as Record<string, unknown>).filter((e) => e?.event === "authorize");

	it("logs each decision without the password or IP address", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { env } = makeEnv();
		await call(env, post({ handle: "h", decision: "approve", password: "wrong-guess-123" }));
		await call(env, post({ handle: "h", decision: "deny", password: "" }));
		await call(env, post({ handle: "h", decision: "approve", password: PASSWORD }));
		expect(authLogs(spy)).toEqual([
			{ event: "authorize", outcome: "wrong_password" },
			{ event: "authorize", outcome: "denied" },
			{ event: "authorize", outcome: "approved", scope: ["garmin:read"] },
		]);
		const everything = JSON.stringify(spy.mock.calls);
		for (const secret of [PASSWORD, "wrong-guess-123", "198.51.100.1"]) expect(everything).not.toContain(secret);
	});

	it("logs a lockout with the wait", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { env } = makeEnv();
		for (let i = 0; i < 6; i++) await call(env, post({ handle: "h", decision: "approve", password: `wrong-${i}` }));
		expect(authLogs(spy).at(-1)).toMatchObject({ event: "authorize", outcome: "locked_out" });
		expect(authLogs(spy).at(-1)!.retryAfterSeconds).toBeGreaterThan(0);
	});
});
