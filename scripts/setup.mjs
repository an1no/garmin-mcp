#!/usr/bin/env node
/**
 * One-command setup for the Garmin MCP server:   npm run setup
 *
 * 1. Installs dependencies if needed and checks the Cloudflare login (opens the browser if not).
 * 2. Asks for your Garmin Personal API key (hidden input) and checks it with Garmin.
 * 3. Generates an admin password, deploys the Worker with both secrets, and Wrangler creates
 *    the KV namespace automatically.
 * 4. Checks the live server and prints the URL to paste into Gemini.
 *
 * Re-running it is safe: it redeploys the code and keeps the existing admin password.
 *
 * Non-interactive use (for AI coding agents): if the Garmin key is not provided, the script
 * creates a git-ignored .secrets.env, asks the human to paste the key there, and exits with
 * code 2. Run it again after the file is saved. Secrets are never printed in that mode.
 *
 * Options:
 *   --name <worker-name>   Deploy under another Worker name (default: "name" in wrangler.jsonc)
 *   --update-key           Ask for a new Garmin key even if the Worker already has one
 *   --skip-garmin-check    Don't verify the Garmin key with Garmin before deploying
 *   --help
 *
 * Environment variables it understands: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,
 * GARMIN_PERSONAL_API_KEY, MCP_ADMIN_PASSWORD.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_FILE = join(ROOT, "wrangler.jsonc");
const SECRETS_FILE = join(ROOT, ".secrets.env");
const PASSWORD_FILE = join(ROOT, "admin-password.txt");
const WRANGLER = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const GARMIN_TOKEN_URL =
	"https://personal.connectapi.garmin.com/personalapitoken-service/personal-api/personal-api-key/token";
const GARMIN_KEY_PAGE_HINT =
	"Garmin Connect on the web (connect.garmin.com) -> open the Personal API Key page -> Create Key";
const MIN_PASSWORD_LENGTH = 12;

const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const env = { ...process.env };
/** Parsed command-line options; set at the start of main(). */
let args;

const USAGE = `Usage: npm run setup [-- options]

Options:
  --name <worker-name>   Deploy under another Worker name (default: "name" in wrangler.jsonc)
  --update-key           Ask for a new Garmin key even if the Worker already has one
  --skip-garmin-check    Don't verify the Garmin key with Garmin before deploying
  --help                 Show this help

Environment variables: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,
GARMIN_PERSONAL_API_KEY, MCP_ADMIN_PASSWORD (all optional).`;

// ---------------------------------------------------------------------------------- output

