import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { analyzeTranscript, findings, isChange } from "../src/costreport.ts";
import type { TranscriptEntry } from "../src/costreport.ts";
import { summarizeBranches } from "../src/extensions.ts";
import { formatMap, purposeOf, repoMap, symbolsOf } from "../src/repomap.ts";

describe("purposeOf", () => {
	it("takes the first sentence of the header comment", () => {
		assert.equal(purposeOf("// Shared memory for sessions. Second sentence here.\nimport x;\n", ".ts"), "Shared memory for sessions.");
		assert.equal(purposeOf("#!/usr/bin/env python3\n# Balance probe for runs\nimport os\n", ".py"), "Balance probe for runs");
		assert.equal(purposeOf("/**\n * Headless smoke test.\n */\nconst a = 1;\n", ".js"), "Headless smoke test.");
	});
	it("uses a Markdown title and skips lint pragmas", () => {
		assert.equal(purposeOf("\n# Roadmap\n\ntext", ".md"), "Roadmap");
		assert.equal(purposeOf("// eslint-disable-next-line\nconst a = 1;\n", ".js"), undefined);
		assert.equal(purposeOf("const a = 1;\n", ".ts"), undefined);
	});
});

describe("symbolsOf", () => {
	it("finds JS/TS definitions with line numbers and marks nesting", () => {
		const source = [
			"export function load() {}",
			"const WEAPONS = [];",
			"export const pick = (a) => a;",
			"class Game {",
			"  update(dt) {",
			"    if (x) {",
			"  }",
			"}",
			"export type Mode = 'a';",
			"let count = 0;",
		].join("\n");
		assert.deepEqual(symbolsOf(source, ".js").map((s) => [s.name, s.line, s.top]), [
			["load", 1, true],
			["WEAPONS", 2, true],
			["pick", 3, true],
			["Game", 4, true],
			["update", 5, false],
			["Mode", 9, true],
		]);
	});
	it("reads Markdown headings outside code fences", () => {
		const md = "# Title\n## Next\n```\n# not a heading\n```\n### Deep\n";
		assert.deepEqual(symbolsOf(md, ".md").map((s) => [s.name, s.line, s.top]), [["Title", 1, true], ["Next", 2, true], ["Deep", 6, false]]);
	});
	it("returns nothing for unknown types", () => {
		assert.deepEqual(symbolsOf("a: 1", ".yml"), []);
	});
});

describe("formatMap", () => {
	const file = (n: number) => ({ path: `src/f${n}.ts`, lines: 100, purpose: `File number ${n} does a thing.`, symbols: [{ name: `fn${n}`, line: 3, top: true }] });
	it("lists files with purposes and symbols when it fits", () => {
		const out = formatMap([file(1), file(2)]);
		assert.match(out, /^2 files, 200 lines/);
		assert.match(out, /src\/f1\.ts \(100\): File number 1 does a thing\. \| fn1:3/);
	});
	it("drops symbols, then folds to directories, to stay within the budget", () => {
		const files = Array.from({ length: 40 }, (_, n) => file(n));
		assert.match(formatMap(files, 2_000), /symbols left out/);
		const folded = formatMap(files, 300);
		assert.match(folded, /by directory/);
		assert.match(folded, /src\/ 40 files, 4000 lines/);
		assert.ok(folded.length <= 330);
	});
});

