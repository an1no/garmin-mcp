# Instructions for AI coding agents

This repository is a ready-made, tested remote MCP server (Cloudflare Workers) that gives the Gemini web app
read-only access to one person's Garmin Connect data. When the user asks you to "set this up", "do the same for me"
or similar, your job is to **deploy their own copy to their own Cloudflare account with their own Garmin key**, then
tell them how to connect it to Gemini. You normally don't need to change any code.

The human-facing guide is [README.md](README.md). This file tells you how to drive the setup safely.

## Rules

1. **Never ask the user to paste secrets into the chat**: not the Garmin API key, not the admin password, not
   Cloudflare tokens. The setup script reads the Garmin key from a git-ignored `.secrets.env` file that the user
   fills in themselves.
2. **Never print, log or echo secret values**, and never read `.secrets.env` or `admin-password.txt` back into the
   conversation. Refer to the password by its file name.
3. **Never commit** `.secrets.env`, `.dev.vars` or `admin-password.txt` (they are in `.gitignore`; keep it that way).
4. **Don't edit `src/`** unless the user asks for a change. The code is tested as it is.
5. **Keep `wrangler.jsonc`'s KV binding without an `id`.** Wrangler provisions the namespace on the first deploy
   and reuses the bound one later. Keep `secrets.required` as it is.
6. Ask before anything that affects the user's account beyond this deploy, e.g. registering a workers.dev
   subdomain, which is account-wide.
7. **Leave `CYCLE_TRACKING` off** unless the user explicitly asks for menstrual cycle data in their chats.

## Setup procedure

### 1. Prerequisites

- `node --version` must be 22.12 or newer (Wrangler 4 requires it). If Node is missing or older, ask the user to install the LTS version from
  https://nodejs.org and reopen the terminal.
- Run `npm install` in the repository root.

### 2. Cloudflare login

- Run `npx wrangler whoami`. If it says the user isn't logged in, run `npx wrangler login`: it opens the browser,
  and the **user** completes the login (or signs up for a free account). Wait for them to confirm.
- If the user has several accounts, ask which one to use and set `CLOUDFLARE_ACCOUNT_ID` for the following
  commands. `npm run setup` stops with the list of accounts if you don't.

### 3. Garmin key

Ask whether the user already has a Garmin Personal API key. If not, give them these steps:

