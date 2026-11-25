import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GarminClient } from "./garmin";
import { resolveTimeZone } from "./profile";
import { registerTools, SERVER_INFO, SERVER_INSTRUCTIONS } from "./tools";

/** Props stored in the OAuth grant by the /authorize handler (see auth-handler.ts). */
export type AuthProps = {
	user: string;
	authorizedAt: string;
};

/**
 * One Durable Object instance per MCP session. Tools (see tools.ts) call the Garmin Connect
 * Personal API using the API key stored as the GARMIN_PERSONAL_API_KEY secret.
 */
export class GarminMCP extends McpAgent<Env, Record<string, never>, AuthProps> {
	server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

	private client?: GarminClient;
	private timeZone?: string;

	private garmin(): GarminClient {
		this.client ??= new GarminClient(this.env.GARMIN_PERSONAL_API_KEY, this.env.OAUTH_KV);
		return this.client;
	}

	/** The configured timezone, or the Garmin profile's one when TIMEZONE is "auto". */
	private async zone(): Promise<string> {
		if (this.timeZone) return this.timeZone;
		const resolved = await resolveTimeZone(this.env.TIMEZONE, this.garmin(), this.env.OAUTH_KV);
		if (resolved.cacheable) this.timeZone = resolved.zone;
		return resolved.zone;
	}

	async init(): Promise<void> {
		registerTools(this.server, { garmin: () => this.garmin(), zone: () => this.zone() });
	}
}
