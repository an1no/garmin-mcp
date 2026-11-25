/**
 * Helpers for tools that combine several Garmin requests: one failing request is reported next
 * to the others' results instead of failing the whole tool.
 */
import { GarminApiError } from "./garmin";

/** A short, readable reason for a failed Garmin request. */
export function describeError(error: unknown): string {
	if (error instanceof GarminApiError) return error.message;
	if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
		return "Garmin did not respond in time.";
	}
	return error instanceof Error ? error.message : String(error);
}

export type PartsResult<K extends string, T> = {
	/** Parts that returned data. */
	results: Partial<Record<K, T>>;
	/** Parts whose request failed, with the reason. */
	errors: Partial<Record<K, string>>;
	/** Parts that succeeded but had no data (the fetcher returned undefined). */
	missing: K[];
};

/**
 * Runs the fetchers for `parts` in parallel. If every part fails, the first error is thrown,
 * so a tool with nothing to show still reports a proper error.
 */
export async function fetchParts<K extends string, T>(
	fetchers: Record<K, () => Promise<T | undefined>>,
	parts: readonly K[],
): Promise<PartsResult<K, T>> {
	const results: Partial<Record<K, T>> = {};
	const errors: Partial<Record<K, string>> = {};
	const missing: K[] = [];
	const failures: unknown[] = [];
	await Promise.all(
		parts.map(async (part) => {
			try {
				const value = await fetchers[part]();
				if (value === undefined) missing.push(part);
				else results[part] = value;
			} catch (error) {
				errors[part] = describeError(error);
				failures.push(error);
			}
		}),
	);
	if (parts.length > 0 && failures.length === parts.length) throw failures[0];
	// Keep the caller's order, whatever order the requests finished in.
	missing.sort((a, b) => parts.indexOf(a) - parts.indexOf(b));
	return { results, errors, missing };
}