1. Sign in to Garmin Connect on the web (https://connect.garmin.com).
2. Open the **Personal API Key** page (Garmin's guide:
   https://developer.garmin.com/gc-developer-program/personal/personal-api).
3. Select **Create Key**, accept the terms, choose an expiration (up to 1 year).
4. Copy the key immediately: it is shown only once.

### 4. Run the setup

```
npm run setup
```

Agent shells are usually non-interactive (no TTY). In that mode the script behaves like this:

| Exit code | Meaning | What you do |
| --- | --- | --- |
| `2` | The Garmin key is needed. It created `.secrets.env` with an empty `GARMIN_PERSONAL_API_KEY=` line. | Ask the user to paste their key after the `=` (no quotes) and save. Open the file in their editor if you can. Wait for confirmation, then run `npm run setup` again. |
| `1` | Something failed. The last lines say what. | Fix the cause (table below) and run it again. |
| `0` | Deployed and checked. | Go to step 5. |

What the script does: verifies the key with Garmin, generates an admin password, deploys with
`wrangler deploy --secrets-file` (a temporary JSON file outside the repo, deleted afterwards), lets Wrangler create
the KV namespace, deletes `.secrets.env`, saves the password to `admin-password.txt` and checks the live
endpoints. In non-interactive mode it never prints secrets.

Re-running is safe: on an existing Worker it keeps the stored key and password (use `--update-key` to replace the
key). Other options: `--name <worker>`, `--skip-garmin-check`; env vars `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, `GARMIN_PERSONAL_API_KEY`, `MCP_ADMIN_PASSWORD`.

Common failures:

| Message | Cause and fix |
| --- | --- |
| "register a workers.dev subdomain" | New Cloudflare account. Ask the user to choose a subdomain at dash.cloudflare.com → Workers & Pages (it applies to all their Workers), then run setup again. |
| "several Cloudflare accounts" | Ask which account; set `CLOUDFLARE_ACCOUNT_ID`. |
| "Garmin rejected this API key" | Mistyped, expired or deleted key. Ask the user to fix the line in `.secrets.env` (or create a new key). |
| "CLOUDFLARE_API_TOKEN is set but Cloudflare rejected it" | Unset the variable and use `npx wrangler login`, or ask for a valid token in an env var (not in chat). |
| "isn't answering yet" | A new workers.dev subdomain can take minutes to go live. Check `<url>/.well-known/oauth-protected-resource/mcp` later. |

### 5. Hand-off to the user

Tell the user:

1. Their **MCP server URL** (printed by setup; it ends in `/mcp`).
2. Their admin password is in **`admin-password.txt`** in this folder. Suggest moving it to a password manager and
   deleting the file. Do not print it.
3. How to connect Gemini:
   1. gemini.google.com → **Settings** → connected apps → connect an MCP server (dialog "Connect to an MCP server").
   2. Paste the URL; leave "Additional settings" empty (Gemini registers itself via DCR).
   3. On the server's approval page: check the redirect goes to a Google host, enter the admin password, Approve.
   4. In chats, type **`@`** and pick the app before asking. Without the @-mention Gemini doesn't use the tools.
   Claude works too: Settings → Connectors → Add custom connector → paste the URL → Connect → approve (check the
   redirect goes to claude.ai or claude.com).
4. When the Garmin key expires (Garmin emails a week before): `npm run setup -- --update-key`.

### 6. Optional deeper check

`npm run setup` already checks that the OAuth metadata is live and that `/mcp` demands a token. Only with the user's
permission, you can run a full OAuth flow (register a test client at `/register`, approve at `/authorize` with the
password read from `admin-password.txt` by your script, not shown in chat, exchange the code at `/token`), then call
the tools over MCP. Print only field names and counts, never health values. Afterwards delete the test client's KV
entries (`client:<id>`, `grant:owner:*` from that test, `token:owner:*` from that test) so only Gemini's grant
remains.

## If the user wants changes

- Code map: `src/index.ts` (OAuth provider and routes), `src/auth-handler.ts` (approval page), `src/security.ts`
  (password check, lockout), `src/mcp.ts` (Durable Object: Garmin client, timezone), `src/tools.ts` (the MCP
  tools: schemas, argument handling, errors), `src/trends.ts` (`get_trends` fetching and aggregation),
  `src/fitness.ts` (`get_vo2max`, `get_weight`, `get_fitness_profile`), `src/nutrition.ts` (`get_nutrition`), `src/snapshots.ts` (`get_health_snapshots`),
  `src/charts.ts` + `src/chart-app.ts` (MCP Apps charts for
  `get_trends`/`get_day_details`), `src/cycle.ts` (`get_menstrual_cycle`, opt-in), `src/intraday.ts` (`get_day_details`), `src/workouts.ts` (planned workouts for `get_activity_details`),
  `src/parts.ts` (parallel requests with per-part errors, chunking), `src/profile.ts`
  (timezone: `TIMEZONE` or the Garmin profile's),
  `src/garmin.ts` (Garmin API client, token cache),
  `src/format.ts` (response shaping), `scripts/setup.mjs` (setup).
- Garmin API reference with exact parameter names: https://developer.garmin.com/gc-developer-program/personal/swagger-docs/
- Garmin's token endpoint needs `Accept: application/json, text/plain, */*`; `application/json` alone gets 406.
- After editing `wrangler.jsonc`, run `npm run cf-typegen`.
- Before deploying: `npm run check` (lockfile check, type check, unit tests in `test/` and end-to-end tests in
  `test/e2e/`, then a dry-run bundle). It must pass; don't deploy or commit with failing tests. Add or update tests
  for every behaviour you change (`test/helpers.ts` has a fake KV and a fake Garmin client; e2e tests mock Garmin
  with MSW via `test/e2e/network.ts`). Deploy with `npm run deploy`.
- The tests never touch the deployed server or Garmin. Don't point them at either.
- After adding or upgrading dependencies, if the lockfile check fails, regenerate the lockfile from scratch
  (`rm -rf node_modules package-lock.json && npm install`) rather than editing it.
- Test fixtures are synthetic. Never paste real Garmin responses (they contain health data) into tests.
- Logging: only `logToolCall` (src/tools.ts) and `logAuthorize` (src/auth-handler.ts) write logs. Never log tool
  arguments, dates, IDs, returned data, passwords, tokens or IP addresses; the tests check this.
- Commit with git as usual; never add the secret files.
