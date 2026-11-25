/**
 * End to end, inside a local workerd: an MCP client registers (DCR), the owner approves on the
 * password page, the client exchanges the code (PKCE) for tokens, then talks MCP over
 * Streamable HTTP to the Durable Object, whose tool calls reach a mocked Garmin API.
 *
 * Everything is local and throwaway: KV and Durable Objects live in Miniflare, the secrets are
 * test values from vitest.config.ts, and Garmin is answered by MSW.
 */
import { exports } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { network } from "./network";

const ORIGIN = "https://garmin-mcp.e2e.example";
const REDIRECT_URI = "https://client.e2e.example/oauth/callback";
const PASSWORD = "e2e-test-admin-password"; // matches vitest.config.ts
const GARMIN = "https://personal.connectapi.garmin.com";
const GARMIN_TOKEN = "e2e-garmin-access-token";

const worker = () => (exports as unknown as { default: { fetch: (input: string | Request, init?: RequestInit) => Promise<Response> } }).default;
const fetchWorker = (path: string, init?: RequestInit) => worker().fetch(`${ORIGIN}${path}`, init);

// ---------------------------------------------------------------- helpers

const base64url = (bytes: ArrayBuffer | Uint8Array) =>
	btoa(String.fromCharCode(...new Uint8Array(bytes)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

async function pkce() {
	const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
	const challenge = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
	return { verifier, challenge };
}

/** "name=value" pairs from all Set-Cookie headers, ready for a Cookie header. */
const cookiesFrom = (res: Response) =>
	res.headers
		.getSetCookie()
		.map((c) => c.split(";")[0])
		.join("; ");

const decodeEntities = (s: string) => s.replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));

const form = (fields: Record<string, string>) => ({
	method: "POST",
	headers: { "Content-Type": "application/x-www-form-urlencoded" },
	body: new URLSearchParams(fields).toString(),
});

/** Reads a JSON-RPC message from a Streamable HTTP response (JSON or a one-event SSE stream). */
async function rpcResult(res: Response): Promise<Record<string, any>> {
	const text = await res.text();
	if ((res.headers.get("Content-Type") ?? "").includes("text/event-stream")) {
		const data = text
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trim())
			.filter(Boolean);
		return JSON.parse(data.at(-1)!);
	}
	return JSON.parse(text);
}

/** Registers a client, approves it with the password and returns its tokens. */
async function connectClient(scope = "garmin:read offline_access") {
	const registration = await fetchWorker("/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			client_name: "E2E Test Client",
			redirect_uris: [REDIRECT_URI],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		}),
	});
	expect(registration.status).toBe(201);
	const { client_id: clientId } = (await registration.json()) as { client_id: string };

	const { verifier, challenge } = await pkce();
	const query = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: REDIRECT_URI,
		scope,
		state: "e2e-state",
		code_challenge: challenge,
		code_challenge_method: "S256",
		resource: `${ORIGIN}/mcp`,
	});
	const authorizePath = `/authorize?${query}`;
	const page = await fetchWorker(authorizePath);
	expect(page.status).toBe(200);
	const html = await page.text();
	expect(html).toContain("E2E Test Client");
	expect(html).toContain("client.e2e.example");
	const handle = decodeEntities(/name="handle" value="([^"]+)"/.exec(html)![1]!);
	const cookie = cookiesFrom(page);

	const approved = await fetchWorker(authorizePath, {
		...form({ handle, decision: "approve", password: PASSWORD }),
		headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie, "CF-Connecting-IP": "203.0.113.10" },
		redirect: "manual",
	});
	expect(approved.status).toBe(302);
	const location = new URL(approved.headers.get("Location")!);
	expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI);
	expect(location.searchParams.get("state")).toBe("e2e-state");
	const code = location.searchParams.get("code")!;
	expect(code).toBeTruthy();

	const tokenRes = await fetchWorker(
		"/token",
		form({
			grant_type: "authorization_code",
			code,
			redirect_uri: REDIRECT_URI,
			client_id: clientId,
			code_verifier: verifier,
			resource: `${ORIGIN}/mcp`,
		}),
	);
	expect(tokenRes.status).toBe(200);
	const tokens = (await tokenRes.json()) as { access_token: string; refresh_token?: string; scope?: string; token_type: string };
	return { clientId, tokens };
}

