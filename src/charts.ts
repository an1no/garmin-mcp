/**
 * Server-side SVG charts for MCP Apps hosts (e.g. Claude). get_trends and get_day_details attach
 * the markup to their result's `_meta`; the small app in chart-app.ts only inserts it. The model
 * never sees it, and hosts without MCP Apps support just use the text content as before.
 *
 * Colours come from CSS variables defined by the app, so the charts follow the host's theme.
 */

type Json = Record<string, unknown>;

/** Where the chart markup travels in a tool result. */
export const CHART_META_KEY = "garmin-mcp/charts";

export type Point = { x: string; y?: number; lo?: number; hi?: number };
export type Series = {
	title: string;
	unit: string;
	kind: "line" | "bar";
	points: Point[];
	/** Decimals shown in labels and tooltips. */
	decimals?: number;
	/** CSS colour variable index (1-4). */
	color?: number;
	/** Start the y-axis at zero (bars always do). */
	fromZero?: boolean;
	/** Draw the line across missing points (for sparse measurements like weight); otherwise gaps break it. */
	connectGaps?: boolean;
};

// Sized for a two-column layout in a chat-width frame (~340 px per chart); scales up when single-column.
const WIDTH = 460;
const HEIGHT = 210;
const MARGIN = { top: 12, right: 12, bottom: 28, left: 44 };
const MAX_X_LABELS = 6;

