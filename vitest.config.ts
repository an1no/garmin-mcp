import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Unit tests run in Node. Modules that only exist inside Workers are replaced by small stubs
 * (see test/stubs), and test/setup.ts adds the Workers-only crypto.subtle.timingSafeEqual.
 */
export default defineConfig({
	resolve: {
		alias: {
			"cloudflare:workers": fileURLToPath(new URL("./test/stubs/cloudflare-workers.ts", import.meta.url)),
		},
	},
	test: {
		include: ["test/**/*.test.ts"],
		setupFiles: ["test/setup.ts"],
		environment: "node",
		// Bundle the OAuth library through Vite so the cloudflare:workers alias applies to it too.
		server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
		restoreMocks: true,
		unstubGlobals: true,
	},
});
