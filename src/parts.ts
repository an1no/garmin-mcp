/**
 * Helpers for tools that combine several Garmin requests: one failing request is reported next
 * to the others' results instead of failing the whole tool.
 */
import { addDays } from "./format";
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

/** Splits [startDate, endDate] into consecutive ranges of at most `size` days. */
export function chunkRange(startDate: string, endDate: string, size: number): { startDate: string; endDate: string }[] {
	const out: { startDate: string; endDate: string }[] = [];
	let cursor = startDate;
	while (cursor <= endDate) {
		const last = addDays(cursor, size - 1);
		out.push({ startDate: cursor, endDate: last < endDate ? last : endDate });
		cursor = addDays(last, 1);
	}
	return out;
}

/** Maps `items` with at most `limit` calls of `fn` running at once, keeping the order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i]!);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}