const color = (code) => (text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = color("1");
const green = color("32");
const yellow = color("33");
const red = color("31");
const step = (n, text) => console.log(`\n${bold(`[${n}/6]`)} ${bold(text)}`);
const ok = (text) => console.log(`  ${green("✓")} ${text}`);
const warn = (text) => console.log(`  ${yellow("!")} ${text}`);
const info = (text) => console.log(`    ${text}`);

class SetupError extends Error {
	constructor(message, exitCode = 1) {
		super(message);
		this.exitCode = exitCode;
	}
}

// ------------------------------------------------------------------------------------ main

async function main() {
	args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(USAGE);
		return;
	}

	console.log(bold("\nGarmin MCP server setup\n"));
	if (!interactive) info("Running non-interactively (no terminal input): secrets are read from .secrets.env.");

	// 1. Prerequisites ---------------------------------------------------------------------
	step(1, "Checking prerequisites");
	const [major] = process.versions.node.split(".").map(Number);
	if (major < 20) throw new SetupError(`Node.js 20 or newer is required (you have ${process.versions.node}).`);
	ok(`Node.js ${process.versions.node}`);
	if (!existsSync(WRANGLER)) {
		info("Installing dependencies (npm install)...");
		runNpmInstall();
	}
	ok("Dependencies installed");

	// 2. Cloudflare ------------------------------------------------------------------------
	step(2, "Checking your Cloudflare login");
	const account = await ensureCloudflareLogin();
	env.CLOUDFLARE_ACCOUNT_ID = account.id;
	ok(`Cloudflare account: ${account.name}`);

	const workerName = args.name ?? readConfigName();
	const existing = getExistingWorker(workerName);
	ok(existing ? `Worker "${workerName}" already exists: it will be updated` : `Worker "${workerName}" will be created`);

	// 3. Settings --------------------------------------------------------------------------
	step(3, "Settings");
	await configureTimezone();

	// 4. Secrets ---------------------------------------------------------------------------
	step(4, "Secrets");
	const fileSecrets = existsSync(SECRETS_FILE) ? parseEnvFile(readFileSync(SECRETS_FILE, "utf8")) : {};
	const secrets = {};

	const needKey = !existing || !existing.secrets.includes("GARMIN_PERSONAL_API_KEY") || args.updateKey;
	const providedKey = (env.GARMIN_PERSONAL_API_KEY || fileSecrets.GARMIN_PERSONAL_API_KEY || "").trim();
	if (needKey || providedKey) {
		secrets.GARMIN_PERSONAL_API_KEY = await obtainGarminKey(providedKey);
	} else {
		ok("Keeping the Garmin API key already stored on Cloudflare (use --update-key to replace it)");
	}

	let newPassword;
	const providedPassword = (env.MCP_ADMIN_PASSWORD || fileSecrets.MCP_ADMIN_PASSWORD || "").trim();
	if (providedPassword) {
		if (providedPassword.length < MIN_PASSWORD_LENGTH) {
			throw new SetupError(`MCP_ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`);
		}
		newPassword = providedPassword;
		ok("Using the admin password you provided");
	} else if (!existing || !existing.secrets.includes("MCP_ADMIN_PASSWORD")) {
		newPassword = randomBytes(24).toString("base64url");
		ok("Generated a strong admin password");
	} else {
		ok("Keeping the existing admin password");
	}
	if (newPassword) secrets.MCP_ADMIN_PASSWORD = newPassword;

	// 5. Deploy ----------------------------------------------------------------------------
	step(5, "Deploying to Cloudflare (Wrangler creates the KV storage automatically)");
	const url = deploy(workerName, secrets);
	ok(`Deployed: ${url}`);

	if (newPassword) {
		writeFileSync(PASSWORD_FILE, `${newPassword}\n`, { mode: 0o600 });
		ok("Admin password saved to admin-password.txt (git-ignored)");
	}
	if (existsSync(SECRETS_FILE)) {
		rmSync(SECRETS_FILE);
		ok("Deleted .secrets.env (the key now lives only on Cloudflare)");
	}

	// 6. Verify ----------------------------------------------------------------------------
	step(6, "Checking the live server");
	await verify(url);

	printNextSteps(url, newPassword);
}

// ------------------------------------------------------------------------------ Cloudflare

async function ensureCloudflareLogin() {
	let who = whoami();
	if (!who) {
		if (env.CLOUDFLARE_API_TOKEN) {
			throw new SetupError("CLOUDFLARE_API_TOKEN is set but Cloudflare rejected it. Fix or unset it and try again.");
		}
		info("Not logged in. Opening your browser to log in to Cloudflare (create a free account there if needed)...");
		const login = wrangler(["login"], { inherit: true });
		if (login.status !== 0) throw new SetupError("Cloudflare login did not complete. Run `npm run setup` again.");
		who = whoami();
		if (!who) throw new SetupError("Still not logged in to Cloudflare. Run `npx wrangler login`, then `npm run setup`.");
	}

	const accounts = who.accounts ?? [];
	if (env.CLOUDFLARE_ACCOUNT_ID) {
		const chosen = accounts.find((a) => a.id === env.CLOUDFLARE_ACCOUNT_ID);
		return chosen ?? { id: env.CLOUDFLARE_ACCOUNT_ID, name: env.CLOUDFLARE_ACCOUNT_ID };
	}
	if (accounts.length === 1) return accounts[0];
	if (accounts.length === 0) throw new SetupError("Your Cloudflare login has no accounts. Create one at dash.cloudflare.com.");

	const list = accounts.map((a, i) => `  ${i + 1}. ${a.name}  (${a.id})`).join("\n");
	if (!interactive) {
		throw new SetupError(`You have several Cloudflare accounts. Set CLOUDFLARE_ACCOUNT_ID to one of:\n${list}`);
	}
	console.log(`  You have several Cloudflare accounts:\n${list}`);
	for (;;) {
		const answer = await ask(`  Which one should host the server? [1-${accounts.length}]: `);
		const index = Number(answer) - 1;
		if (accounts[index]) return accounts[index];
	}
}

