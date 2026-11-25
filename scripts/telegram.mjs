#!/usr/bin/env node
/**
 * Turns on the morning summary in Telegram:   npm run telegram
 *
 * 1. Reads your Telegram bot token (hidden input, the TELEGRAM_BOT_TOKEN environment variable, or
 *    TELEGRAM_BOT_TOKEN= in the git-ignored .secrets.env) and checks it with Telegram.
 * 2. Finds your chat with the bot (press Start in the bot first).
 * 3. Stores TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID as Worker secrets and sends a test message.
 *
 * Create the bot first: in Telegram, open @BotFather, send /newbot, pick a name and a username,
 * and copy the token it gives you.
 *
 * Options:
 *   --off    Turn the summary off (deletes both secrets)
 *   --name   Worker name (default: "name" in wrangler.jsonc)
 *   --help
 *
 * Exit codes: 0 done, 1 error, 2 the bot token is needed (in .secrets.env), 3 press Start in the bot
 * first. Secrets are never printed.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_FILE = join(ROOT, "wrangler.jsonc");
const SECRETS_FILE = join(ROOT, ".secrets.env");
const WRANGLER = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const TELEGRAM_API = "https://api.telegram.org";
const TOKEN_PATTERN = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;

const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const color = (code) => (text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = color("1");
const green = color("32");
const red = color("31");
const ok = (text) => console.log(`  ${green("✓")} ${text}`);
const info = (text) => console.log(`    ${text}`);

class TelegramSetupError extends Error {
	constructor(message, code = 1) {
		super(message);
		this.code = code;
	}
}

const USAGE = `Usage: npm run telegram [-- options]

Turns on the morning summary in Telegram for your deployed Worker.

Before you start: in Telegram, open @BotFather, send /newbot, choose a name and a username,
and copy the token. Then open your new bot and press Start.

Options:
  --off                  Turn the summary off (deletes the Telegram secrets)
  --name <worker-name>   Worker name (default: "name" in wrangler.jsonc)
  --help                 Show this help`;

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(USAGE);
		return;
	}
	if (!existsSync(WRANGLER)) throw new TelegramSetupError("Run `npm install` first.");
	const name = args.name ?? readConfigValue("name") ?? "garmin-mcp";

	if (args.off) {
		putSecrets(name, { TELEGRAM_BOT_TOKEN: null, TELEGRAM_CHAT_ID: null });
		ok(`Morning summary turned off (deleted the Telegram secrets of ${name})`);
		return;
	}

	console.log(bold("\nMorning summary in Telegram"));
	const token = await obtainToken();
	const bot = await telegram(token, "getMe");
	if (!bot.ok) {
		throw new TelegramSetupError(
			"Telegram rejected this bot token. Copy it again from @BotFather (/mybots -> your bot -> API Token) and run again.",
		);
	}
	const username = bot.result?.username;
	ok(`Telegram accepted the token of @${username}`);

	const chatId = await findChat(token, username);
	ok("Found your chat with the bot");

	putSecrets(name, { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chatId });
	ok(`Stored TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID as secrets of ${name}`);

	const hour = Number(readConfigValue("DAILY_SUMMARY_HOUR") ?? "8");
	const sent = await telegram(token, "sendMessage", {
		chat_id: chatId,
		text: `✅ Garmin morning summary is on. It arrives once a day from ${hour}:00 your time, as soon as last night's sleep has synced from your watch.`,
	});
	if (sent.ok) ok("Sent a test message: check Telegram");
	else info("Couldn't send the test message, but the secrets are stored.");

	forgetTokenFile();
	console.log(`\n${bold("Done.")} The first summary arrives tomorrow from ${hour}:00 (your Garmin profile's time zone).`);
	info("Turn it off any time with: npm run telegram -- --off");
}

// ------------------------------------------------------------------------------ token and chat

async function obtainToken() {
	const fromEnv = process.env.TELEGRAM_BOT_TOKEN?.trim();
	if (fromEnv) return checkFormat(fromEnv);
	const fromFile = existsSync(SECRETS_FILE) ? parseEnvFile(readFileSync(SECRETS_FILE, "utf8")).TELEGRAM_BOT_TOKEN?.trim() : "";
	if (fromFile) return checkFormat(fromFile);

	if (!interactive) {
		const text = existsSync(SECRETS_FILE) ? readFileSync(SECRETS_FILE, "utf8") : "";
		if (!/^\s*TELEGRAM_BOT_TOKEN\s*=/m.test(text)) {
			const block = [
				"# Paste your Telegram bot token after the = sign (no quotes), save this file, then run",
				"# `npm run telegram` again. This file is git-ignored; the line is removed once the token is stored.",
				"# Get a token: Telegram -> @BotFather -> /newbot",
				"TELEGRAM_BOT_TOKEN=",
				"",
			].join("\n");
			writeFileSync(SECRETS_FILE, text && !text.endsWith("\n") ? `${text}\n${block}` : `${text}${block}`, { mode: 0o600 });
		}
		throw new TelegramSetupError(
			`The bot token is needed. Paste it into ${SECRETS_FILE} after TELEGRAM_BOT_TOKEN=, save, and run \`npm run telegram\` again.`,
			2,
		);
	}
	info("Create a bot first: in Telegram, open @BotFather, send /newbot and copy the token.");
	const typed = (await askHidden("  Paste the bot token (input is hidden): ")).trim();
	return checkFormat(typed);
}

function checkFormat(token) {
	if (!TOKEN_PATTERN.test(token)) {
		throw new TelegramSetupError("That doesn't look like a bot token (it should look like 123456789:AA...). Copy it again from @BotFather.");
	}
	return token;
}

/** The private chat that pressed Start; refuses when several people have written to the bot. */
async function findChat(token, username) {
	const updates = await telegram(token, "getUpdates", { allowed_updates: ["message"] });
	if (!updates.ok) throw new TelegramSetupError("Couldn't read the bot's messages from Telegram. Try again in a minute.");
	const chats = new Map();
	for (const update of updates.result ?? []) {
		const chat = update.message?.chat;
		if (chat?.type === "private" && chat.id !== undefined) chats.set(String(chat.id), chat);
	}
	if (chats.size === 0) {
		throw new TelegramSetupError(
			`Open https://t.me/${username} in Telegram, press Start (or send it any message), then run \`npm run telegram\` again.`,
			3,
		);
	}
	if (chats.size > 1) {
		throw new TelegramSetupError(
			"More than one person has written to this bot, so I can't tell which chat is yours. Create a new bot with @BotFather, " +
				"press Start in it yourself, and run again with the new token.",
		);
	}
	return [...chats.keys()][0];
}

