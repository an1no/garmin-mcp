#!/usr/bin/env node
/**
 * Checks that every optional dependency in package-lock.json resolves to a locked package.
 *
 * npm has a long-standing bug: an incremental `npm install` on one platform can drop other
 * platforms' optional binaries (e.g. @rolldown/binding-linux-x64-gnu) from the lockfile, and
 * then `npm ci` fails in CI on Linux. If this check fails, regenerate the lockfile:
 *
 *   rm -rf node_modules package-lock.json && npm install
 */
import { readFileSync } from "node:fs";

const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const packages = lock.packages ?? {};

/** Minimal semver check for the ranges npm writes for optional dependencies (exact, ^ or ~). */
function satisfies(version, range) {
	if (!range || range === "*" || range === version) return true;
	const want = /^([\^~]?)(\d+)\.(\d+)\.(\d+)/.exec(range);
	const have = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
	if (!want || !have) return true; // unusual range: don't guess
	const [, op, major, minor] = want;
	if (op === "^") return have[1] === major && (major !== "0" || have[2] === minor);
	if (op === "~") return have[1] === major && have[2] === minor;
	return version === range.replace(/^=/, "");
}

/** Resolves `dep` from the package at `key` the way Node does: nested first, then each parent. */
function resolve(key, dep) {
	let base = key;
	for (;;) {
		const candidate = `${base ? `${base}/` : ""}node_modules/${dep}`;
		if (packages[candidate]) return packages[candidate];
		if (!base) return undefined;
		const i = base.lastIndexOf("/node_modules/");
		base = i >= 0 ? base.slice(0, i) : "";
	}
}

const problems = [];
for (const [key, pkg] of Object.entries(packages)) {
	for (const [dep, range] of Object.entries(pkg.optionalDependencies ?? {})) {
		const found = resolve(key, dep);
		if (!found || !satisfies(found.version, range)) {
			problems.push(`${key || "(root)"} -> ${dep}@${range}${found ? ` (locked ${found.version})` : " (missing)"}`);
		}
	}
}

if (problems.length) {
	console.error(`package-lock.json is missing ${problems.length} optional package(s), so \`npm ci\` will fail on some platforms:`);
	for (const p of problems.slice(0, 10)) console.error(`  ${p}`);
	if (problems.length > 10) console.error(`  ...and ${problems.length - 10} more`);
	console.error("Fix: rm -rf node_modules package-lock.json && npm install");
	process.exit(1);
}
console.log("package-lock.json: all optional platform packages are locked.");