function whoami() {
	const result = wrangler(["whoami", "--json"]);
	if (result.status !== 0) return null;
	try {
		const parsed = JSON.parse(result.stdout);
		return parsed.loggedIn ? parsed : null;
	} catch {
		return null;
	}
}

/** Returns { secrets: string[] } when the Worker exists, null when it doesn't. */
function getExistingWorker(name) {
	const result = wrangler(["secret", "list", "--name", name, "--format", "json"]);
	if (result.status === 0) {
		try {
			const list = JSON.parse(result.stdout);
			return { secrets: Array.isArray(list) ? list.map((s) => s.name) : [] };
		} catch {
			return { secrets: [] };
		}
	}
	const output = `${result.stdout}\n${result.stderr}`;
	if (/10007|does not exist|not found|could not be found/i.test(output)) return null;
	throw new SetupError(`Could not check the Worker on Cloudflare:\n${output.trim()}`);
}

function deploy(name, secrets) {
	const temp = mkdtempSync(join(tmpdir(), "garmin-mcp-"));
	const outputFile = join(temp, "wrangler-output.json");
	const deployArgs = ["deploy", "--name", name];
	try {
		if (Object.keys(secrets).length > 0) {
			// JSON (not .env) so values are never shell-expanded; removed in `finally`.
			const secretsFile = join(temp, "secrets.json");
			writeFileSync(secretsFile, JSON.stringify(secrets), { mode: 0o600 });
			deployArgs.push("--secrets-file", secretsFile);
		}
		const result = wrangler(deployArgs, { inherit: true, extraEnv: { WRANGLER_OUTPUT_FILE_PATH: outputFile } });
		if (result.status !== 0) {
			throw new SetupError(
				[
					"The deploy failed (see Wrangler's message above). Common causes:",
					"  - \"register a workers.dev subdomain\": open dash.cloudflare.com -> Workers & Pages, pick a",
					"    subdomain (it applies to your whole account), then run `npm run setup` again.",
					"  - Several accounts: set CLOUDFLARE_ACCOUNT_ID and run again.",
					"  - Network problems: just run `npm run setup` again.",
				].join("\n"),
			);
		}
		const url = readDeployUrl(outputFile);
		if (!url) throw new SetupError("Deployed, but Wrangler didn't report a workers.dev URL. Check `workers_dev` in wrangler.jsonc.");
		return url;
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}

function readDeployUrl(outputFile) {
	if (!existsSync(outputFile)) return null;
	for (const line of readFileSync(outputFile, "utf8").split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			if (entry.type === "deploy" && Array.isArray(entry.targets)) {
				const target = entry.targets.find((t) => typeof t === "string" && t.includes(".workers.dev")) ?? entry.targets[0];
				if (target) return String(target).replace(/\/+$/, "");
			}
		} catch {
			// ignore non-JSON lines
		}
	}
	return null;
}

// ---------------------------------------------------------------------------------- Garmin

