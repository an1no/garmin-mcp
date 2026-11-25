# Garmin Connect in Gemini: your own MCP server on Cloudflare

A small, private server that lets the **Gemini web app** (`gemini.google.com`), or any other MCP client, read **your
own Garmin Connect data**: activities, sleep, HRV, Body Battery, VO2 max, weight and daily health stats. It runs on Cloudflare's free
plan, nothing sits in between, and only you can connect apps to it.

You ask Gemini things like *"@Garmin Connect how did I sleep this week?"*, and Gemini calls your server, which reads
the data from Garmin's official Personal API.

**Why this approach**

- **Official API, no Garmin password.** It uses a Garmin Personal API key that you create and can revoke at any
  time, instead of logging in with your Garmin password or imitating the Garmin Connect website.
- **Remote, so it works everywhere.** It runs on Cloudflare, so it works in the browser and on your phone, with
  nothing running on your computer.
- **One command, free.** `npm run setup` deploys it on Cloudflare's free plan and checks that it works.
- **Locked to you.** Apps can connect only after you approve them with your own password.

> **Using an AI coding agent** (Claude Code, Codex, Cursor...)? Clone this repo, open it in the agent and say
> **"Set this up for me."** The agent's instructions are in [AGENTS.md](AGENTS.md).

---

## Quick start (about 5 minutes)

### What you need

