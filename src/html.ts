/** Tiny, dependency-free HTML templates for the authorization pages. */

import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

export const escapeHtml = (value: unknown): string =>
	String(value ?? "").replace(/[&<>"'`=/]/g, (char) => `&#${char.charCodeAt(0)};`);

/** Security headers for every HTML page we render. No scripts, no framing, no external loads. */
export function htmlHeaders(base?: Headers): Headers {
	const headers = new Headers(base);
	headers.set("Content-Type", "text/html; charset=utf-8");
	headers.set("Cache-Control", "no-store");
	headers.set(
		"Content-Security-Policy",
		"default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; frame-ancestors 'none'",
	);
	headers.set("X-Frame-Options", "DENY");
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("Referrer-Policy", "no-referrer");
	return headers;
}

const STYLES = `
:root { color-scheme: light dark; --bg:#f5f6f8; --card:#fff; --fg:#1d2433; --muted:#5b6475; --accent:#0a66c2; --danger:#b42318; --warn-bg:#fff4e5; --warn-fg:#8a4b00; --border:#d9dde5; }
@media (prefers-color-scheme: dark) { :root { --bg:#0f1218; --card:#181c24; --fg:#e8ebf1; --muted:#9aa3b5; --accent:#5aa9ff; --danger:#ff7b72; --warn-bg:#3a2a10; --warn-fg:#ffcf8a; --border:#2b3140; } }
* { box-sizing: border-box; }
body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; padding:24px; }
main { width:100%; max-width:440px; background:var(--card); border:1px solid var(--border); border-radius:14px; padding:28px; box-shadow:0 8px 30px rgba(0,0,0,.08); }
h1 { font-size:1.3rem; margin:0 0 4px; }
p { margin:10px 0; }
.muted { color:var(--muted); font-size:.92rem; }
.facts { border:1px solid var(--border); border-radius:10px; padding:12px 14px; margin:16px 0; font-size:.94rem; }
.facts div { display:flex; justify-content:space-between; gap:12px; padding:3px 0; }
.facts dt { color:var(--muted); } .facts dd { margin:0; font-weight:600; text-align:right; word-break:break-all; }
.warn { background:var(--warn-bg); color:var(--warn-fg); border-radius:10px; padding:10px 12px; font-size:.92rem; }
.error { color:var(--danger); font-weight:600; }
label { display:block; font-weight:600; margin:18px 0 6px; }
input[type=password] { width:100%; padding:11px 12px; font-size:1rem; border:1px solid var(--border); border-radius:8px; background:transparent; color:var(--fg); }
.actions { display:flex; gap:10px; margin-top:18px; }
button { flex:1; padding:11px 14px; font-size:1rem; font-weight:600; border-radius:8px; border:1px solid var(--border); cursor:pointer; background:transparent; color:var(--fg); }
button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
code { font-size:.9em; word-break:break-all; }
`;

function layout(title: string, body: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export function consentPage(
	details: ConsentDescription,
	handle: string,
	error?: string,
	options: { cycleTracking?: boolean } = {},
): string {
	const name = escapeHtml(details.clientName);
	const verified = details.clientDomain
		? `<div><dt>Verified domain</dt><dd>${escapeHtml(details.clientDomain)}</dd></div>`
		: "";
	const scopes = details.scope.length ? escapeHtml(details.scope.join(" ")) : "garmin:read";
	const loopbackWarning = details.redirectIsLoopback
		? `<p class="warn"><strong>Heads up:</strong> access will be sent to an app on this computer (${escapeHtml(
				details.redirectHost,
			)}). Continue only if you just started connecting from it.</p>`
		: "";
	const unverified = details.clientDomain
		? ""
		: `<p class="muted">This app registered itself, so its name is not verified. Check where access is sent below.</p>`;

	return layout(
		`Authorize ${details.clientName}`,
		`<h1>Connect your Garmin data</h1>
<p><strong>${name}</strong> wants read-only access to your Garmin Connect data (activities, sleep, HRV, Body Battery, daily health stats, VO2 max, weight, Fitness Age, heart rate zones, logged food${options.cycleTracking ? " and menstrual cycle tracking" : ""}).</p>
${unverified}
<dl class="facts">
  <div><dt>App</dt><dd>${name}</dd></div>
  ${verified}
  <div><dt>Access sent to</dt><dd>${escapeHtml(details.redirectHost)}</dd></div>
  <div><dt>Permissions</dt><dd>${scopes}</dd></div>
</dl>
${loopbackWarning}
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
<form method="post" autocomplete="off">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <label for="password">Admin password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" autofocus>
  <div class="actions">
    <!-- Approve comes first so pressing Enter in the password field approves. -->
    <button type="submit" name="decision" value="approve" class="primary">Approve</button>
    <button type="submit" name="decision" value="deny">Deny</button>
  </div>
</form>
<p class="muted">Only approve if you started this connection yourself.</p>`,
	);
}

export function messagePage(title: string, message: string): string {
	return layout(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}

export function homePage(mcpUrl: string): string {
	return layout(
		"Garmin MCP server",
		`<h1>Garmin MCP server</h1>
<p>This is a private Model Context Protocol server for one person's Garmin Connect data.</p>
<p class="muted">MCP endpoint (Streamable HTTP, OAuth 2.0):</p>
<p><code>${escapeHtml(mcpUrl)}</code></p>`,
	);
}
