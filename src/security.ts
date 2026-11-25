/**
 * Password check and brute-force protection for the /authorize page.
 *
 * - The password is compared in constant time (SHA-256 both sides, then timingSafeEqual).
 * - Failed attempts are counted in KV per client IP and globally:
 *     per IP : 5 failures  -> locked for 15 minutes
 *     global : 20 failures -> locked for 1 hour (stops distributed guessing)
 *   A lockout only blocks *new* authorizations; already-connected clients keep working.
 */

export const MIN_PASSWORD_LENGTH = 8;

const IP_MAX_FAILURES = 5;
const IP_WINDOW_SECONDS = 15 * 60;
const GLOBAL_MAX_FAILURES = 20;
const GLOBAL_WINDOW_SECONDS = 60 * 60;

export function isPasswordConfigured(password: string | undefined): password is string {
	return typeof password === "string" && password.length >= MIN_PASSWORD_LENGTH;
}

export async function verifyPassword(candidate: string, expected: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const [a, b] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
		crypto.subtle.digest("SHA-256", encoder.encode(expected)),
	]);
	return crypto.subtle.timingSafeEqual(a, b);
}

export function clientIp(request: Request): string {
	return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

interface Counter {
	count: number;
	/** Epoch ms when the window ends. */
	resetAt: number;
}

const ipKey = (ip: string) => `auth-fail:ip:${ip}`;
const GLOBAL_KEY = "auth-fail:global";

async function readCounter(kv: KVNamespace, key: string): Promise<Counter | null> {
	const counter = await kv.get<Counter>(key, "json");
	return counter && counter.resetAt > Date.now() ? counter : null;
}

/** Returns the number of seconds the caller must wait, or 0 if attempts are allowed. */
export async function lockoutSeconds(kv: KVNamespace, ip: string): Promise<number> {
	const [perIp, global] = await Promise.all([readCounter(kv, ipKey(ip)), readCounter(kv, GLOBAL_KEY)]);
	const now = Date.now();
	let wait = 0;
	if (perIp && perIp.count >= IP_MAX_FAILURES) wait = Math.max(wait, perIp.resetAt - now);
	if (global && global.count >= GLOBAL_MAX_FAILURES) wait = Math.max(wait, global.resetAt - now);
	return Math.ceil(wait / 1000);
}

export async function recordFailure(kv: KVNamespace, ip: string): Promise<void> {
	await Promise.all([
		bump(kv, ipKey(ip), IP_WINDOW_SECONDS),
		bump(kv, GLOBAL_KEY, GLOBAL_WINDOW_SECONDS),
	]);
}

export async function clearFailures(kv: KVNamespace, ip: string): Promise<void> {
	await kv.delete(ipKey(ip));
}

async function bump(kv: KVNamespace, key: string, windowSeconds: number): Promise<void> {
	const existing = await readCounter(kv, key);
	const now = Date.now();
	const counter: Counter = existing
		? { count: existing.count + 1, resetAt: existing.resetAt }
		: { count: 1, resetAt: now + windowSeconds * 1000 };
	const ttl = Math.max(60, Math.ceil((counter.resetAt - now) / 1000));
	await kv.put(key, JSON.stringify(counter), { expirationTtl: ttl });
}