async function obtainGarminKey(provided) {
	let key = provided;
	for (;;) {
		if (!key) {
			if (!interactive) {
				if (!existsSync(SECRETS_FILE)) {
					writeFileSync(
						SECRETS_FILE,
						[
							"# Paste your Garmin Personal API key after the = sign (no quotes), save this file,",
							"# then run `npm run setup` again. This file is git-ignored and deleted after the deploy.",
							`# Get a key: ${GARMIN_KEY_PAGE_HINT}`,
							"GARMIN_PERSONAL_API_KEY=",
							"",
						].join("\n"),
						{ mode: 0o600 },
					);
				}
				throw new SetupError(
					`Your Garmin Personal API key is needed. Paste it into ${SECRETS_FILE} after GARMIN_PERSONAL_API_KEY=, save, and run \`npm run setup\` again.`,
					2,
				);
			}
			info(`Get your key here: ${GARMIN_KEY_PAGE_HINT}`);
			info("(It is shown only once when you create it. Choose an expiration of up to 1 year.)");
			key = (await askHidden("  Paste your Garmin Personal API key (input is hidden): ")).trim();
			if (!key) continue;
		}

		if (args.skipGarminCheck) {
			warn("Skipped checking the Garmin key (--skip-garmin-check)");
			return key;
		}
		const check = await checkGarminKey(key);
		if (check === "ok") {
			ok("Garmin accepted the API key");
			return key;
		}
		if (check === "unreachable") {
			warn("Couldn't reach Garmin to check the key; continuing anyway");
			return key;
		}
		const reason =
			check === "rejected"
				? "Garmin rejected this API key (mistyped, expired or deleted)."
				: `Garmin answered unexpectedly (${check}).`;
		if (!interactive) throw new SetupError(`${reason} Fix GARMIN_PERSONAL_API_KEY in ${SECRETS_FILE} and run again.`);
		warn(`${reason} Let's try again.`);
		key = "";
	}
}

async function checkGarminKey(key) {
	try {
		const response = await fetch(GARMIN_TOKEN_URL, {
			method: "POST",
			// Garmin answers 406 to `Accept: application/json` alone.
			headers: { Authorization: `ApiKey ${key}`, Accept: "application/json, text/plain, */*" },
			signal: AbortSignal.timeout(20_000),
		});
		if (response.ok) return "ok";
		if (response.status === 401 || response.status === 403) return "rejected";
		return `HTTP ${response.status}`;
	} catch {
		return "unreachable";
	}
}

// ---------------------------------------------------------------------------------- config

function readConfigName() {
	const match = /"name"\s*:\s*"([^"]+)"/.exec(readFileSync(CONFIG_FILE, "utf8"));
	if (!match) throw new SetupError('Could not find "name" in wrangler.jsonc.');
	return match[1];
}

async function configureTimezone() {
	const text = readFileSync(CONFIG_FILE, "utf8");
	const match = /"TIMEZONE"\s*:\s*"([^"]*)"/.exec(text);
	if (!match) return;
	const current = match[1];

	// "UTC" was the default before the server could read the timezone from the Garmin profile.
	let chosen = current;
	if (current === "UTC") {
		const answer = interactive
			? await ask('  Take the timezone for "today" from your Garmin profile (recommended)? [Y/n]: ')
			: "y";
		if (!/^n/i.test(answer.trim())) chosen = "auto";
	}
	if (chosen !== current) {
		writeFileSync(CONFIG_FILE, text.replace(match[0], `"TIMEZONE": "${chosen}"`));
	}
	ok(
		chosen.toLowerCase() === "auto"
			? "Timezone: taken from your Garmin profile (set TIMEZONE in wrangler.jsonc to override)"
			: `Timezone: ${chosen} (set TIMEZONE to "auto" in wrangler.jsonc to use your Garmin profile's)`,
	);
}

function parseEnvFile(text) {
	const values = {};
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const match = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
		if (!match) continue;
		let value = match[2].trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		values[match[1]] = value;
	}
	return values;
}

// ---------------------------------------------------------------------------------- verify

