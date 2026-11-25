/**
 * Default (non-API) handler: the landing page and the OAuth /authorize consent page.
 *
 * When Gemini (or any MCP client) connects, it registers itself via Dynamic Client
 * Registration and sends the browser to /authorize. This page shows who is asking and
 * where access will be sent, and only completes the authorization when the correct
 * MCP_ADMIN_PASSWORD is entered.
 */

import { AuthorizationError, CimdFetchError, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { cycleTrackingEnabled } from "./cycle";
import { consentPage, homePage, htmlHeaders, messagePage } from "./html";
import type { AuthProps } from "./mcp";
import {
	clearFailures,
	clientIp,
	isPasswordConfigured,
	lockoutSeconds,
	MIN_PASSWORD_LENGTH,
	recordFailure,
	verifyPassword,
} from "./security";

/** OAuthProvider injects its helpers into the default handler's env. */
type AuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

/** The single owner of this server. Must not contain ":". */
const OWNER_USER_ID = "owner";

/** Scope granted to every approved client (advertised in index.ts). */
export const GARMIN_READ_SCOPE = "garmin:read";

export const authHandler: ExportedHandler<Env> = {
	async fetch(request, env) {
		const url = new URL(request.url);
		const authEnv = env as AuthEnv;

		try {
			if (url.pathname === "/authorize") {
				if (request.method === "GET") return await showConsent(request, authEnv);
				if (request.method === "POST") return await submitConsent(request, authEnv);
				return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, POST" } });
			}

			if (url.pathname === "/" && request.method === "GET") {
				return new Response(homePage(`${url.origin}/mcp`), { headers: htmlHeaders() });
			}

			if (url.pathname === "/robots.txt") {
				return new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain" } });
			}

			return new Response("Not Found", { status: 404 });
		} catch (error) {
			return handleAuthError(error);
		}
	},
};

async function showConsent(request: Request, env: AuthEnv): Promise<Response> {
	if (!isPasswordConfigured(env.MCP_ADMIN_PASSWORD)) return notConfigured();

	const oauth = env.OAUTH_PROVIDER;
	const authRequest = await oauth.parseAuthRequest(request);
	const details = await oauth.describeConsent(authRequest); // before beginConsent: a failed lookup leaves nothing in KV
	const consent = await oauth.beginConsent(authRequest);
	return new Response(consentPage(details, consent.handle, undefined, consentOptions(env)), {
		headers: htmlHeaders(consent.headers),
	});
}

/** What the approval page should mention, from the deployment's settings. */
function consentOptions(env: AuthEnv): { cycleTracking: boolean } {
	return { cycleTracking: cycleTrackingEnabled(env.CYCLE_TRACKING) };
}

async function submitConsent(request: Request, env: AuthEnv): Promise<Response> {
	if (!isPasswordConfigured(env.MCP_ADMIN_PASSWORD)) return notConfigured();

	const oauth = env.OAUTH_PROVIDER;
	const form = await request.formData();
	const handle = String(form.get("handle") ?? "");
	const decision = String(form.get("decision") ?? "");
	const password = String(form.get("password") ?? "");

	if (decision === "deny") {
		const denied = await oauth.denyConsent(request, handle);
		logAuthorize("denied");
		return new Response(null, { status: 302, headers: denied.headers });
	}

	const ip = clientIp(request);
	const wait = await lockoutSeconds(env.OAUTH_KV, ip);
	if (wait > 0) {
		logAuthorize("locked_out", { retryAfterSeconds: wait });
		return new Response(
			messagePage(
				"Too many attempts",
				`Too many incorrect passwords. Try again in about ${Math.ceil(wait / 60)} minute(s), then restart the connection from your app.`,
			),
			{ status: 429, headers: htmlHeaders(new Headers({ "Retry-After": String(wait) })) },
		);
	}

	if (!(await verifyPassword(password, env.MCP_ADMIN_PASSWORD))) {
		await recordFailure(env.OAUTH_KV, ip);
		logAuthorize("wrong_password");
		// The handle has not been consumed, so the same page can be shown again.
		// The authorization request is re-read from this POST's URL (the form posts back to it).
		const authRequest = await oauth.parseAuthRequest(request);
		const details = await oauth.describeConsent(authRequest);
		return new Response(consentPage(details, handle, "Incorrect password. Please try again.", consentOptions(env)), {
			status: 401,
			headers: htmlHeaders(),
		});
	}

	await clearFailures(env.OAUTH_KV, ip);

	// Grant a fixed, read-only scope (plus refresh tokens if the client asked for them),
	// regardless of what the client requested.
	const requested = (new URL(request.url).searchParams.get("scope") ?? "").split(" ");
	const scope = [GARMIN_READ_SCOPE, ...(requested.includes("offline_access") ? ["offline_access"] : [])];

	const approved = await oauth.approveConsent(request, handle, { scope });
	const props: AuthProps = { user: OWNER_USER_ID, authorizedAt: new Date().toISOString() };
	const { redirectTo } = await oauth.completeAuthorization({
		request: approved.request, // from server-side storage, not from the form
		userId: OWNER_USER_ID,
		metadata: { label: "Garmin MCP owner", authorizedAt: props.authorizedAt },
		scope: approved.request.scope,
		props,
	});

	logAuthorize("approved", { scope: approved.request.scope });
	const headers = new Headers(approved.headers);
	headers.set("Location", redirectTo);
	return new Response(null, { status: 302, headers });
}

/**
 * One structured log line per approval-page decision, for Workers Logs (filter on event = "authorize").
 * No password, IP address or client details are logged.
 */
function logAuthorize(outcome: "approved" | "denied" | "wrong_password" | "locked_out", extra: Record<string, unknown> = {}): void {
	console.log({ event: "authorize", outcome, ...extra });
}

function notConfigured(): Response {
	console.error(`MCP_ADMIN_PASSWORD is missing or shorter than ${MIN_PASSWORD_LENGTH} characters.`);
	return new Response(
		messagePage(
			"Server not configured",
			`The admin password is not set (or is shorter than ${MIN_PASSWORD_LENGTH} characters). ` +
				"Run `npx wrangler secret put MCP_ADMIN_PASSWORD` and try again.",
		),
		{ status: 503, headers: htmlHeaders() },
	);
}

function handleAuthError(error: unknown): Response {
	if (error instanceof AuthorizationError && error.redirectTo) {
		// Safe: the client and its redirect URI were validated.
		return Response.redirect(error.redirectTo, 302);
	}
	if (error instanceof AuthorizationError) {
		return new Response(
			messagePage(
				"Authorization failed",
				`${error.description} If this page expired or was already used, start the connection again from your app.`,
			),
			{ status: 400, headers: htmlHeaders() },
		);
	}
	if (error instanceof CimdFetchError) {
		return new Response(messagePage("Authorization failed", "This app could not be verified."), {
			status: 400,
			headers: htmlHeaders(),
		});
	}
	throw error;
}
