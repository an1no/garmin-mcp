# Security policy

This server guards personal health data, so security reports are very welcome.

## Reporting a vulnerability

Please **don't open a public issue** for a security problem. Report it privately through GitHub instead: open the
repository's **Security** tab and choose **Report a vulnerability**.

Include what you found, how to reproduce it and what an attacker could do with it. You'll get an answer as soon as
possible, and the fix will be credited to you unless you prefer otherwise.

## Scope

In scope: the code in this repository, for example:

- the OAuth flow and the password-protected approval page (`src/auth-handler.ts`, `src/security.ts`, `src/html.ts`)
- token handling and the encrypted Garmin token cache (`src/garmin.ts`)
- the MCP tools (`src/mcp.ts`) and the setup script (`scripts/setup.mjs`)

Out of scope: Cloudflare, Garmin, Gemini or other MCP clients themselves, and problems that need an attacker who
already knows your admin password or your Garmin key.

## Keeping your own deployment safe

Everyone runs their own copy, so a few things are up to you:

- Keep the admin password in a password manager and delete `admin-password.txt` after setup.
- Never commit `.secrets.env`, `.dev.vars` or `admin-password.txt` (they're in `.gitignore`).
- If you suspect your password or Garmin key leaked: delete the key on Garmin Connect, create a new one, run
  `npm run setup -- --update-key`, set a new password with `npx wrangler secret put MCP_ADMIN_PASSWORD`, and revoke
  existing grants as described in the README's [Revoking access](README.md#revoking-access) section.
- Pull updates from this repository from time to time and redeploy with `npm run setup`.
