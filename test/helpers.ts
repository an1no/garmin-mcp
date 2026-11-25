/** Shared fakes for the unit tests. */
import type { GarminClient } from "../src/garmin";

/** In-memory KV with the subset of the API the server uses; records puts and honours "json" reads. */
export class FakeKV {
	store = new Map<string, string>();
	puts: { key: string; value: string; options?: KVNamespacePutOptions }[] = [];
	deletes: string[] = [];

	async get(key: string, type?: "text" | "json" | { type: "text" | "json" }): Promise<unknown> {
		const value = this.store.get(key);
		if (value === undefined) return null;
		const kind = typeof type === "object" ? type.type : type;
		return kind === "json" ? JSON.parse(value) : value;
	}

	async put(key: string, value: string, options?: KVNamespacePutOptions): Promise<void> {
		this.puts.push({ key, value, options });
		this.store.set(key, value);
	}

	async delete(key: string): Promise<void> {
		this.deletes.push(key);
		this.store.delete(key);
	}

	asKV(): KVNamespace {
		return this as unknown as KVNamespace;
	}
}

export type GarminCall = { path: string; query: Record<string, unknown> };

/** A GarminClient stand-in whose `get` is answered by `handler`. */
export function fakeGarmin(handler: (path: string, query: Record<string, unknown>) => unknown) {
	const calls: GarminCall[] = [];
	const fake = {
		calls,
		tokenCalls: 0,
		async getAccessToken() {
			fake.tokenCalls++;
			return "token";
		},
		async get(path: string, query: Record<string, unknown> = {}) {
			calls.push({ path, query });
			return handler(path, query);
		},
	};
	return Object.assign(fake, { client: fake as unknown as GarminClient });
}

/** Epoch ms of a UTC ISO date-time without the trailing Z. */
export const gmt = (iso: string) => Date.parse(`${iso}Z`);

/** Inclusive day count of a YYYY-MM-DD range. */
export const spanDays = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