async function telegram(token, method, body) {
	try {
		const response = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body ?? {}),
			signal: AbortSignal.timeout(15_000),
		});
		return await response.json();
	} catch {
		throw new TelegramSetupError("Couldn't reach Telegram. Check your internet connection and try again.");
	}
}

// ------------------------------------------------------------------------------ secrets

/** Uploads (or, for null values, deletes) Worker secrets via a temporary file outside the repo. */
function putSecrets(name, secrets) {
	const dir = mkdtempSync(join(tmpdir(), "garmin-mcp-telegram-"));
	const file = join(dir, "secrets.json");
	try {
		writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
		const result = spawnSync(process.execPath, [WRANGLER, "secret", "bulk", file, "--name", name], {
			cwd: ROOT,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (result.status !== 0) {
			const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
			const hint = /not logged in|login|authenticat/i.test(output)
				? " You're not logged in to Cloudflare: run `npx wrangler login` first."
				: /not found|does not exist|10007/i.test(output)
					? ` The Worker "${name}" doesn't exist yet: run \`npm run setup\` first.`
					: "";
			throw new TelegramSetupError(`Wrangler couldn't update the secrets.${hint}`);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Removes the token line (and its comments) from .secrets.env; deletes the file if nothing else is left. */
function forgetTokenFile() {
	if (!existsSync(SECRETS_FILE)) return;
	const kept = readFileSync(SECRETS_FILE, "utf8")
		.split(/\r?\n/)
		.filter((line) => !/^\s*TELEGRAM_BOT_TOKEN\s*=/.test(line) && !/Telegram bot token|npm run telegram|@BotFather/.test(line));
	if (kept.some((line) => /^\s*[A-Z0-9_]+\s*=\s*\S/.test(line))) writeFileSync(SECRETS_FILE, kept.join("\n"), { mode: 0o600 });
	else rmSync(SECRETS_FILE, { force: true });
	ok("Removed the token from .secrets.env (it now lives only on Cloudflare)");
}

// ------------------------------------------------------------------------------ helpers

function readConfigValue(key) {
	const text = readFileSync(CONFIG_FILE, "utf8");
	const match = new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(text);
	return match?.[1];
}

function parseEnvFile(text) {
	const values = {};
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const match = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
		if (!match) continue;
		let value = match[2].trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
		values[match[1]] = value;
	}
	return values;
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
				if (char === "\u0003") return finish(new TelegramSetupError("Cancelled.", 130));
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
	const parsed = { help: false, off: false, name: undefined };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") parsed.help = true;
		else if (arg === "--off") parsed.off = true;
		else if (arg === "--name") parsed.name = argv[++i];
		else throw new TelegramSetupError(`Unknown option: ${arg}\n\n${USAGE}`);
	}
	return parsed;
}

main().catch((error) => {
	if (error instanceof TelegramSetupError) {
		console.error(`\n${red("✗")} ${error.message}`);
		process.exit(error.code);
	}
	console.error(`\n${red("✗")} Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