/** A minimal Streamable HTTP MCP session. */
async function mcpSession(accessToken: string) {
	let sessionId: string | undefined;
	let nextId = 1;
	const send = async (method: string, params?: unknown, notification = false) => {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			Authorization: `Bearer ${accessToken}`,
		};
		if (sessionId) headers["mcp-session-id"] = sessionId;
		const body = notification ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: nextId++, method, params };
		const res = await fetchWorker("/mcp", { method: "POST", headers, body: JSON.stringify(body) });
		sessionId ??= res.headers.get("mcp-session-id") ?? undefined;
		if (notification) {
			await res.body?.cancel();
			return { status: res.status };
		}
		expect(res.status).toBe(200);
		return rpcResult(res);
	};

	const init = await send("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "e2e-test", version: "1.0.0" },
	});
	await send("notifications/initialized", undefined, true);
	return { init, send, sessionId: () => sessionId };
}

// ---------------------------------------------------------------- Garmin mock

let garminRequests: { url: string; auth: string | null }[] = [];

beforeEach(() => {
	garminRequests = [];
	network.use(
		http.post(`${GARMIN}/personalapitoken-service/personal-api/personal-api-key/token`, ({ request }) => {
			garminRequests.push({ url: request.url, auth: request.headers.get("Authorization") });
			return HttpResponse.json({ access_token: GARMIN_TOKEN, expires_in: 86400 });
		}),
		http.get(`${GARMIN}/sleep-service/sleep/dailySleep`, ({ request }) => {
			garminRequests.push({ url: request.url, auth: request.headers.get("Authorization") });
			const date = new URL(request.url).searchParams.get("date");
			return HttpResponse.json({
				dailySleepDTO: { calendarDate: date, sleepTimeSeconds: 27000, deepSleepSeconds: 4500, sleepScores: { overall: { value: 84 } } },
			});
		}),
	);
});

// ---------------------------------------------------------------- tests

describe("public endpoints", () => {
	it("serves the landing page and refuses /mcp without a token", async () => {
		expect((await fetchWorker("/")).status).toBe(200);
		const res = await fetchWorker("/mcp", { method: "POST", body: "{}" });
		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate") ?? "").toContain("resource_metadata");
	});

	it("advertises the OAuth metadata the clients rely on", async () => {
		const resource = (await (await fetchWorker("/.well-known/oauth-protected-resource/mcp")).json()) as Record<string, any>;
		expect(resource.resource).toBe(`${ORIGIN}/mcp`);

		const server = (await (await fetchWorker("/.well-known/oauth-authorization-server")).json()) as Record<string, any>;
		expect(server).toMatchObject({
			authorization_endpoint: `${ORIGIN}/authorize`,
			token_endpoint: `${ORIGIN}/token`,
			registration_endpoint: `${ORIGIN}/register`,
		});
		expect(server.code_challenge_methods_supported).toContain("S256");
		expect(server.scopes_supported).toEqual(expect.arrayContaining(["garmin:read", "offline_access"]));
	});
});

