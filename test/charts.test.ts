import { describe, expect, it } from "vitest";
import { CHART_APP_HTML, CHART_UI_URI, MCP_APP_MIME_TYPE, MCP_APPS_PROTOCOL_VERSION } from "../src/chart-app";
import { chartSvg, dayCharts, escapeXml, periodLabel, stepDecimals, ticks, trendCharts, type Point } from "../src/charts";

const count = (svg: string, tag: string) => (svg.match(new RegExp(`<${tag}[ >]`, "g")) ?? []).length;
const points = (ys: (number | undefined)[]): Point[] => ys.map((y, i) => ({ x: `P${i}`, y }));

describe("helpers", () => {
	it("ticks: round steps covering the range, also for a flat line", () => {
		expect(ticks(0, 10)).toEqual([0, 2.5, 5, 7.5, 10]);
		// The last tick must reach the maximum (61 used to fall above a top tick of 60).
		expect(ticks(52, 61)).toEqual([50, 52.5, 55, 57.5, 60, 62.5]);
		for (const [lo, hi] of [[52, 61], [0.3, 0.9], [7000, 10748], [38, 43.6], [-5, 5]] as const) {
			const t = ticks(lo, hi);
			expect(t[0]!, `${lo}-${hi}`).toBeLessThanOrEqual(lo);
			expect(t.at(-1)!, `${lo}-${hi}`).toBeGreaterThanOrEqual(hi);
		}
		const flat = ticks(50, 50);
		expect(flat[0]!).toBeLessThan(50);
		expect(flat.at(-1)!).toBeGreaterThan(50);
	});

	it("axis labels show the decimals their step needs (2.5 is not \"3\")", () => {
		expect([2, 2.5, 0.25, 1000].map(stepDecimals)).toEqual([0, 1, 2, 0]);
		const svg = chartSvg({ title: "Sleep", unit: "h", kind: "bar", decimals: 1, points: points([8.2, 8.6, 7.9]) })!;
		const labels = [...svg.matchAll(/dominant-baseline="middle">([^<]+)</g)].map((m) => m[1]);
		expect(labels).toEqual(["0.0", "2.5", "5.0", "7.5", "10.0"]);
	});

	it("periodLabel: months and weeks", () => {
		expect(periodLabel("2026-03", false)).toBe("Mar");
		expect(periodLabel("2026-03", true)).toBe("Mar 26");
		expect(periodLabel("2026-03-02", false)).toBe("Mar 2");
	});

	it("escapeXml escapes markup and quotes", () => {
		expect(escapeXml(`<script>"x"&'y'</script>`)).toBe("&#60;script&#62;&#34;x&#34;&#38;&#39;y&#39;&#60;/script&#62;");
	});
});

describe("chartSvg", () => {
	it("needs at least two values", () => {
		expect(chartSvg({ title: "T", unit: "", kind: "line", points: points([5]) })).toBeUndefined();
		expect(chartSvg({ title: "T", unit: "", kind: "line", points: points([undefined, 5, undefined]) })).toBeUndefined();
	});

	it("line: one dot with a tooltip per value, caption with latest/avg/range", () => {
		const svg = chartSvg({ title: "Resting HR", unit: "bpm", kind: "line", points: points([50, 52, 54]) })!;
		expect(svg.startsWith('<figure class="chart">')).toBe(true);
		expect(count(svg, "polyline")).toBe(1);
		expect(count(svg, "circle")).toBe(3);
		expect(svg).toContain("<title>P1: 52 bpm</title>");
		expect(svg).toContain("latest 54 · avg 52 · range 50–54 bpm");
	});

	it("bar: one rect per value, axis from zero", () => {
		const svg = chartSvg({ title: "Steps", unit: "", kind: "bar", points: points([7000, undefined, 9000]) })!;
		expect(count(svg, "rect")).toBe(2);
		expect(svg).toContain('text-anchor="end" dominant-baseline="middle">0</text>');
	});

	it("gaps break the line unless connectGaps is set", () => {
		const data = points([50, 51, undefined, 53, 54]);
		expect(count(chartSvg({ title: "HR", unit: "", kind: "line", points: data })!, "polyline")).toBe(2);
		expect(count(chartSvg({ title: "Weight", unit: "", kind: "line", points: data, connectGaps: true })!, "polyline")).toBe(1);
	});

	it("draws a min-max band when points carry lo/hi", () => {
		const svg = chartSvg({ title: "HR", unit: "bpm", kind: "line", points: [{ x: "a", y: 60, lo: 55, hi: 70 }, { x: "b", y: 65, lo: 58, hi: 80 }] })!;
		expect(count(svg, "polygon")).toBe(1);
	});

	it("long series: invisible hover targets instead of dots; x labels are thinned", () => {
		const svg = chartSvg({ title: "HR", unit: "bpm", kind: "line", points: points(Array.from({ length: 96 }, (_, i) => 60 + (i % 10))) })!;
		expect(count(svg, "circle")).toBe(0);
		expect(count(svg, "rect")).toBe(96);
		expect(count(svg, "text")).toBeLessThan(20);
	});

	it("escapes labels, titles and units", () => {
		const svg = chartSvg({ title: "<b>x</b>", unit: "<u>", kind: "line", points: [{ x: "<img>", y: 1 }, { x: "ok", y: 2 }] })!;
		expect(svg).not.toMatch(/<b>|<u>|<img>/);
	});
});