function obj(value: unknown): Json {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function arr(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function escapeXml(value: unknown): string {
	return String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function fmt(value: number, decimals: number): string {
	return value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** Decimals needed to write a tick step exactly (2 -> 0, 2.5 -> 1, 0.25 -> 2). */
export function stepDecimals(step: number): number {
	for (let d = 0; d < 4; d++) if (Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) < 1e-9) return d;
	return 4;
}

/** "Nice" round tick values covering [min, max]. */
export function ticks(min: number, max: number, count = 4): number[] {
	if (min === max) {
		const pad = Math.abs(min) * 0.1 || 1;
		min -= pad;
		max += pad;
	}
	const rough = (max - min) / count;
	const magnitude = 10 ** Math.floor(Math.log10(rough));
	const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? rough;
	const start = Math.floor(min / step) * step;
	const out: number[] = [];
	// Keep going until a tick reaches the maximum, so every value lies inside the axis.
	for (let v = start; ; v += step) {
		out.push(Math.round(v * 1e6) / 1e6);
		if (v >= max - step * 1e-9) break;
	}
	return out;
}

/** One chart as an SVG figure; undefined when fewer than two points have values. */
export function chartSvg(series: Series): string | undefined {
	const points = series.points;
	const values = points.flatMap((p) => [p.y, p.lo, p.hi]).filter((v): v is number => v !== undefined);
	const withY = points.filter((p) => p.y !== undefined);
	if (withY.length < 2) return undefined;

	const decimals = series.decimals ?? 0;
	const fromZero = series.kind === "bar" || series.fromZero === true;
	const yTicks = ticks(fromZero ? Math.min(0, ...values) : Math.min(...values), Math.max(...values));
	const yMin = yTicks[0]!;
	const yMax = yTicks[yTicks.length - 1]!;
	const plotW = WIDTH - MARGIN.left - MARGIN.right;
	const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
	const slot = plotW / points.length;
	const xAt = (i: number) => MARGIN.left + slot * (i + 0.5);
	const yAt = (v: number) => MARGIN.top + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;
	const color = `var(--chart-${series.color ?? 1})`;
	const tip = (p: Point) => `${escapeXml(p.x)}: ${p.y !== undefined ? fmt(p.y, decimals) : "–"} ${escapeXml(series.unit)}`;

	// As many decimals as the tick step needs (a 2.5 step must not show "3" for 2.5).
	const tickDecimals = stepDecimals((yTicks[1] ?? yMax) - yMin);
	const grid = yTicks
		.map((t) => {
			const y = yAt(t).toFixed(1);
			return `<line class="grid" x1="${MARGIN.left}" x2="${WIDTH - MARGIN.right}" y1="${y}" y2="${y}"/><text class="axis" x="${MARGIN.left - 6}" y="${y}" text-anchor="end" dominant-baseline="middle">${fmt(t, tickDecimals)}</text>`;
		})
		.join("");

	const every = Math.max(1, Math.ceil(points.length / MAX_X_LABELS));
	const xLabels = points
		.map((p, i) =>
			i % every === 0 || i === points.length - 1
				? `<text class="axis" x="${xAt(i).toFixed(1)}" y="${HEIGHT - 8}" text-anchor="middle">${escapeXml(p.x)}</text>`
				: "",
		)
		.join("");

	let marks = "";
	if (series.kind === "bar") {
		const barW = Math.max(2, Math.min(28, slot * 0.7));
		marks = points
			.map((p, i) => {
				if (p.y === undefined) return "";
				const y0 = yAt(Math.max(0, yMin));
				const y1 = yAt(p.y);
				return `<rect class="bar" fill="${color}" x="${(xAt(i) - barW / 2).toFixed(1)}" y="${Math.min(y0, y1).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.abs(y0 - y1).toFixed(1)}" rx="2"><title>${tip(p)}</title></rect>`;
			})
			.join("");
	} else {
		// Optional min-max band, then the line broken at gaps, then points with tooltips.
		const band = points.every((p) => p.lo === undefined || p.hi === undefined)
			? ""
			: segments(points, (p) => p.lo !== undefined && p.hi !== undefined)
					.map((seg) => {
						const top = seg.map(({ p, i }) => `${xAt(i).toFixed(1)},${yAt(p.hi!).toFixed(1)}`);
						const bottom = seg.map(({ p, i }) => `${xAt(i).toFixed(1)},${yAt(p.lo!).toFixed(1)}`).reverse();
						return `<polygon class="band" fill="${color}" points="${[...top, ...bottom].join(" ")}"/>`;
					})
					.join("");
		const lineRuns = series.connectGaps
			? [points.flatMap((p, i) => (p.y !== undefined ? [{ p, i }] : []))]
			: segments(points, (p) => p.y !== undefined);
		const lines = lineRuns
			.map((seg) =>
				seg.length > 1
					? `<polyline class="line" stroke="${color}" points="${seg.map(({ p, i }) => `${xAt(i).toFixed(1)},${yAt(p.y!).toFixed(1)}`).join(" ")}"/>`
					: "",
			)
			.join("");
		const dots =
			points.length <= 60
				? points
						.map((p, i) =>
							p.y === undefined
								? ""
								: `<circle class="dot" fill="${color}" cx="${xAt(i).toFixed(1)}" cy="${yAt(p.y).toFixed(1)}" r="3"><title>${tip(p)}</title></circle>`,
						)
						.join("")
				: points
						.map((p, i) =>
							p.y === undefined
								? ""
								: `<rect class="hit" x="${(xAt(i) - slot / 2).toFixed(1)}" y="${MARGIN.top}" width="${slot.toFixed(1)}" height="${plotH}"><title>${tip(p)}</title></rect>`,
						)
						.join("");
		marks = band + lines + dots;
	}

	const ys = withY.map((p) => p.y!);
	const average = ys.reduce((a, b) => a + b, 0) / ys.length;
	const summary = `latest ${fmt(ys[ys.length - 1]!, decimals)} · avg ${fmt(average, decimals)} · range ${fmt(Math.min(...ys), decimals)}–${fmt(Math.max(...ys), decimals)} ${escapeXml(series.unit)}`;

	return (
		`<figure class="chart"><figcaption><strong>${escapeXml(series.title)}</strong><span>${summary}</span></figcaption>` +
		`<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${escapeXml(series.title)}: ${summary}">${grid}${xLabels}${marks}</svg></figure>`
	);
}

/** Consecutive runs of points that satisfy `keep`, with their indexes. */
function segments(points: Point[], keep: (p: Point) => boolean): { p: Point; i: number }[][] {
	const out: { p: Point; i: number }[][] = [];
	let current: { p: Point; i: number }[] = [];
	points.forEach((p, i) => {
		if (keep(p)) current.push({ p, i });
		else if (current.length) {
			out.push(current);
			current = [];
		}
	});
	if (current.length) out.push(current);
	return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-03" -> "Mar" (or "Mar 26" when the range spans years); "2026-03-02" -> "Mar 2". */
export function periodLabel(period: string, multiYear: boolean): string {
	const [y, m, d] = period.split("-");
	const month = MONTHS[Number(m) - 1] ?? period;
	if (!d) return multiYear ? `${month} ${y!.slice(2)}` : month;
	return `${month} ${Number(d)}`;
}

/** Charts for a get_trends result: one per metric that has values in at least two periods. */
export function trendCharts(result: Json): string | undefined {
	const periods = arr(result.periods).map(obj);
	if (periods.length < 2) return undefined;
	const years = new Set(periods.map((p) => String(p.period).slice(0, 4)));
	const pick = (title: string, unit: string, kind: Series["kind"], read: (p: Json) => unknown, extra: Partial<Series> = {}) =>
		chartSvg({
			title,
			unit,
			kind,
			...extra,
			points: periods.map((p) => ({ x: periodLabel(String(p.period), years.size > 1), y: num(read(p)) })),
		});
	const charts = [
		pick("Sleep", "h", "bar", (p) => obj(p.sleep).avgSleepHours, { decimals: 1, color: 1 }),
		pick("Sleep score", "", "line", (p) => obj(p.sleep).avgSleepScore, { color: 2 }),
		pick("Resting heart rate", "bpm", "line", (p) => obj(p.daily).avgRestingHeartRate, { color: 3 }),
		pick("HRV (overnight)", "ms", "line", (p) => obj(p.hrv).avgLastNight, { color: 2 }),
		pick("Steps per day", "", "bar", (p) => obj(p.daily).avgSteps, { color: 4 }),
		pick("Stress", "", "line", (p) => obj(p.daily).avgStress, { color: 3 }),
		pick("Activity distance", "km", "bar", (p) => obj(p.activities).distanceKm, { decimals: 1, color: 1 }),
		pick("VO2 max", "ml/kg/min", "line", (p) => obj(obj(p.vo2max).generic).average, { decimals: 1, color: 2, connectGaps: true }),
		pick("Weight", "kg", "line", (p) => obj(p.weight).averageKg, { decimals: 1, color: 4, connectGaps: true }),
	].filter((c): c is string => c !== undefined);
	if (!charts.length) return undefined;
	const range = `${escapeXml(result.startDate)} – ${escapeXml(result.endDate)}`;
	return `<header><h1>Trends</h1><p>${range} · by ${String(result.groupedBy ?? "").startsWith("week") ? "week" : "month"}</p></header>${charts.join("")}`;
}

/** Charts for a get_day_details result: heart rate (with min-max band), overnight HRV, SpO2. */
export function dayCharts(result: Json): string | undefined {
	const series = (rows: unknown[], read: (r: Json) => Point | undefined) =>
		rows.map(obj).flatMap((r) => {
			const p = read(r);
			return p ? [p] : [];
		});
	const value = (r: Json) => num(r.avg) ?? num(r.value);
	const hr = obj(result.heartRate);
	const hrv = obj(result.hrv);
	const spo2 = obj(result.spo2);
	const charts = [
		chartSvg({
			title: "Heart rate",
			unit: "bpm",
			kind: "line",
			color: 3,
			points: series(arr(hr.series), (r) => ({ x: String(r.time), y: value(r), lo: num(r.min) ?? value(r), hi: num(r.max) ?? value(r) })),
		}),
		chartSvg({
			title: "HRV overnight",
			unit: "ms",
			kind: "line",
			color: 2,
			points: series(arr(hrv.series), (r) => ({ x: String(r.time), y: value(r) })),
		}),
		chartSvg({
			title: "SpO2 (hourly)",
			unit: "%",
			kind: "line",
			color: 1,
			points: series(arr(spo2.hourly), (r) => ({ x: String(r.time), y: num(r.percent) })),
		}),
	].filter((c): c is string => c !== undefined);
	if (!charts.length) return undefined;
	return `<header><h1>${escapeXml(result.date)}</h1><p>local time${result.timeZone ? ` (${escapeXml(result.timeZone)})` : ""}</p></header>${charts.join("")}`;
}