async function verify(url) {
	const deadline = Date.now() + 90_000;
	let lastError = "";
	while (Date.now() < deadline) {
		try {
			const metadata = await fetch(`${url}/.well-known/oauth-protected-resource/mcp`, {
				signal: AbortSignal.timeout(10_000),
			});
			if (metadata.ok) {
				const body = await metadata.json();
				if (body.resource === `${url}/mcp`) {
					ok("OAuth metadata is live");
					const mcp = await fetch(`${url}/mcp`, {
						method: "POST",
						headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
						body: "{}",
						signal: AbortSignal.timeout(10_000),
					});
					if (mcp.status === 401) ok("/mcp is protected (asks for login, as it should)");
					else warn(`/mcp answered HTTP ${mcp.status} without a token (expected 401)`);
					return;
				}
				lastError = `unexpected resource "${body.resource}"`;
			} else {
				lastError = `HTTP ${metadata.status}`;
			}
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await new Promise((resolve) => setTimeout(resolve, 5_000));
	}
	warn(`The server isn't answering yet (${lastError}). A brand-new workers.dev subdomain can take a few minutes; open ${url} later.`);
}

function printNextSteps(url, newPassword) {
	const line = "-".repeat(72);
	console.log(`\n${line}\n${bold(green("Done! Your Garmin MCP server is live."))}\n`);
	console.log(`  MCP server URL:  ${bold(`${url}/mcp`)}`);
	if (newPassword) {
		if (interactive) {
			console.log(`  Admin password:  ${bold(newPassword)}`);
			console.log("                   (also saved in admin-password.txt; keep it in a password manager)");
		} else {
			console.log("  Admin password:  saved in admin-password.txt (not printed here)");
		}
	} else {
		console.log("  Admin password:  unchanged");
	}
	console.log(`
  Connect it to Gemini (gemini.google.com):
    1. Settings -> Connected apps -> connect an MCP server ("Connect to an MCP server").
    2. Paste the MCP server URL above. Leave "Additional settings" empty.
    3. On the approval page, enter the admin password and select Approve.
    4. In a chat, type @, pick the app, then ask, e.g. "list my last 5 activities".
${line}`);
}

// --------------------------------------------------------------------------------- helpers

function wrangler(wranglerArgs, { inherit = false, extraEnv = {} } = {}) {
	const result = spawnSync(process.execPath, [WRANGLER, ...wranglerArgs], {
		cwd: ROOT,
		env: { ...env, ...extraEnv },
		encoding: "utf8",
		stdio: inherit ? (interactive ? "inherit" : ["ignore", "inherit", "inherit"]) : ["ignore", "pipe", "pipe"],
	});
	if (result.error) throw new SetupError(`Could not run Wrangler: ${result.error.message}`);
	return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runNpmInstall() {
	const npmCli = process.env.npm_execpath;
	const result = npmCli
		? spawnSync(process.execPath, [npmCli, "install"], { cwd: ROOT, stdio: "inherit" })
		: spawnSync("npm", ["install"], { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
	if (result.status !== 0 || !existsSync(WRANGLER)) throw new SetupError("`npm install` failed. Fix the error above and run again.");
}

async function ask(question) {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return await rl.question(question);
	} finally {
		rl.close();
	}
}

function askHidden(question) {
	return new Promise((resolve, reject) => {
		const input = process.stdin;
		process.stdout.write(question);
		input.setRawMode(true);
		input.setEncoding("utf8");
		input.resume();
		let value = "";
		const finish = (error) => {
			input.removeListener("data", onData);
			input.setRawMode(false);
			input.pause();
			process.stdout.write("\n");
			if (error) reject(error);
			else resolve(value);
		};
		const onData = (chunk) => {
			for (const char of chunk) {
				if (char === "\r" || char === "\n") return finish();
				if (char === "\u0003") return finish(new SetupError("Cancelled.", 130));
				if (char === "\u007f" || char === "\b") {
					if (value) {
						value = value.slice(0, -1);
						process.stdout.write("\b \b");
					}
				} else if (char >= " ") {
					value += char;
					process.stdout.write("*");
				}
			}
		};
		input.on("data", onData);
	});
}

function parseArgs(argv) {
	const parsed = { help: false, updateKey: false, skipGarminCheck: false, name: undefined };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") parsed.help = true;
		else if (arg === "--update-key") parsed.updateKey = true;
		else if (arg === "--skip-garmin-check") parsed.skipGarminCheck = true;
		else if (arg === "--name") parsed.name = argv[++i];
		else if (arg.startsWith("--name=")) parsed.name = arg.slice("--name=".length);
		else throw new SetupError(`Unknown option: ${arg} (see npm run setup -- --help)`);
	}
	if (parsed.name !== undefined && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(parsed.name)) {
		throw new SetupError("--name must use lowercase letters, digits and dashes.");
	}
	return parsed;
}

main().catch((error) => {
	const exitCode = error instanceof SetupError ? error.exitCode : 1;
	console.error(`\n${exitCode === 2 ? yellow("Action needed:") : red("Setup stopped:")} ${error.message}`);
	if (!(error instanceof SetupError)) console.error(error);
	process.exit(exitCode);
});