describe("connecting a client", () => {
	it("a wrong password is refused and gives no code", async () => {
		const registration = await fetchWorker("/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ client_name: "Wrong Password Client", redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" }),
		});
		const { client_id: clientId } = (await registration.json()) as { client_id: string };
		const { challenge } = await pkce();
		const path = `/authorize?${new URLSearchParams({
			response_type: "code",
			client_id: clientId,
			redirect_uri: REDIRECT_URI,
			scope: "garmin:read",
			state: "s",
			code_challenge: challenge,
			code_challenge_method: "S256",
		})}`;
		const page = await fetchWorker(path);
		const handle = decodeEntities(/name="handle" value="([^"]+)"/.exec(await page.text())![1]!);
		const res = await fetchWorker(path, {
			...form({ handle, decision: "approve", password: "not-the-password" }),
			headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookiesFrom(page), "CF-Connecting-IP": "203.0.113.20" },
			redirect: "manual",
		});
		expect(res.status).toBe(401);
		expect(res.headers.get("Location")).toBeNull();
		expect(await res.text()).toContain("Incorrect password");
	});

	it("register -> approve -> token -> MCP initialize -> tools/list -> tools/call, with Garmin mocked", async () => {
		const { tokens } = await connectClient();
		expect(tokens.token_type.toLowerCase()).toBe("bearer");
		expect(tokens.access_token).toBeTruthy();
		expect(tokens.refresh_token).toBeTruthy();

		const mcp = await mcpSession(tokens.access_token);
		expect(mcp.init.result.serverInfo).toMatchObject({ name: "garmin-connect" });
		expect(mcp.init.result.instructions).toContain("get_trends");
		expect(mcp.sessionId()).toBeTruthy();

		const list = await mcp.send("tools/list");
		expect(list.result.tools).toHaveLength(12);

		// MCP Apps: get_trends points to the chart app, which the server serves as a resource.
		const trends = list.result.tools.find((t: { name: string }) => t.name === "get_trends");
		expect(trends._meta.ui.resourceUri).toBe("ui://garmin-mcp/charts.html");
		const app = await mcp.send("resources/read", { uri: "ui://garmin-mcp/charts.html" });
		expect(app.result.contents[0].mimeType).toBe("text/html;profile=mcp-app");
		expect(app.result.contents[0].text).toContain("ui/initialize");

		const call = await mcp.send("tools/call", { name: "get_sleep_data", arguments: { date: "2026-11-25" } });
		expect(call.result.isError ?? false).toBe(false);
		const sleep = JSON.parse(call.result.content[0].text);
		expect(sleep).toMatchObject({ calendarDate: "2026-11-25", totalSleepHours: 7.5, sleepScore: 84 });

		// The Worker traded the API key for a Garmin token, then used it as a Bearer token.
		expect(garminRequests[0]).toEqual({
			url: `${GARMIN}/personalapitoken-service/personal-api/personal-api-key/token`,
			auth: "ApiKey e2e-test-garmin-key",
		});
		expect(garminRequests.at(-1)).toEqual({
			url: `${GARMIN}/sleep-service/sleep/dailySleep?date=2026-11-25`,
			auth: `Bearer ${GARMIN_TOKEN}`,
		});
	});

	it("tool errors from Garmin reach the client as readable tool errors", async () => {
		network.use(http.get(`${GARMIN}/sleep-service/sleep/dailySleep`, () => new HttpResponse("slow down", { status: 429 })));
		const { tokens } = await connectClient();
		const mcp = await mcpSession(tokens.access_token);
		const call = await mcp.send("tools/call", { name: "get_sleep_data", arguments: { date: "2026-11-25" } });
		expect(call.result.isError).toBe(true);
		expect(call.result.content[0].text).toMatch(/Rate limited/);
	});

	it("the refresh token gives a new working access token; a made-up token is refused", async () => {
		const { clientId, tokens } = await connectClient();
		const refreshed = await fetchWorker("/token", form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token!, client_id: clientId }));
		expect(refreshed.status).toBe(200);
		const next = (await refreshed.json()) as { access_token: string };
		expect(next.access_token).not.toBe(tokens.access_token);
		const mcp = await mcpSession(next.access_token);
		expect(mcp.init.result.serverInfo.name).toBe("garmin-connect");

		const forged = await fetchWorker("/mcp", {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer not-a-real-token" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		expect(forged.status).toBe(401);
	});

	it("grants only the read scope, whatever extra scopes a client asks for", async () => {
		const { tokens } = await connectClient("garmin:read");
		expect(tokens.scope).toBe("garmin:read");
		const greedy = await connectClient("garmin:read offline_access");
		expect(greedy.tokens.scope?.split(" ").sort()).toEqual(["garmin:read", "offline_access"]);
	});
});
