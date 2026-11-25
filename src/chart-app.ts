/**
 * The MCP App (https://modelcontextprotocol.io/docs/extensions/apps) that shows the charts.
 *
 * Hosts that support MCP Apps (e.g. Claude) render this HTML in a sandboxed iframe next to the
 * result of a tool whose `_meta.ui.resourceUri` points here. It speaks the MCP Apps protocol
 * over postMessage: `ui/initialize` -> `ui/notifications/initialized`, then receives
 * `ui/notifications/tool-result` and inserts the SVG the server put in the result's `_meta`
 * (see charts.ts). No network access, no external scripts: everything is inline.
 */
import { CHART_META_KEY } from "./charts";

export const CHART_UI_URI = "ui://garmin-mcp/charts.html";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
/** MCP Apps protocol version this app speaks. */
export const MCP_APPS_PROTOCOL_VERSION = "2026-01-26";

// The theme the host reports (data-theme) wins; without one, follow the browser. color-scheme
// must match the colours, or a light page can end up with a dark canvas behind dark text.
const DARK_VARS = `
  color-scheme: dark;
  --fg: var(--color-text-primary, #e8ebf1);
  --muted: var(--color-text-secondary, #9aa3b5);
  --grid: var(--color-border-primary, #2b3140);
  --chart-1: #5aa9ff; --chart-2: #b48cff; --chart-3: #ff7b8a; --chart-4: #4cd4a3;`;

const STYLE = `
:root {
  color-scheme: light;
  --bg: var(--color-background-primary, transparent);
  --fg: var(--color-text-primary, #1d2433);
  --muted: var(--color-text-secondary, #5b6475);
  --grid: var(--color-border-primary, #d9dde5);
  --chart-1: #2f6fde; --chart-2: #8a4fd8; --chart-3: #d9485f; --chart-4: #1f9d74;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {${DARK_VARS} } }
:root[data-theme="dark"] {${DARK_VARS}
}
* { box-sizing: border-box; }
body { margin: 0; padding: 12px 14px 4px; background: var(--bg); color: var(--fg);
  font: 14px/1.45 var(--font-sans, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif); }
#root { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 0 18px; }
#root > header, #root > p { grid-column: 1 / -1; }
header h1 { font-size: 15px; margin: 0; }
header p, .muted { color: var(--muted); margin: 2px 0 10px; font-size: 12.5px; }
.chart { margin: 0 0 14px; }
figcaption { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; font-size: 13px; }
figcaption span { color: var(--muted); font-size: 12px; }
svg { width: 100%; height: auto; display: block; }
.grid { stroke: var(--grid); stroke-width: 1; }
.axis { fill: var(--muted); font-size: 13px; }
.line { fill: none; stroke-width: 2.2; stroke-linejoin: round; stroke-linecap: round; }
.band { opacity: 0.16; }
.bar { opacity: 0.85; }
.hit { fill: transparent; }
.dot:hover, .bar:hover { opacity: 1; stroke: var(--fg); stroke-width: 1; }
`;

// Plain ES5-style script: no template literals, so it can live inside this template string.
const SCRIPT = `
(function () {
  "use strict";
  var META_KEY = "${CHART_META_KEY}";
  var nextId = 1;
  var pending = {};
  var root = document.getElementById("root");

  function send(message) { window.parent.postMessage(message, "*"); }
  function notify(method, params) { send({ jsonrpc: "2.0", method: method, params: params || {} }); }
  function request(method, params) {
    var id = nextId++;
    send({ jsonrpc: "2.0", id: id, method: method, params: params });
    return new Promise(function (resolve, reject) { pending[id] = { resolve: resolve, reject: reject }; });
  }

  function applyContext(context) {
    if (!context) return;
    if (context.theme) document.documentElement.setAttribute("data-theme", context.theme);
    var variables = context.styles && context.styles.variables;
    if (variables) {
      for (var name in variables) {
        if (Object.prototype.hasOwnProperty.call(variables, name) && variables[name]) {
          document.documentElement.style.setProperty(name, variables[name]);
        }
      }
    }
  }

  function reportSize() {
    notify("ui/notifications/size-changed", { height: Math.ceil(document.documentElement.getBoundingClientRect().height) });
  }

  function message(text) {
    root.textContent = "";
    var p = document.createElement("p");
    p.className = "muted";
    p.textContent = text;
    root.appendChild(p);
  }

  function render(result) {
    var charts = result && result._meta && result._meta[META_KEY];
    if (result && result.isError) message("No chart: the tool returned an error.");
    else if (typeof charts === "string" && charts) root.innerHTML = charts;
    else message("No chart for this result (not enough data to plot).");
    reportSize();
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var m = event.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && m.method === undefined) {
      var waiting = pending[m.id];
      if (waiting) { delete pending[m.id]; if (m.error) waiting.reject(m.error); else waiting.resolve(m.result); }
      return;
    }
    if (m.method === "ui/notifications/tool-result") render(m.params);
    else if (m.method === "ui/notifications/host-context-changed") { applyContext(m.params); reportSize(); }
    else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
  });

  if (typeof ResizeObserver === "function") new ResizeObserver(reportSize).observe(document.documentElement);

  request("ui/initialize", {
    appInfo: { name: "garmin-mcp-charts", version: "1.0.0" },
    appCapabilities: {},
    protocolVersion: "${MCP_APPS_PROTOCOL_VERSION}"
  }).then(function (result) {
    applyContext(result && result.hostContext);
  }, function () {}).then(function () {
    notify("ui/notifications/initialized", {});
    reportSize();
  });
})();
`;

export const CHART_APP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Garmin charts</title>
<style>${STYLE}</style>
</head>
<body>
<main id="root"><p class="muted">Loading chart…</p></main>
<script>${SCRIPT}</script>
</body>
</html>`;