describe("trendCharts and dayCharts", () => {
	const trends = {
		startDate: "2026-01-01",
		endDate: "2026-03-31",
		groupedBy: "month",
		periods: [
			{ period: "2026-01", sleep: { avgSleepHours: 7.1, avgSleepScore: 80 }, weight: { averageKg: 55 } },
			{ period: "2026-02", sleep: { avgSleepHours: 6.9, avgSleepScore: 78 } },
			{ period: "2026-03", sleep: { avgSleepHours: 7.4, avgSleepScore: 84 }, weight: { averageKg: 54.5 } },
		],
	};

	it("one chart per metric with at least two values; title and range in the header", () => {
		const html = trendCharts(trends)!;
		expect(count(html, "figure")).toBe(3); // sleep hours, sleep score, weight (2 values, gap connected)
		expect(html).toContain("<h1>Trends</h1>");
		expect(html).toContain("2026-01-01 – 2026-03-31 · by month");
		expect(html).toContain("Weight");
		expect(html).not.toContain("Resting heart rate");
	});

	it("nothing to plot gives undefined", () => {
		expect(trendCharts({ periods: [{ period: "2026-01", sleep: { avgSleepHours: 7 } }] })).toBeUndefined();
		expect(trendCharts({ periods: [{ period: "2026-01" }, { period: "2026-02" }] })).toBeUndefined();
		expect(trendCharts({})).toBeUndefined();
	});

	it("dayCharts: heart rate with band, HRV, SpO2; header with date and zone", () => {
		const html = dayCharts({
			date: "2026-11-25",
			timeZone: "Indian/Mauritius",
			heartRate: { series: [{ time: "00:00", avg: 60, min: 55, max: 70 }, { time: "00:15", value: 58 }] },
			hrv: { series: [{ time: "01:00", value: 50 }] }, // one value: no chart
			spo2: { hourly: [{ time: "00:00", percent: 95 }, { time: "01:00", percent: 96 }] },
		})!;
		expect(count(html, "figure")).toBe(2);
		expect(count(html, "polygon")).toBe(1);
		expect(html).toContain("<h1>2026-11-25</h1>");
		expect(html).toContain("(Indian/Mauritius)");
		expect(dayCharts({ date: "2026-11-25" })).toBeUndefined();
	});
});

describe("chart app", () => {
	it("speaks the MCP Apps protocol and loads nothing from the network", () => {
		expect(CHART_UI_URI.startsWith("ui://")).toBe(true);
		expect(MCP_APP_MIME_TYPE).toBe("text/html;profile=mcp-app");
		for (const method of ["ui/initialize", "ui/notifications/initialized", "ui/notifications/tool-result", "ui/notifications/size-changed", "ui/notifications/host-context-changed"]) {
			expect(CHART_APP_HTML).toContain(method);
		}
		expect(CHART_APP_HTML).toContain(MCP_APPS_PROTOCOL_VERSION);
		expect(CHART_APP_HTML).toContain('"garmin-mcp/charts"');
		expect(CHART_APP_HTML).not.toMatch(/(src|href)=["']?https?:/);
		expect(CHART_APP_HTML).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket/);
		// The inline script must not close itself early.
		expect(CHART_APP_HTML.match(/<\/script>/g)).toHaveLength(1);
	});
});
