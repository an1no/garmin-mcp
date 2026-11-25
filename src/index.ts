/**
 * Garmin Connect MCP server for Cloudflare Workers.
 *
 *   /mcp                                     MCP endpoint (Streamable HTTP), requires an OAuth access token
 *   /authorize                               Password-protected consent page (auth-handler.ts)
 *   /token, /register                        OAuth 2.1 token endpoint and Dynamic Client Registration
 *   /.well-known/oauth-authorization-server  Authorization server metadata (RFC 8414)
 *   /.well-known/oauth-protected-resource    Protected resource metadata (RFC 9728)
 *
 * A cron trigger sends the optional morning summary to Telegram (summary.ts).
 */

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { authHandler, GARMIN_READ_SCOPE } from "./auth-handler";
import { GarminMCP } from "./mcp";
import { logDailySummary, runDailySummary, type SummaryEnv } from "./summary";

// Durable Object class referenced by wrangler.jsonc (MCP_OBJECT binding).
export { GarminMCP };

const MCP_PATH = "/mcp";
const DAY = 24 * 60 * 60;

/**
 * The OAuth resource identifier must be the exact URL clients connect to
 * (https://<worker>.<subdomain>.workers.dev/mcp). It is derived from the request origin,
 * so the same code works on workers.dev, a custom domain and `wrangler dev`
 * without editing any config. One provider is built per origin and reused.
 */
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string): OAuthProvider<Env> {
	let provider = providers.get(origin);
	if (provider) return provider;

	provider = new OAuthProvider<Env>({
		apiRoute: MCP_PATH,
		apiHandler: GarminMCP.serve(MCP_PATH),
		defaultHandler: authHandler,
		authorizeEndpoint: "/authorize",
		tokenEndpoint: "/token",
		clientRegistrationEndpoint: "/register", // Dynamic Client Registration (RFC 7591), used by Gemini
		clientIdMetadataDocumentEnabled: true, // also accept URL-based client IDs (CIMD)
		scopesSupported: [GARMIN_READ_SCOPE, "offline_access"],
		requiredScopes: [GARMIN_READ_SCOPE],
		resourceMetadata: {
			resource: `${origin}${MCP_PATH}`,
			resource_name: "Garmin Connect (personal)",
		},
		accessTokenTTL: 60 * 60, // 1 hour; clients refresh silently
		refreshTokenTTL: 30 * DAY,
		refreshTokenIdleTTL: 30 * DAY, // sliding window: stays connected while used at least monthly
	});

	if (providers.size >= 8) providers.clear();
	providers.set(origin, provider);
	return provider;
}

export default {
	async fetch(request, env, ctx) {
		const { origin } = new URL(request.url);
		let provider: OAuthProvider<Env>;
		try {
			provider = providerFor(origin);
		} catch (error) {
			// e.g. plain-http access on a non-loopback host during local development
			console.error(`Cannot serve OAuth for origin ${origin}:`, error);
			return new Response("This server must be accessed over HTTPS (or http://localhost for development).", {
				status: 400,
			});
		}
		return provider.fetch(request, env, ctx);
	},

	// Cron trigger (wrangler.jsonc): the morning summary in Telegram, when it's set up (summary.ts).
	async scheduled(controller, env) {
		try {
			logDailySummary(await runDailySummary(env as SummaryEnv, new Date(controller.scheduledTime)));
		} catch (error) {
			console.error("Daily summary failed:", error instanceof Error ? error.name : "unknown error");
		}
	},
} satisfies ExportedHandler<Env>;