describe("repoMap", () => {
	let dir = "";
	before(() => {
		dir = mkdtempSync(join(tmpdir(), "repomap-"));
		const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
		git("init", "-q");
		mkdirSync(join(dir, "src"));
		mkdirSync(join(dir, "node_modules"));
		writeFileSync(join(dir, "src", "game.js"), "// The game loop.\nfunction update() {}\nfunction draw() {}\n");
		writeFileSync(join(dir, "src", "util.ts"), "// Helpers.\nexport const clamp = (v: number) => v;\n");
		writeFileSync(join(dir, "README.md"), "# Demo\n## Run\n");
		writeFileSync(join(dir, "package-lock.json"), "{}");
		writeFileSync(join(dir, "node_modules", "x.js"), "function hidden() {}");
		writeFileSync(join(dir, ".gitignore"), "node_modules\n");
	});
	after(() => rmSync(dir, { recursive: true, force: true }));

	it("maps tracked and new files, skipping lockfiles and ignored dirs", async () => {
		const out = await repoMap(dir);
		assert.match(out, /src\/game\.js \(3\): The game loop\. \| update:2 draw:3/);
		assert.match(out, /README\.md \(2\): Demo \| Run:2/);
		assert.doesNotMatch(out, /package-lock|hidden/);
	});
	it("gives one file's full symbol list for a file path", async () => {
		const out = await repoMap(dir, { path: "./src/game.js" });
		assert.match(out, /^src\/game\.js \(3 lines\): The game loop\.\n\s+2\s+update\n\s+3\s+draw$/);
	});
	it("narrows by directory and by query", async () => {
		assert.doesNotMatch(await repoMap(dir, { path: "src/" }), /README/);
		assert.match(await repoMap(dir, { query: "clamp" }), /^src\/util\.ts .*\n\s+2\s+clamp/);
		assert.match(await repoMap(dir, { query: "nope" }), /Nothing in the repo matches/);
		assert.match(await repoMap(dir, { path: "missing" }), /No tracked files under missing/);
	});
});

describe("summarizeBranches", () => {
	const heads = ["origin ab12", "origin/HEAD ab12", "origin/main ab12", "origin/ccr-1 cd34", "origin/ccr-2 ef56", "origin/pd/a 1111", "origin/pd/b 2222"].join("\n");
	it("keeps the deploy branch and work branches and counts the rest", () => {
		assert.equal(
			summarizeBranches(heads, "main", "pd/"),
			"Branches on GitHub:\norigin/main ab12\norigin/pd/a 1111\norigin/pd/b 2222\n(2 other branches not listed; after the fetch, git branch -r shows them)",
		);
	});
	it("caps the work branches", () => {
		assert.match(summarizeBranches(heads, "main", "pd/", 1), /origin\/pd\/a 1111\n…and 1 more pd\/\* branches/);
	});
});

describe("orientation cost", () => {
	const turn = (cost: number, calls: [string, Record<string, unknown>][] = []): TranscriptEntry => ({
		kind: "pi.assistant",
		model: [{ usage: { cost: { total: cost } }, content: calls.map(([name, args], i) => ({ type: "toolCall", id: `${name}${i}${cost}`, name, arguments: args })) }],
	});
	const tick = (iteration: number): TranscriptEntry => ({ kind: "pdl.loop-tick", data: { loopId: "L1", iteration } });

	it("recognizes changes", () => {
		assert.ok(isChange("edit", {}));
		assert.ok(isChange("bash", { command: "sed -i 's/a/b/' src/x.ts" }));
		assert.ok(isChange("bash", { command: "git add -A && git commit -m x" }));
		assert.ok(!isChange("bash", { command: "sed -n 1,40p src/x.ts; grep -n a src" }));
		assert.ok(!isChange("read", { path: "x" }));
	});
	it("counts the turns up to and including the first change, and reports a heavy share", () => {
		const entries: TranscriptEntry[] = [];
		for (let i = 0; i < 3; i++) entries.push(tick(i), turn(1, [["bash", { command: "ls" }]]), turn(1, [["edit", {}]]), turn(1));
		const report = analyzeTranscript(entries);
		assert.deepEqual(report.segments.map((s) => [s.orientTurns, s.orientCost, s.changed]), [[2, 2, true], [2, 2, true], [2, 2, true]]);
		assert.ok(findings(report).some((line) => /Getting oriented took 67% \(\$2\.00\|\$6\.00\)|Getting oriented took 67%/.test(line)));
	});
});
