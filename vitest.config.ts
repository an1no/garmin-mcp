import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The e2e Worker gets test-only secrets through `miniflare.bindings` below (they take precedence
// over anything else). These placeholders only stop the plugin from warning that the secrets
// listed in wrangler.jsonc's `secrets.required` are missing.
process.env.GARMIN_PERSONAL_API_KEY ??= "e2e-test-garmin-key";
process.env.MCP_ADMIN_PASSWORD ??= "e2e-test-admin-password";

/**
 * Two test projects:
 * - unit: Node, fast; modules that only exist inside Workers are replaced by small stubs
 *   (test/stubs), and test/setup.ts adds the Workers-only crypto.subtle.timingSafeEqual.
 * - e2e: the whole Worker inside a local workerd (Miniflare), with its own throwaway KV and
 *   Durable Objects, test-only secrets and Garmin mocked by MSW. Nothing reaches Cloudflare,
 *   the deployed server or Garmin.
 */
export default defineConfig({
	test: {
		projects: [
			{
				resolve: {
					alias: {
						"cloudflare:workers": fileURLToPath(new URL("./test/stubs/cloudflare-workers.ts", import.meta.url)),
					},
				},
				test: {
					name: "unit",
					include: ["test/**/*.test.ts"],
					exclude: ["test/e2e/**"],
					setupFiles: ["test/setup.ts"],
					environment: "node",
					// Bundle the OAuth library through Vite so the cloudflare:workers alias applies to it too.
					server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
					restoreMocks: true,
					unstubGlobals: true,
				},
			},
			{
				plugins: [
					cloudflareTest({
						wrangler: { configPath: "./wrangler.jsonc" },
						miniflare: {
							// Test-only values; the real secrets live in Cloudflare and are never used here.
							bindings: {
								GARMIN_PERSONAL_API_KEY: "e2e-test-garmin-key",
								MCP_ADMIN_PASSWORD: "e2e-test-admin-password",
								TIMEZONE: "UTC",
								// Fixed here so the tests don't depend on the deployment's own setting in wrangler.jsonc.
								CYCLE_TRACKING: "off",
								DAILY_SUMMARY_HOUR: "8",
								TELEGRAM_BOT_TOKEN: "123456789:e2e-test-telegram-token-not-real-xx",
								TELEGRAM_CHAT_ID: "424242",
							},
						},
					}),
				],
				test: {
					name: "e2e",
					include: ["test/e2e/**/*.test.ts"],
					setupFiles: ["test/e2e/setup.ts"],
					// The MCP SDK's ajv is CommonJS with extension-less require()s, which workerd's module
					// loader can't resolve; pre-bundling it with Vite fixes that (Cloudflare's documented fix).
					deps: { optimizer: { ssr: { enabled: true, include: ["ajv", "ajv-formats"] } } },
					// McpAgent talks to its Durable Object over a WebSocket, which per-file storage
					// isolation doesn't support (Cloudflare's known issue): share storage instead.
					isolate: false,
					maxWorkers: 1,
					// Runs after the unit project (Vitest requires a separate group for a different maxWorkers).
					sequence: { groupOrder: 1 },
				},
			},
		],
	},
});
