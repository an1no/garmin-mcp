# Garmin Connect MCP Server (Cloudflare Workers)

A private, remote [Model Context Protocol](https://modelcontextprotocol.io) server that gives the Gemini web app
(`gemini.google.com`), or any other MCP client, **read-only** access to your own Garmin Connect data through the
[Garmin Connect Personal API](https://developer.garmin.com/gc-developer-program/personal/personal-api).

- **Runtime:** Cloudflare Workers + Durable Objects (`agents` / `McpAgent`), free plan friendly
- **Transport:** Streamable HTTP at `/mcp`
- **Auth:** OAuth 2.1 with Dynamic Client Registration (DCR), PKCE (S256) and refresh tokens, via
  `@cloudflare/workers-oauth-provider`. The consent page is protected by your own admin password.
- **Garmin auth:** your Personal API key is exchanged for an access token, which is cached (encrypted) in KV and
  reused until shortly before it expires.

```
Gemini ──OAuth (DCR + PKCE)──► /register, /authorize (your password), /token
Gemini ──Bearer token────────► /mcp ──► GarminMCP (Durable Object) ──► personal.connectapi.garmin.com
                                                     │
                                                     └── OAUTH_KV: OAuth grants (hashed) + Garmin token (AES-GCM)
```

## Tools

| Tool | Garmin endpoint | What it returns |
| --- | --- | --- |
| `get_activities` | `GET /activitylist-service/activities/search/activities` | Paged activity summaries: `activityId`, `activityName`, `activityType`, `startTimeLocal`, `distance` (m), `duration` (s), `elevationGain` (m), `averageHR`, `maxHR`, `averageSpeed` (m/s), plus calories and power when present. Filters: `start`, `limit`, `startDate`, `endDate`, `activityType`, `activitySubType`, `search`. |
| `get_activity_details` | `GET /activity-service/activity/{activityId}` | Curated metrics for one workout/ride (speed, HR, power, cadence, elevation, training effect/load, temperature, ...) and split summaries. `raw: true` returns the full payload. |
| `get_daily_summary` | `GET /usersummary-service/usersummary/daily` (one day) or `GET /usersummary-service/v2/dailysummaries` (range, up to 1 year) | Steps, distance, calories, resting/min/max HR, stress, Body Battery, intensity minutes, floors, SpO2, respiration, hydration. |
| `get_sleep_data` | `GET /sleep-service/sleep/dailySleep` (one night) or `GET /sleep-service/sleep/dailySleepSummariesByDate` (range, up to 31 days) | Total sleep, deep/light/REM/awake durations, sleep score and sub-scores, overnight HR/stress/SpO2/respiration, sleep need. |
| `get_hrv_data` | `GET /hrv-service/hrv/daily/{fromDate}/{toDate}` | Last-night average and 5-min high, weekly average, HRV status and baseline range. Defaults to the last 7 days. |
| `get_body_battery` | `GET /wellness-service/wellness/bodyBattery/reports/daily` | Charged/drained, start/end/high/low level and the events that moved it (range up to 31 days). `includeTimeline: true` adds intraday readings (`chunks` controls resolution). |

All dates are `YYYY-MM-DD`. When a tool is called without a date, "today" is computed in the `TIMEZONE` set in
`wrangler.jsonc` (default `UTC`).

## Prerequisites

- **Node.js 20+** (`node --version`)
- A **Cloudflare account** (free plan is fine)
- A **Garmin Personal API key**: sign in to Garmin Connect on the web, open the *Personal API Key* page,
  select **Create Key**, accept the terms, choose an expiration period (30 days to 1 year) and copy the key.
  It is shown only once.

## Setup

Run every command from this folder in PowerShell (or any terminal).

### 0. Install dependencies and log in to Cloudflare

```powershell
npm install
```

```powershell
npx wrangler login
```

### 1. Create the KV namespace and put its id in `wrangler.jsonc`

```powershell
npx wrangler kv namespace create OAUTH_KV
```

Wrangler prints something like:

```
✨ Success!
{
  "kv_namespaces": [
    { "binding": "OAUTH_KV", "id": "0f2ac74b498b48028cb68387c421e279" }
  ]
}
```

If Wrangler asks whether to add the binding to your config for you, answer **No**. Then open `wrangler.jsonc`
and replace the placeholder with your id:

```jsonc
"kv_namespaces": [
	{
		"binding": "OAUTH_KV",
		"id": "0f2ac74b498b48028cb68387c421e279" // <- your id
	}
],
```

Optional: while you're in `wrangler.jsonc`, set `"TIMEZONE"` to your IANA timezone (for example
`"Europe/Berlin"`) so "today" matches your watch.

### 2. Set the secrets

Generate a strong admin password (this is what you'll type on the approval page when Gemini connects):

```powershell
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

`wrangler.jsonc` lists both secrets under `secrets.required`, so Wrangler won't create the Worker without them,
and `wrangler secret put` can't target a Worker that doesn't exist yet. For the **first** deploy, put them in a
local file instead. Create `.secrets.env` in this folder (it is git-ignored), with no quotes around the values:

```
GARMIN_PERSONAL_API_KEY=your-garmin-personal-api-key
MCP_ADMIN_PASSWORD=the-password-you-just-generated
```

The password must be at least 8 characters; the approval page refuses to work otherwise. Use the generated one,
and keep a copy in your password manager: you'll type it when Gemini connects.

### 3. Deploy

```powershell
npx wrangler deploy --secrets-file .secrets.env
```

Then delete the file so the key doesn't sit on disk:

```powershell
Remove-Item .secrets.env
```

If Wrangler says you need to register a `workers.dev` subdomain, choose one at
[dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** (it applies to your whole account) and
deploy again. Later deploys are just `npx wrangler deploy`, and you change a secret with
`npx wrangler secret put <NAME>`.

The output ends with your URL, for example `https://garmin-mcp.<your-subdomain>.workers.dev`.
Your MCP server URL is that address plus `/mcp`:

```
https://garmin-mcp.<your-subdomain>.workers.dev/mcp
```

Quick checks (open in a browser):

- `https://garmin-mcp.<your-subdomain>.workers.dev/` shows "Garmin MCP server"
- `https://garmin-mcp.<your-subdomain>.workers.dev/.well-known/oauth-protected-resource/mcp` shows JSON whose
  `resource` is your `/mcp` URL

### 4. Connect it to Gemini

1. Open [gemini.google.com](https://gemini.google.com) and go to **Settings → Apps → Add MCP Server**.
   Google renames this area from time to time; it may appear as **Connected apps → Add custom app** or
   **Connectors → + Custom**. Custom MCP apps are only available on eligible accounts.
2. Enter a name (for example `Garmin`) and the server URL `https://garmin-mcp.<your-subdomain>.workers.dev/mcp`.
3. Leave the OAuth client ID / client secret fields **empty**. Gemini registers itself automatically through
   Dynamic Client Registration.
4. Gemini opens this server's approval page. Check that it says access will be sent to a Google host, enter your
   `MCP_ADMIN_PASSWORD` and select **Approve**.
5. Back in Gemini, try:
   - "List my last 10 Garmin activities."
   - "How did I sleep last night, and how does it compare to the past week?"
   - "Show my HRV status and Body Battery for the last 7 days."
   - "Give me the details of my most recent ride."

Gemini keeps a refresh token, so you only do this once. The connection stays valid as long as Gemini uses it at
least once every 30 days.

**If Gemini insists on a client ID and secret**, register a client yourself. Copy the redirect/callback URL that
Gemini shows in its advanced settings, then run (replace both placeholders):

```powershell
Invoke-RestMethod -Method Post -Uri "https://garmin-mcp.<your-subdomain>.workers.dev/register" -ContentType "application/json" -Body '{"client_name":"Gemini","redirect_uris":["<GEMINI_REDIRECT_URL>"],"grant_types":["authorization_code","refresh_token"],"response_types":["code"]}'
```

Paste the returned `client_id` and `client_secret` into Gemini.

## Local development

```powershell
Copy-Item .dev.vars.example .dev.vars
```

Edit `.dev.vars` with real values (it is git-ignored), then:

```powershell
npm run dev
```

The server runs at `http://localhost:8787`, with the MCP endpoint at `http://localhost:8787/mcp`. Test it with the
MCP Inspector, which handles the OAuth flow for you:

```powershell
npx @modelcontextprotocol/inspector
```

Choose the **Streamable HTTP** transport and the URL `http://localhost:8787/mcp`.

Other scripts:

| Command | What it does |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run check` | Type-check, then bundle with `wrangler deploy --dry-run` |
| `npm run cf-typegen` | Regenerate `worker-configuration.d.ts` after editing `wrangler.jsonc` |
| `npx wrangler tail` | Stream live logs from the deployed Worker |

## Security

- **Only you can authorize clients.** Any app can register via DCR, but tokens are issued only after the
  correct `MCP_ADMIN_PASSWORD` is entered on `/authorize`. The comparison is constant-time.
- **Brute-force protection.** After 5 wrong passwords from one IP, that IP is locked out for 15 minutes; after
  20 wrong passwords in total within an hour, all new approvals are paused for that hour. Existing connections
  keep working during a lockout.
- **Consent page hardening.** The approval form is bound to the browser that opened it, works once and expires
  after 10 minutes. The page cannot be framed, loads no scripts and shows where the tokens will be sent.
- **Read-only.** Every tool only reads data; nothing is written to Garmin.
- **Secrets stay secret.** The Garmin API key and admin password are Cloudflare secrets. OAuth tokens, codes
  and client secrets are stored in KV only as hashes. The cached Garmin access token is AES-GCM encrypted with a
  key derived from your API key, so a KV dump alone can't use it.

### Revoking access

Remove the app in Gemini, then delete the stored grants and tokens (the server's single user is `owner`):

```powershell
npx wrangler kv key list --binding OAUTH_KV --remote --prefix "grant:owner:"
```

```powershell
foreach ($prefix in "grant:owner:", "token:owner:") { (npx wrangler kv key list --binding OAUTH_KV --remote --prefix $prefix | ConvertFrom-Json) | ForEach-Object { npx wrangler kv key delete --binding OAUTH_KV --remote $_.name } }
```

Changing `MCP_ADMIN_PASSWORD` stops new approvals with the old password but does **not** disconnect clients
that are already approved; delete their grants as shown above.

### Rotating the Garmin API key

Garmin keys expire after the period you chose (Garmin emails you about a week before). Create a new key in
Garmin Connect, then:

```powershell
npx wrangler secret put GARMIN_PERSONAL_API_KEY
```

The cached access token is tied to the old key's fingerprint, so the new key is used immediately. No redeploy
is needed.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Tool error "Garmin rejected the Personal API key" | The key expired, was deleted or was pasted wrongly. Create a new one and `secret put` it again. |
| Approval page says "Server not configured" | `MCP_ADMIN_PASSWORD` is missing or shorter than 8 characters. |
| "Too many attempts" | Wait for the lockout to end (15 minutes per IP, up to 1 hour globally), then start the connection again from Gemini. |
| "Authorization failed ... expired or was already used" | Start the connection again from Gemini; each approval page works once and for 10 minutes. |
| Gemini says the server needs re-authorization | The refresh token expired after 30 days without use, or grants were deleted. Reconnect. |
| `Date range is N days` errors | Sleep and Body Battery allow at most 31 days per call; daily summaries allow up to 366. Split the range. |
| Deploy error about the KV namespace id | Step 1 wasn't completed: put the real id in `wrangler.jsonc`. |

## Project layout

```
src/
  index.ts          OAuthProvider setup (DCR, CIMD, scopes, token lifetimes) and the Worker entry point
  auth-handler.ts   Landing page and the password-protected /authorize consent flow
  security.ts       Constant-time password check and KV-backed brute-force lockout
  html.ts           HTML templates and security headers for the auth pages
  mcp.ts            GarminMCP (McpAgent Durable Object) and the six MCP tools
  garmin.ts         Garmin Personal API client with encrypted token caching
  format.ts         Date helpers and response shaping
wrangler.jsonc      Worker config: Durable Object, KV, vars, required secrets
worker-configuration.d.ts   Generated by `wrangler types` (Env + runtime types)
```

## Notes

- `agents` 0.34 marks `McpAgent` as feature-frozen in favour of its newer `createMcpHandler` API for MCP SDK v2.
  `McpAgent` is still fully supported and is what this project uses with `@modelcontextprotocol/sdk` 1.x. That's
  also why `@modelcontextprotocol/server` and `@modelcontextprotocol/client` (v2) are installed: `agents/mcp`
  imports them.
- The OAuth resource identifier is derived from the request origin, so the same build works on `workers.dev`, a
  custom domain and `wrangler dev` without config changes.