| | What | How to get it |
| --- | --- | --- |
| 1 | **Node.js 20 or newer** | Check with `node --version`. Install the LTS version from [nodejs.org](https://nodejs.org) if needed. |
| 2 | **Git** | Check with `git --version`. Install from [git-scm.com](https://git-scm.com) if needed. |
| 3 | **A Cloudflare account** (free) | Sign up at [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up). Setup logs you in through the browser. |
| 4 | **A Garmin Personal API key** | See [Getting a Garmin Personal API key](#getting-a-garmin-personal-api-key) below. |
| 5 | **Gemini with custom apps** | A Google account where Gemini offers "Connect to an MCP server" in its settings. |

### Install and deploy

```powershell
git clone https://github.com/an1no/garmin-mcp.git
```

```powershell
cd garmin-mcp
```

```powershell
npm install
```

```powershell
npm run setup
```

These commands work the same in PowerShell, Windows Terminal, macOS Terminal and Linux shells.

`npm run setup` does everything in six steps and tells you what it's doing:

1. **Prerequisites:** checks Node.js and installs dependencies if needed.
2. **Cloudflare login:** if you're not logged in, it opens your browser so you can log in (or sign up). If you
   have several Cloudflare accounts, it asks which one to use.
3. **Settings:** makes sure "today" means today where you live (the server reads your timezone from your Garmin
   profile).
4. **Secrets:** asks you to paste your Garmin Personal API key (the input is hidden), checks it with Garmin,
   and generates a strong admin password.
5. **Deploy:** uploads the server to Cloudflare with both secrets. Cloudflare's storage (KV) is created
   automatically.
6. **Check:** makes sure the live server answers, then prints:
   - your **MCP server URL**, e.g. `https://garmin-mcp.<your-subdomain>.workers.dev/mcp`
   - your **admin password** (also saved in `admin-password.txt`, which git ignores)

If Cloudflare asks you to **register a workers.dev subdomain** (first time only), pick any free name. It becomes
part of all your Worker URLs. Then run `npm run setup` again.

Running `npm run setup` again later is safe: it redeploys and keeps your existing password and Garmin key.

### Connect it to Gemini

1. Open [gemini.google.com](https://gemini.google.com), go to **Settings**, find the connected apps section and
   choose to connect an MCP server. The dialog is titled **"Connect to an MCP server"**; Google moves these menus
   around from time to time.
2. Paste your **MCP server URL** (the one ending in `/mcp`).
3. Leave **"Additional settings"** empty. Gemini registers itself automatically; you don't need a client ID or
   secret.
4. A page from your server opens: **"Connect your Garmin data"**. Check that access will be sent to a Google
   address, enter your **admin password** and select **Approve**.
5. In a chat, type **`@`**, pick the app, then ask your question.

**Always @-mention the app.** Without it, Gemini answers from general knowledge and says it can't see your Garmin
data. Gemini's **Developer Mode** panel shows the app's tools (*Tool schemas*) and every call it makes
(*Event log*), which helps if something looks wrong.

Gemini keeps you connected as long as you use the app at least once every 30 days.

### Other MCP clients

The server speaks standard MCP over Streamable HTTP with OAuth (Dynamic Client Registration and Client ID Metadata
Documents), so other clients that support remote MCP servers with OAuth should work the same way: add the server
URL, approve on the password page, ask. Only the Gemini web app has been tested end to end; if you try another
client (for example Claude's custom connectors), please open an issue with how it went.

On the approval page, always check that access will be sent to the app you're connecting (the page shows the
destination host) before you enter your password.

### Getting a Garmin Personal API key

1. Sign in to [Garmin Connect](https://connect.garmin.com) **on the web**.
2. Open the **Personal API Key** page (Garmin's instructions:
   [Garmin Connect Personal API](https://developer.garmin.com/gc-developer-program/personal/personal-api)).
3. Select **Create Key**, accept the terms and choose an expiration: 30 days, 90 days, 180 days or 1 year.
4. **Copy the key right away.** Garmin shows it only once. If you lose it, delete it and create a new one.

Garmin emails you about a week before the key expires. See [Renewing the Garmin key](#renewing-the-garmin-key).

---

## What you can ask

| Tool | What it returns | Range per call |
| --- | --- | --- |
| `get_trends` | Weekly or monthly statistics computed on the server. **Sleep:** average hours, stage minutes, score, best/worst night. **Daily:** steps, distance, resting heart rate, stress, Body Battery, intensity minutes. **HRV:** average, range, status counts. **Activities:** count, distance, time, elevation, calories, per type, longest | Up to 1 year in one call |
| `get_activities` | Activity list: `activityId`, name, type, event type, start time, location, distance (m), duration (s), elevation gain (m), average/max heart rate, average speed (m/s), calories, power | Up to 100, paged; filter by dates, type, subtype, text, event type (e.g. races), distance, duration, elevation, power, favorites or start area; sort by date, distance, duration or name |
| `get_activity_details` | One workout: speed, heart rate, power, cadence, elevation, training effect and load, temperature, splits. `raw: true` returns everything | One activity |
| `get_daily_summary` | Steps, distance, calories, resting/min/max heart rate, stress, Body Battery, intensity minutes, floors, SpO2, respiration, hydration | One day, or up to 1 year |
| `get_sleep_data` | Total sleep, deep/light/REM/awake time, sleep score and sub-scores, overnight heart rate, stress, SpO2, respiration, sleep need | One night, or up to 31 |
| `get_hrv_data` | Last-night HRV average and 5-minute high, 7-day average, HRV status, baseline range | Last 7 days by default |
| `get_body_battery` | Charged/drained, start/end/highest/lowest level, the events that moved it, optional intraday timeline | Up to 31 days |
| `get_day_details` | One day in local time: heart rate per interval (avg/min/max, default 15 min), resting, the day's lowest/highest reading with times, abnormal readings; overnight HRV readings with sleep start/end; SpO2 hourly averages, sleep average, latest | One day |
| `get_vo2max` | VO2 max (ml/kg/min) for running/walking, cycling and rowing: first and latest value, change, min/max, the dates it changed | Up to 1 year (default 365 days) |
| `get_weight` | Weight, BMI, body fat and water %, muscle and bone mass, visceral fat, metabolic age: first/latest/lowest/highest, change, average, weight goal, daily values or monthly averages | Up to 1 year (default 90 days) |

Example prompts:

- `@Garmin Connect list my last 5 activities`
- `@Garmin Connect how did I sleep last night, compared with the rest of the week?`
- `@Garmin Connect show my HRV status and Body Battery for the last 7 days`
- `@Garmin Connect give me the details of my most recent ride`
- `@Garmin Connect how did my sleep change month by month this year?`
- `@Garmin Connect how far did I run in 2025, and what was my longest run?`
- `@Garmin Connect list all my races`
- `@Garmin Connect how has my VO2 max changed this year?`
- `@Garmin Connect what was my heart rate like yesterday afternoon, and how did my HRV look overnight?`
- `@Garmin Connect how much weight have I lost since January, and how far am I from my goal?`

`get_trends` exists so that questions about long periods stay fast and accurate: instead of sending the model a year
of days (hundreds of records), the server sends one row per week or month plus an overall summary.

All tools are read-only: nothing is ever changed in your Garmin account. Dates are `YYYY-MM-DD`; when a question
has no date, "today" is computed in the timezone from your Garmin profile (or the zone you set as `TIMEZONE` in
`wrangler.jsonc`).

---

## How it works

```
Gemini ──OAuth (DCR + PKCE)──► /register, /authorize (your password), /token
Gemini ──Bearer token────────► /mcp ──► GarminMCP (Durable Object) ──► personal.connectapi.garmin.com
                                                     │
                                                     └── OAUTH_KV: OAuth grants (hashed) + Garmin token (AES-GCM)
```

There are two "locks":

1. **Gemini → your server (OAuth 2.1).** Gemini registers itself (Dynamic Client Registration), opens your
   `/authorize` page and gets tokens only after you enter your admin password. Access tokens last 1 hour; refresh
   tokens keep the connection alive while it's used at least every 30 days.
2. **Your server → Garmin.** The server trades your Personal API key for a Garmin access token (valid 24 hours),
   caches it encrypted for about 23 hours, and uses it to read your data.

**Stack:** Cloudflare Workers + Durable Objects (`agents` / `McpAgent`), Streamable HTTP at `/mcp`,
`@cloudflare/workers-oauth-provider`, `@modelcontextprotocol/sdk`, TypeScript.

### Where your secrets live

| Secret | Where | Notes |
| --- | --- | --- |
| Garmin Personal API key | Cloudflare, as an encrypted Worker secret | Not in the code, not on GitHub, not on your computer after setup |
| Admin password | Cloudflare (encrypted secret) + `admin-password.txt` on your computer | Move it to a password manager, then delete the file |
| Garmin access token | Cloudflare KV, AES-GCM encrypted with a key derived from your API key | Renewed automatically every ~23 hours |
| Gemini's OAuth tokens | Cloudflare KV, stored only as hashes | |

Cloudflare secrets are write-only: nobody, including you, can read them back. If you lose the admin password, set a
new one (see [Maintenance](#maintenance)).

### Security

- **Only you can connect apps.** Any app can register, but it gets a token only after the correct admin password.
  The comparison is constant-time.
- **Brute-force protection.** 5 wrong passwords from one IP lock that IP out for 15 minutes; 20 wrong passwords in
  an hour pause all new approvals for that hour. Connected apps keep working.
- **Hardened approval page.** Each page works once, for 10 minutes, only in the browser that opened it; it can't be
  framed and loads no scripts. It shows where tokens will be sent.
- **One server per person.** Everyone deploys their own copy with their own key; nobody else's server sees your
  data.

Found a security problem? Please report it privately, as described in [SECURITY.md](SECURITY.md).

---

## Maintenance

| Task | Command |
| --- | --- |
| Deploy after changing code | `npm run check`, then `npm run deploy` (or `npm run setup`) |
| Renew the Garmin key | `npm run setup -- --update-key` |
| Change the admin password | `npx wrangler secret put MCP_ADMIN_PASSWORD` |
| Change the timezone | By default (`"TIMEZONE": "auto"`) it follows your Garmin profile, re-read once a day. To force one, set `TIMEZONE` in `wrangler.jsonc` (e.g. `Europe/Berlin`), then `npm run deploy` |
| Watch live logs | `npx wrangler tail` |
| Save your changes to GitHub | `git add -A`, `git commit -m "Describe what changed"`, `git push` |

### Renewing the Garmin key

Create a new key on Garmin Connect (see [above](#getting-a-garmin-personal-api-key)), then run:

```powershell
npm run setup -- --update-key
```

It asks for the new key, checks it and stores it. The cached Garmin token is tied to the old key, so the new key is
used immediately. Gemini stays connected.

### Revoking access

Disconnect the app in Gemini, then delete the stored grants and tokens (the server's single user is `owner`). List
them first:

```powershell
npx wrangler kv key list --binding OAUTH_KV --remote --prefix "grant:owner:"
```

Then delete all grants and tokens in one go:

```powershell
foreach ($prefix in "grant:owner:", "token:owner:") { (npx wrangler kv key list --binding OAUTH_KV --remote --prefix $prefix | ConvertFrom-Json) | ForEach-Object { npx wrangler kv key delete --binding OAUTH_KV --remote $_.name } }
```

Changing the admin password stops *new* approvals with the old password but doesn't disconnect apps that are
already approved; delete their grants as shown above.

---

## Setup options

```
npm run setup -- --help
```

| Option | Effect |
| --- | --- |
| `--name <worker-name>` | Deploy under another Worker name (default: `name` in `wrangler.jsonc`, i.e. `garmin-mcp`) |
| `--update-key` | Ask for a new Garmin key even if one is already stored |
| `--skip-garmin-check` | Don't check the key with Garmin before deploying (e.g. if Garmin is down) |

| Environment variable | Effect |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Use an API token instead of the browser login |
| `CLOUDFLARE_ACCOUNT_ID` | Pick the account when you have several |
| `GARMIN_PERSONAL_API_KEY` | Provide the key without the prompt |
| `MCP_ADMIN_PASSWORD` | Use your own admin password (at least 12 characters) instead of a generated one |

**Non-interactive mode** (when there's no terminal to type into, e.g. an AI agent runs the script): if the Garmin
key isn't provided, setup creates a git-ignored `.secrets.env` with an empty `GARMIN_PERSONAL_API_KEY=` line and
exits with code **2**. Paste the key after the `=`, save, and run `npm run setup` again. Setup deletes the file after
deploying and never prints secrets in this mode.

Exit codes: `0` done, `1` error (the message says what to fix), `2` action needed (paste the Garmin key).

### Manual setup (without the script)

1. `npx wrangler login`
2. Create a git-ignored `.secrets.env` in this folder, with no quotes:
   ```
   GARMIN_PERSONAL_API_KEY=your-key
   MCP_ADMIN_PASSWORD=a-long-random-password
   ```
3. `npx wrangler deploy --secrets-file .secrets.env`. The first deploy must include both secrets because
   `wrangler.jsonc` lists them under `secrets.required`; Wrangler creates the KV namespace by itself.
4. Delete `.secrets.env`.

---

## Local development

```powershell
Copy-Item .dev.vars.example .dev.vars
```

Put real values in `.dev.vars` (git-ignored), then:

```powershell
npm run dev
```

The server runs at `http://localhost:8787`, with MCP at `http://localhost:8787/mcp`. Try it with the MCP Inspector
(Streamable HTTP transport), which handles the OAuth flow:

```powershell
npx @modelcontextprotocol/inspector
```

| Command | What it does |
| --- | --- |
| `npm run setup` | Log in, store secrets, deploy and check (safe to re-run) |
| `npm run deploy` | Deploy the current code |
| `npm run dev` | Run locally |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run check` | Type-check, then test-bundle with `wrangler deploy --dry-run` |
| `npm run cf-typegen` | Regenerate `worker-configuration.d.ts` after editing `wrangler.jsonc` |

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Setup: "register a workers.dev subdomain" | First deploy on a new Cloudflare account. Open [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages**, choose a subdomain, run `npm run setup` again. |
| Setup: "several Cloudflare accounts" | Choose one when asked, or set `CLOUDFLARE_ACCOUNT_ID`. |
| Setup: "Garmin rejected this API key" | The key is mistyped, expired or deleted. Copy it again or create a new one. |
| Setup: "isn't answering yet" | A brand-new workers.dev subdomain can take a few minutes. Open the URL again later. |
| Gemini says it has no access to Garmin | @-mention the app in the chat (type `@` and pick it). |
| Tool error: "Garmin rejected the Personal API key" | The key expired. Run `npm run setup -- --update-key`. |
| Approval page: "Server not configured" | The admin password secret is missing. Run `npm run setup` or `npx wrangler secret put MCP_ADMIN_PASSWORD`. |
| Approval page: "Too many attempts" | Wait 15 minutes (up to 1 hour), then start the connection again from Gemini. |
| Approval page: "expired or was already used" | Start the connection again from Gemini; each page works once, for 10 minutes. |
| Gemini asks to reconnect | The connection wasn't used for 30 days, or grants were deleted. Reconnect and approve again. |
| "Date range is N days" | Sleep and Body Battery allow 31 days per call, daily summaries 366. For longer periods ask for trends (`get_trends` covers a year per call) or shorter ranges. |
| `get_trends` shows `errors` for one metric | Garmin refused or timed out for that data (e.g. rate limiting); the other metrics are still correct. Ask again a bit later. |
| "Today" is off by a day | Check the time zone in your Garmin Connect profile settings (the server re-reads it daily), or set `TIMEZONE` in `wrangler.jsonc` to your zone and deploy. |
| Gemini insists on a client ID and secret | Register a client yourself (below), then paste its `client_id` and `client_secret`. |

Registering a client by hand (replace both placeholders; Gemini shows its redirect URL in the advanced settings):

```powershell
Invoke-RestMethod -Method Post -Uri "https://garmin-mcp.<your-subdomain>.workers.dev/register" -ContentType "application/json" -Body '{"client_name":"Gemini","redirect_uris":["<GEMINI_REDIRECT_URL>"],"grant_types":["authorization_code","refresh_token"],"response_types":["code"]}'
```

---

## Project layout

```
scripts/setup.mjs        npm run setup: login, secrets, deploy, checks
src/
  index.ts               OAuthProvider setup (DCR, CIMD, scopes, token lifetimes), Worker entry point
  auth-handler.ts        Landing page and the password-protected /authorize consent flow
  security.ts            Constant-time password check and KV-backed brute-force lockout
  html.ts                HTML templates and security headers for the auth pages
  mcp.ts                 GarminMCP (McpAgent Durable Object) and the ten MCP tools
  trends.ts              get_trends: chunked fetching and weekly/monthly aggregation
  fitness.ts             get_vo2max and get_weight: fetching and shaping
  intraday.ts            get_day_details: heart rate, overnight HRV and SpO2 per interval, in local time
  profile.ts             Timezone for "today": TIMEZONE, or the Garmin profile's (cached in KV)
  garmin.ts              Garmin Personal API client with encrypted token caching
  format.ts              Date helpers and response shaping
wrangler.jsonc           Worker config: Durable Object, KV (auto-provisioned), vars, required secrets
worker-configuration.d.ts  Generated by `wrangler types` (Env + runtime types)
AGENTS.md                Instructions for AI coding agents
SECURITY.md              How to report vulnerabilities
LICENSE                  MIT
```

## Notes

- `wrangler.jsonc` deliberately has no KV namespace `id`. On a first deploy Wrangler creates the namespace
  (named `<worker-name>-oauth-kv`); later deploys keep the one already bound to the Worker. After an interactive
  deploy Wrangler may write the new id into `wrangler.jsonc`; keeping or discarding that change both work.
- Garmin's token endpoint answers `406 Not Acceptable` to `Accept: application/json` alone, so the client sends
  `Accept: application/json, text/plain, */*`.
- `agents` 0.34 marks `McpAgent` as feature-frozen in favour of its newer `createMcpHandler` API for MCP SDK v2.
  `McpAgent` is still supported and is used here with `@modelcontextprotocol/sdk` 1.x; `agents/mcp` also imports
  `@modelcontextprotocol/server` and `@modelcontextprotocol/client` (v2), so they're installed at the exact versions
  its peer dependencies require.
- The OAuth resource identifier is derived from the request origin, so the same build works on `workers.dev`, a
  custom domain and `wrangler dev` without config changes.
- Garmin describes the Connect Personal API as being for personal use, so customers can access their own data; it
  isn't meant for commercial apps that serve many users. That's why this project has no shared server: each person
  deploys their own copy with their own key. Garmin's terms are shown when you create the key; read them there.
- Garmin's API can change. If a tool starts failing after a Garmin update, please open an issue.

## Contributing

Issues and pull requests are welcome. Before opening a pull request, run `npm run check` (type-check plus a dry-run
bundle) and describe how you tested the change. Never include real health data, keys or passwords in issues, logs or
screenshots.

## License and disclaimer

[MIT](LICENSE). This is an independent personal project. It is not affiliated with, endorsed by or supported by
Garmin, Google or Cloudflare. Garmin and Garmin Connect are trademarks of Garmin Ltd. or its subsidiaries; Gemini is a
trademark of Google LLC; Cloudflare is a trademark of Cloudflare, Inc. The software is provided "as is", without
warranty of any kind; you are responsible for your own deployment and your own data.
