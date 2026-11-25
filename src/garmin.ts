/**
 * Minimal client for the Garmin Connect Personal API.
 *
 * Auth flow (https://developer.garmin.com/gc-developer-program/personal/personal-api):
 *   1. POST {BASE}/personalapitoken-service/personal-api/personal-api-key/token
 *      with `Authorization: ApiKey <GARMIN_PERSONAL_API_KEY>` returns an access token.
 *   2. Every data request sends `Authorization: Bearer <access_token>`.
 *
 * Access tokens live for 24 hours (or until the API key expires). To avoid calling the
 * token endpoint on every MCP tool call, the token is cached:
 *   - in memory for the lifetime of the isolate / Durable Object, and
 *   - in KV (OAUTH_KV), AES-GCM encrypted with a key derived from the API key, under a key
 *     name that includes a fingerprint of the API key (so rotating the key invalidates it).
 */

export const GARMIN_API_BASE = "https://personal.connectapi.garmin.com";
const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";

/** Refresh this long before Garmin says the token expires. */
const EXPIRY_SAFETY_MARGIN_SECONDS = 10 * 60;
/** Never cache longer than this, whatever the token endpoint claims. */
const MAX_CACHE_SECONDS = 23 * 60 * 60;
/** Used when the token response carries no lifetime at all (Garmin documents 24 h). */
const DEFAULT_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;
/** Cloudflare KV's minimum expirationTtl. */
const KV_MIN_TTL_SECONDS = 60;
const REQUEST_TIMEOUT_MS = 25_000;
const USER_AGENT = "garmin-mcp-worker/1.0";

export class GarminApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly path: string,
	) {
		super(message);
		this.name = "GarminApiError";
	}
}

export type QueryValue = string | number | boolean | undefined | null;

interface CachedToken {
	token: string;
	/** Epoch ms after which the token must not be used. */
	expiresAt: number;
}

/** Isolate-level cache, keyed by API-key fingerprint. */
const memoryCache = new Map<string, CachedToken>();

export class GarminClient {
	private fingerprintPromise?: Promise<string>;
	private cryptoKeyPromise?: Promise<CryptoKey>;

	constructor(
		private readonly apiKey: string,
		private readonly kv: KVNamespace,
	) {
		if (!apiKey || !apiKey.trim()) {
			throw new GarminApiError(
				"GARMIN_PERSONAL_API_KEY is not configured. Run `npx wrangler secret put GARMIN_PERSONAL_API_KEY`.",
				500,
				TOKEN_PATH,
			);
		}
	}

	/** GET a JSON resource. Retries once with a fresh token on 401. */
	async get<T = unknown>(path: string, query: Record<string, QueryValue> = {}): Promise<T> {
		const url = new URL(path, GARMIN_API_BASE);
		for (const [key, value] of Object.entries(query)) {
			if (value !== undefined && value !== null && value !== "") {
				url.searchParams.set(key, String(value));
			}
		}

		let token = await this.getAccessToken();
		let response = await this.fetchWithToken(url, token);

		if (response.status === 401) {
			// Token revoked or expired early: drop the cache and retry once.
			await this.invalidateToken();
			token = await this.getAccessToken();
			response = await this.fetchWithToken(url, token);
		}

		if (!response.ok) {
			throw await toApiError(response, path);
		}

		if (response.status === 204) return null as T;
		const text = await response.text();
		if (!text.trim()) return null as T;
		try {
			return JSON.parse(text) as T;
		} catch {
			throw new GarminApiError(`Garmin returned a non-JSON response for ${path}.`, 502, path);
		}
	}

