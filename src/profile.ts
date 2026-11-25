/**
 * The timezone that decides what "today" means when a tool call has no date.
 *
 * TIMEZONE in wrangler.jsonc can name a zone (e.g. "Europe/Berlin"), which always wins.
 * With "auto" (the default) the server uses the time zone from the user's Garmin profile,
 * cached in KV for a day so most sessions don't need the extra request.
 */
import type { GarminClient } from "./garmin";

const KV_KEY = "garmin:profile:timezone";
const KV_TTL_SECONDS = 24 * 60 * 60;
const PROFILE_PATH = "/userprofile-service/userprofile/settings";

export function isValidTimeZone(zone: string | undefined | null): zone is string {
	if (!zone || !zone.trim()) return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: zone.trim() }).format(0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolves the timezone. `cacheable` is false when the result is only a fallback after the
 * Garmin profile couldn't be read, so callers can try again on the next request.
 */
export async function resolveTimeZone(
	configured: string | undefined,
	garmin: Pick<GarminClient, "get">,
	kv: Pick<KVNamespace, "get" | "put">,
): Promise<{ zone: string; source: "config" | "garmin-profile" | "fallback"; cacheable: boolean }> {
	const setting = configured?.trim() ?? "";
	if (setting.toLowerCase() !== "auto" && setting !== "" && isValidTimeZone(setting)) {
		return { zone: setting, source: "config", cacheable: true };
	}

	const cached = await kv.get(KV_KEY).catch(() => null);
	if (isValidTimeZone(cached)) return { zone: cached, source: "garmin-profile", cacheable: true };

	try {
		const settings = await garmin.get<{ timeZone?: unknown }>(PROFILE_PATH);
		const fromProfile = typeof settings?.timeZone === "string" ? settings.timeZone.trim() : "";
		if (isValidTimeZone(fromProfile)) {
			await kv.put(KV_KEY, fromProfile, { expirationTtl: KV_TTL_SECONDS }).catch(() => {});
			return { zone: fromProfile, source: "garmin-profile", cacheable: true };
		}
		// The profile has no usable zone: settle on UTC for now, and look again tomorrow.
		await kv.put(KV_KEY, "UTC", { expirationTtl: KV_TTL_SECONDS }).catch(() => {});
		return { zone: "UTC", source: "fallback", cacheable: true };
	} catch {
		return { zone: "UTC", source: "fallback", cacheable: false };
	}
}
