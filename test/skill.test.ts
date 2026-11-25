/**
 * The setup skill (skills/garmin-mcp-setup/SKILL.md) must stay a valid Agent Skill and in step with the
 * repository it describes: commands, Node version and rules.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const skill = read("skills/garmin-mcp-setup/SKILL.md");
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string>; engines: { node: string } };

function frontmatter(text: string): Record<string, string> {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
	if (!match) return {};
	return Object.fromEntries(
		match[1]!.split(/\r?\n/).map((line) => {
			const i = line.indexOf(":");
			return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
		}),
	);
}

describe("setup skill", () => {
	const meta = frontmatter(skill);

	it("has valid Agent Skills frontmatter", () => {
		expect(meta.name).toBe("garmin-mcp-setup"); // must match the folder name
		expect(meta.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
		expect(meta.name!.length).toBeLessThanOrEqual(64);
		expect(meta.description!.length).toBeGreaterThan(50);
		expect(meta.description!.length).toBeLessThanOrEqual(1024);
		expect(meta.description).toMatch(/Use when/);
		expect(meta.license).toBe("MIT");
	});

	it("points to the repository and to AGENTS.md", () => {
		expect(skill).toContain("git clone https://github.com/an1no/garmin-mcp.git");
		expect(skill).toContain("AGENTS.md");
	});

	it("keeps the secret-handling rules", () => {
		expect(skill).toMatch(/Never ask the user to paste secrets into the chat/);
		expect(skill).toMatch(/Never print, log or echo secret values/);
		expect(skill).toMatch(/Never commit/);
		expect(skill).not.toMatch(/cfut_|ApiKey [A-Za-z0-9]/);
	});

	it("only mentions commands and options that exist", () => {
		for (const script of [...skill.matchAll(/npm run ([a-z:-]+)/g)].map((m) => m[1]!)) {
			expect(pkg.scripts, `npm run ${script}`).toHaveProperty(script);
		}
		expect(read("scripts/setup.mjs")).toContain("--update-key");
		expect(read("AGENTS.md")).toMatch(/exit code|Exit code/);
	});

	it("states the same minimum Node.js version as package.json", () => {
		const minimum = pkg.engines.node.replace(/^>=\s*/, "").replace(/\.0$/, "");
		expect(skill).toContain(`Node.js ${minimum} or newer`);
	});
});
