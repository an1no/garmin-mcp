---
name: garmin-mcp-setup
description: Sets up the user's own Garmin Connect MCP server (github.com/an1no/garmin-mcp) on their free Cloudflare account and connects it to Gemini or Claude, so the assistant can read their Garmin data (activities, sleep, HRV, Body Battery, VO2 max, weight, Fitness Age, nutrition, Health Snapshots, trends with charts). Use when the user wants their Garmin or Garmin Connect data in Gemini, Claude or another MCP client, or asks to update this server or renew its Garmin key.
license: MIT
---

# Garmin Connect MCP server: setup

This skill deploys a **personal** copy of [an1no/garmin-mcp](https://github.com/an1no/garmin-mcp): a remote MCP
server on Cloudflare Workers that gives an AI assistant read-only access to one person's Garmin Connect data through
Garmin's official Personal API. Each person runs their own copy, with their own Cloudflare account and Garmin key.

The detailed, maintained procedure lives in the repository's `AGENTS.md`. This skill gets you there and keeps the
rules in front of you.

## Rules (always)

1. **Never ask the user to paste secrets into the chat**: not the Garmin API key, not the admin password, not
   Cloudflare tokens. The Garmin key goes into a git-ignored `.secrets.env` file that the user fills in themselves.
2. **Never print, log or echo secret values**, and never read `.secrets.env` or `admin-password.txt` back into the
   conversation. Refer to the password by its file name.
3. **Never commit** `.secrets.env`, `.dev.vars` or `admin-password.txt`.
4. **Leave `CYCLE_TRACKING` off** unless the user explicitly asks for menstrual cycle data.
5. **Ask before anything account-wide**, such as registering a workers.dev subdomain or creating API tokens.
6. The user completes every login and approval themselves (Cloudflare login in the browser, Garmin key creation,
   the server's approval page in Gemini or Claude).

## What the user needs

- Node.js 22.12 or newer and Git.
- A free Cloudflare account.
- A Garmin Connect **Personal API key**: on the Garmin Connect website, open the Personal API Key page
  ([Garmin's guide](https://developer.garmin.com/gc-developer-program/personal/personal-api)), select
  **Create Key**, accept the terms, pick an expiry and copy the key right away (it is shown only once).
- Gemini (with "Connect to an MCP server") or Claude (custom connectors).

## Steps

1. **Get the code.** Unless you are already in a clone of `an1no/garmin-mcp`, ask where to put it, then:

   ```
   git clone https://github.com/an1no/garmin-mcp.git
   cd garmin-mcp
   ```

2. **Follow `AGENTS.md` in that folder, step by step.** In short, it covers:
   - checking Node.js and running `npm install`;
   - the Cloudflare login (`npx wrangler login`, which the user completes in the browser);
   - `npm run setup`. Without a terminal to type into, it exits with code `2` and creates `.secrets.env`: ask the
     user to paste their Garmin key after `GARMIN_PERSONAL_API_KEY=` and save, then run it again. Code `0` means
     deployed and checked; code `1` prints what to fix (`AGENTS.md` has a table of the usual causes);
   - the hand-off below.

3. **Hand off.** Tell the user:
   - their **MCP server URL** (printed by setup, ending in `/mcp`);
   - that their admin password is in `admin-password.txt` (do not show it), to be moved to a password manager and
     the file deleted;
   - how to connect:
     - **Gemini:** Settings → connected apps → connect an MCP server, paste the URL, leave the additional settings
       empty. On the approval page, check that access goes to a Google address, enter the password, Approve. In
       chats, type `@` and pick the app.
     - **Claude:** Settings → Connectors → Add custom connector, paste the URL, Connect. On the approval page, check
       that access goes to claude.ai (or claude.com), enter the password, Approve. Enable the connector in the chat.
   - that Garmin keys expire: renew with `npm run setup -- --update-key`.

## Other requests

- **Update an existing server:** in its folder, `git pull`, `npm install`, `npm run check` (lockfile check, type
  check, all tests, dry-run bundle; it must pass), then `npm run setup` (keeps the stored key and password).
- **Renew the Garmin key:** `npm run setup -- --update-key`, with the new key in `.secrets.env` when there is no
  terminal to type into.
- **Something looks wrong:** the README's Troubleshooting and Logs sections; Cloudflare's Observability shows one
  `tool_call` line per tool call (never any health data).
- **Menstrual cycle data:** off by default. Only if the user asks: set `CYCLE_TRACKING` to `"on"` in
  `wrangler.jsonc`, then `npm run deploy`.
- **Morning summary in Telegram:** only if the user asks. They create a bot with @BotFather and press Start in it;
  then `npm run telegram` (exit code `2`: the bot token goes into `.secrets.env`, never into the chat; `3`: press Start
  first). Off again with `npm run telegram -- --off`.
- **Without a terminal:** the README's "Deploy to Cloudflare" button deploys a copy from the browser.
