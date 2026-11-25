import { setupNetwork } from "@msw/cloudflare";

/** Intercepts the Worker's outbound fetch calls; tests register Garmin handlers with network.use(). */
export const network = setupNetwork();
