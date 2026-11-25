/** Minimal stand-in for the `cloudflare:workers` module, which only exists inside workerd. */
export class WorkerEntrypoint<Env = unknown> {
	constructor(
		protected ctx?: unknown,
		protected env?: Env,
	) {}
}

export class DurableObject<Env = unknown> {
	constructor(
		protected ctx?: unknown,
		protected env?: Env,
	) {}
}

export const env = {};