	private fetchWithToken(url: URL, token: string): Promise<Response> {
		return fetch(url.toString(), {
			method: "GET",
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/json",
				"User-Agent": USER_AGENT,
			},
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	}

	/** Returns a valid access token, from memory, KV or the token endpoint (in that order). */
	async getAccessToken(): Promise<string> {
		const fingerprint = await this.fingerprint();
		const now = Date.now();

		const inMemory = memoryCache.get(fingerprint);
		if (inMemory && inMemory.expiresAt > now) return inMemory.token;

		const fromKv = await this.readKvToken(fingerprint);
		if (fromKv && fromKv.expiresAt > now) {
			memoryCache.set(fingerprint, fromKv);
			return fromKv.token;
		}

		const fresh = await this.requestNewToken();
		memoryCache.set(fingerprint, fresh);
		await this.writeKvToken(fingerprint, fresh);
		return fresh.token;
	}

	async invalidateToken(): Promise<void> {
		const fingerprint = await this.fingerprint();
		memoryCache.delete(fingerprint);
		await this.kv.delete(kvKey(fingerprint));
	}

	private async requestNewToken(): Promise<CachedToken> {
		const response = await fetch(new URL(TOKEN_PATH, GARMIN_API_BASE).toString(), {
			method: "POST",
			headers: {
				Authorization: `ApiKey ${this.apiKey.trim()}`,
				// The token endpoint answers 406 to `Accept: application/json` alone (Garmin's own
				// curl example sends `*/*`), so accept whatever it produces; both JSON and a bare
				// token string are parsed below.
				Accept: "application/json, text/plain, */*",
				"User-Agent": USER_AGENT,
			},
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});

		if (!response.ok) {
			const error = await toApiError(response, TOKEN_PATH);
			if (response.status === 401 || response.status === 403) {
				error.message =
					"Garmin rejected the Personal API key (it may be expired, deleted or mistyped). " +
					"Create a new key in Garmin Connect and run `npx wrangler secret put GARMIN_PERSONAL_API_KEY`. " +
					`Details: ${error.message}`;
			}
			throw error;
		}

		const raw = (await response.text()).trim();
		let token: string | undefined;
		let expiresIn: number | undefined;

		try {
			const body = JSON.parse(raw) as Record<string, unknown>;
			token = firstString(body, ["access_token", "accessToken", "token"]);
			expiresIn = firstNumber(body, ["expires_in", "expiresIn"]);
			const expiresAt = firstNumber(body, ["expires_at", "expiresAt", "expiration"]);
			if (expiresIn === undefined && expiresAt !== undefined) {
				// Accept either epoch seconds or epoch milliseconds.
				const expiresAtMs = expiresAt > 1e12 ? expiresAt : expiresAt * 1000;
				expiresIn = Math.floor((expiresAtMs - Date.now()) / 1000);
			}
		} catch {
			// Some token endpoints answer with the bare token string.
			if (raw && !/\s/.test(raw)) token = raw.replace(/^"|"$/g, "");
		}

		if (!token) {
			throw new GarminApiError(
				"Garmin's token endpoint returned no access_token.",
				502,
				TOKEN_PATH,
			);
		}

		expiresIn ??= jwtSecondsUntilExpiry(token) ?? DEFAULT_TOKEN_LIFETIME_SECONDS;
		const cacheSeconds = Math.min(
			MAX_CACHE_SECONDS,
			Math.max(KV_MIN_TTL_SECONDS, expiresIn - EXPIRY_SAFETY_MARGIN_SECONDS),
		);

		return { token, expiresAt: Date.now() + cacheSeconds * 1000 };
	}

	private async readKvToken(fingerprint: string): Promise<CachedToken | null> {
		const stored = await this.kv.get<{ iv: string; data: string; expiresAt: number }>(
			kvKey(fingerprint),
			"json",
		);
		if (!stored) return null;
		try {
			const key = await this.cryptoKey();
			const plaintext = await crypto.subtle.decrypt(
				{ name: "AES-GCM", iv: base64ToBytes(stored.iv) },
				key,
				base64ToBytes(stored.data),
			);
			return { token: new TextDecoder().decode(plaintext), expiresAt: stored.expiresAt };
		} catch {
			// Corrupt or encrypted with another key: ignore and fetch a fresh token.
			return null;
		}
	}

	private async writeKvToken(fingerprint: string, cached: CachedToken): Promise<void> {
		const ttlSeconds = Math.floor((cached.expiresAt - Date.now()) / 1000);
		if (ttlSeconds < KV_MIN_TTL_SECONDS) return;

		const key = await this.cryptoKey();
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const ciphertext = await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv },
			key,
			new TextEncoder().encode(cached.token),
		);
		await this.kv.put(
			kvKey(fingerprint),
			JSON.stringify({
				iv: bytesToBase64(iv),
				data: bytesToBase64(new Uint8Array(ciphertext)),
				expiresAt: cached.expiresAt,
			}),
			{ expirationTtl: ttlSeconds },
		);
	}

	/** Short, non-reversible identifier of the API key, used in the KV key name. */
	private fingerprint(): Promise<string> {
		this.fingerprintPromise ??= sha256(`garmin-mcp:fingerprint:${this.apiKey.trim()}`).then(
			(digest) => bytesToHex(digest).slice(0, 24),
		);
		return this.fingerprintPromise;
	}

	/** AES-256-GCM key derived from the API key, so KV alone can't reveal the access token. */
	private cryptoKey(): Promise<CryptoKey> {
		this.cryptoKeyPromise ??= sha256(`garmin-mcp:token-cache:${this.apiKey.trim()}`).then(
			(digest) => crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]),
		);
		return this.cryptoKeyPromise;
	}
}

function kvKey(fingerprint: string): string {
	return `garmin:access-token:${fingerprint}`;
}

async function toApiError(response: Response, path: string): Promise<GarminApiError> {
	let detail = "";
	try {
		detail = (await response.text()).slice(0, 500).trim();
	} catch {
		// ignore
	}
	const hints: Record<number, string> = {
		400: "Bad request - check the parameters (dates must be YYYY-MM-DD and ranges within Garmin's limits).",
		401: "Unauthorized - the Garmin access token was rejected.",
		403: "Forbidden - this Personal API key may not have access to this resource.",
		404: "Not found - no data exists for that id/date.",
		429: "Rate limited by Garmin - wait a bit and try again.",
	};
	const hint = hints[response.status] ?? (response.status >= 500 ? "Garmin service error - try again later." : "");
	const message = `Garmin API ${response.status} ${response.statusText || ""} on ${path}. ${hint}${detail ? ` Response: ${detail}` : ""}`
		.replace(/\s+/g, " ")
		.trim();
	return new GarminApiError(message, response.status, path);
}

function firstString(body: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = body[key];
		if (typeof value === "string" && value) return value;
	}
	return undefined;
}

function firstNumber(body: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = body[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
	}
	return undefined;
}

/** If the token is a JWT with an `exp` claim, seconds until it expires. */
function jwtSecondsUntilExpiry(token: string): number | undefined {
	const parts = token.split(".");
	if (parts.length !== 3 || !parts[1]) return undefined;
	try {
		const payload = JSON.parse(new TextDecoder().decode(base64ToBytes(parts[1]))) as { exp?: unknown };
		if (typeof payload.exp === "number") return Math.floor(payload.exp - Date.now() / 1000);
	} catch {
		// not a JWT
	}
	return undefined;
}

async function sha256(input: string): Promise<ArrayBuffer> {
	return crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
}

function bytesToHex(buffer: ArrayBuffer): string {
	return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/** Accepts standard and URL-safe base64, with or without padding. */
function base64ToBytes(input: string): Uint8Array<ArrayBuffer> {
	let normalized = input.replace(/-/g, "+").replace(/_/g, "/");
	while (normalized.length % 4) normalized += "=";
	const binary = atob(normalized);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
