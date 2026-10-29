import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_POLICY } from "../src/config.ts";
import { effectiveRisk, maxTier, parsePrBody, PR_TEMPLATE, riskFloor } from "../src/prtemplate.ts";

const protectedPaths = DEFAULT_POLICY.automerge.protectedPaths;
const files = (...names: string[]) => names.map((filename) => ({ filename }));
const floor = (names: string[], extra: { additions?: number; deletions?: number; newDependencies?: boolean } = {}) =>
	riskFloor({ files: files(...names), additions: 10, deletions: 0, protectedPaths, newDependencies: false, ...extra });

const FILLED = `## Intent

Add a retry to the merge call.

Door: two-way

Cleanup: none

## Why

Merges failed on transient 502s.

## Testing

\`npm test\` passes (125 tests). Ran pr_merge against a stub that returns 502 once.

## System recap

Risk: low
Touches: pr_merge (composes)
`;

describe("PR_TEMPLATE", () => {
	it("parses as entirely unfilled", () => {
		const parsed = parsePrBody(PR_TEMPLATE);
		assert.deepEqual(parsed.missing, ["intent", "door", "why", "testing", "risk", "touches"]);
		assert.equal(parsed.door, undefined);
		assert.equal(parsed.risk, undefined);
	});

	it("names every field the parser reads", () => {
		for (const field of ["## Intent", "Door:", "Cleanup:", "## Why", "## Testing", "## System recap", "Risk:", "Touches:"]) {
			assert.ok(PR_TEMPLATE.includes(field), field);
		}
	});
});

describe("parsePrBody", () => {
	it("parses a filled template", () => {
		const parsed = parsePrBody(FILLED);
		assert.deepEqual(parsed.missing, []);
		assert.equal(parsed.intent, "Add a retry to the merge call.");
		assert.equal(parsed.door, "two-way");
		assert.equal(parsed.cleanup, "none");
		assert.equal(parsed.why, "Merges failed on transient 502s.");
		assert.match(parsed.testing!.text, /npm test/);
		assert.equal(parsed.testing!.ranNothing, false);
		assert.equal(parsed.risk, "low");
		assert.deepEqual(parsed.touches, [{ area: "pr_merge", kind: "composes" }]);
	});

	it("accepts bold labels, bullets, and CRLF line endings", () => {
		const body = "**Intent:** Fix the parser\r\n- **Door:** one-way\r\n- Cleanup: needed (#12)\r\n**Why**: because\r\n**Testing:** ran the suite\r\n**Risk:** high\r\n**Touches:** auth (adds)\r\n";
		const parsed = parsePrBody(body);
		assert.equal(parsed.intent, "Fix the parser");
		assert.equal(parsed.door, "one-way");
		assert.equal(parsed.cleanup, "needed (#12)");
		assert.equal(parsed.why, "because");
		assert.equal(parsed.risk, "high");
		assert.deepEqual(parsed.touches, [{ area: "auth", kind: "adds" }]);
		assert.deepEqual(parsed.missing, []);
	});

	it("accepts plain 'Field:' lines without headings and is case-insensitive", () => {
		const parsed = parsePrBody("intent: tidy\nDOOR: Two-Way\nwhy: noise\nTesting: unit tests pass\nRisk: Medium\nTouches: cli (extends)");
		assert.equal(parsed.door, "two-way");
		assert.equal(parsed.risk, "medium");
		assert.deepEqual(parsed.missing, []);
	});

	it("reads Risk and Touches on one wrapped line, as the upstream template writes them", () => {
		const parsed = parsePrBody("## System recap\n\nRisk: medium Touches: web ui (extends)\n");
		assert.equal(parsed.risk, "medium");
		assert.deepEqual(parsed.touches, [{ area: "web ui", kind: "extends" }]);
	});

	it("reads several Touches entries, bulleted or separated", () => {
		const bulleted = parsePrBody("## System recap\nRisk: high\nTouches:\n- guard (extends)\n- audit log (adds)\n");
		assert.deepEqual(bulleted.touches, [{ area: "guard", kind: "extends" }, { area: "audit log", kind: "adds" }]);
		const inline = parsePrBody("Risk: medium\nTouches: guard (extends); daemon (composes)\n");
		assert.deepEqual(inline.touches, [{ area: "guard", kind: "extends" }, { area: "daemon", kind: "composes" }]);
	});

	it("accepts a dash form for touches", () => {
		assert.deepEqual(parsePrBody("Risk: low\nTouches: cli - composes").touches, [{ area: "cli", kind: "composes" }]);
	});

	it("keeps free text and mermaid under the recap without confusing the fields", () => {
		const body = `${FILLED}\n\`\`\`mermaid\nsequenceDiagram\n  Why: not a field\n  A->>B: Door: one-way\n\`\`\`\n`;
		const parsed = parsePrBody(body);
		assert.equal(parsed.door, "two-way");
		assert.equal(parsed.why, "Merges failed on transient 502s.");
	});

	it("strips HTML comments, including the template hints", () => {
		const parsed = parsePrBody("Door: two-way\n<!-- one-way: data, contracts -->\nIntent: x\nWhy: y\nTesting: z\nRisk: low\nTouches: a (composes)");
		assert.equal(parsed.door, "two-way");
		assert.deepEqual(parsed.missing, []);
	});

	it("treats a door that names both values as unfilled, and one that names neither", () => {
		assert.equal(parsePrBody("Door: two-way | one-way").door, undefined);
		assert.equal(parsePrBody("Door: maybe").door, undefined);
		assert.equal(parsePrBody("Door: one way").door, "one-way");
	});

	it("does not mistake prose that starts with a field word", () => {
		const parsed = parsePrBody("Why not just retry? Because it hides the error.\nIntent: real intent");
		assert.equal(parsed.why, undefined);
		assert.equal(parsed.intent, "real intent");
	});

	it("lists exactly what is missing", () => {
		assert.deepEqual(parsePrBody("").missing, ["intent", "door", "why", "testing", "risk", "touches"]);
		assert.deepEqual(parsePrBody("Intent: x\nDoor: two-way\nRisk: low").missing, ["why", "testing", "touches"]);
	});

	it("flags a Testing section that says nothing ran", () => {
		for (const text of ["none", "N/A", "Not run", "Did not test", "No tests run", "untested.", "TBD"]) {
			const parsed = parsePrBody(`## Testing\n\n${text}\n`);
			assert.equal(parsed.testing?.ranNothing, true, text);
		}
		const honest = parsePrBody("## Testing\n\nRan `npm test`: 125 pass. Could not verify on Windows.\n");
		assert.equal(honest.testing?.ranNothing, false);
		const multi = parsePrBody("## Testing\nnone of the flaky ones failed\nnpm test passes");
		assert.equal(multi.testing?.ranNothing, false);
	});

	it("treats an empty Testing section as missing", () => {
		assert.ok(parsePrBody("## Testing\n\n## Why\nx").missing.includes("testing"));
	});

	it("never throws on odd input", () => {
		for (const body of ["", "\n\n", "```", "<", "<!--", "Touches:", "Risk:", "Door:", "###", "**", "\u0000"]) {
			assert.doesNotThrow(() => parsePrBody(body), JSON.stringify(body));
		}
	});
});

describe("riskFloor", () => {
	it("is low for a small source change", () => {
		assert.deepEqual(floor(["src/a.ts"]), { tier: "low", reasons: [] });
		assert.equal(floor(["README.md", "docs/guide.md"]).tier, "low");
	});

	it("is high for protected paths, including the old name of a rename", () => {
		const direct = floor(["Dockerfile"]);
		assert.equal(direct.tier, "high");
		assert.match(direct.reasons[0]!, /protected/);
		const renamed = riskFloor({ files: [{ filename: "src/Dockerfile.bak", previous_filename: "Dockerfile" }], additions: 1, deletions: 1, protectedPaths, newDependencies: false });
		assert.equal(renamed.tier, "high");
		assert.match(renamed.reasons.join(" "), /Dockerfile/);
		assert.equal(floor([".github/workflows/ci.yml"]).tier, "high");
		assert.equal(floor(["packages/worker/package.json"]).tier, "high");
	});

	it("is high for new dependencies", () => {
		const result = floor(["src/a.ts"], { newDependencies: true });
		assert.equal(result.tier, "high");
		assert.match(result.reasons[0]!, /dependency/);
	});

	it("uses the line thresholds: >100 medium, >400 high", () => {
		assert.equal(floor(["src/a.ts"], { additions: 100, deletions: 0 }).tier, "low");
		assert.equal(floor(["src/a.ts"], { additions: 60, deletions: 41 }).tier, "medium");
		assert.equal(floor(["src/a.ts"], { additions: 400, deletions: 0 }).tier, "medium");
		assert.equal(floor(["src/a.ts"], { additions: 300, deletions: 101 }).tier, "high");
	});

	it("takes thresholds as a parameter", () => {
		const input = { files: files("src/a.ts"), additions: 30, deletions: 0, protectedPaths, newDependencies: false };
		assert.equal(riskFloor(input).tier, "low");
		assert.equal(riskFloor(input, { mediumLines: 20 }).tier, "medium");
		assert.equal(riskFloor(input, { mediumLines: 10, highLines: 25 }).tier, "high");
	});

	it("is medium when a test changes alongside the code it tests", () => {
		const result = floor(["src/web.ts", "test/web.test.ts"]);
		assert.equal(result.tier, "medium");
		assert.match(result.reasons[0]!, /test expectations/);
		assert.equal(floor(["src/a.ts", "app.spec.ts", "pkg/x_test.go", "pkg/x.go"]).tier, "medium");
		assert.equal(floor(["lib/util.py", "tests/test_util.py"]).tier, "medium");
	});

	it("is low for a test with no changed subject, or a new test file for unchanged code", () => {
		assert.equal(floor(["test/new.test.ts"]).tier, "low");
		assert.equal(floor(["src/a.ts", "test/b.test.ts"]).tier, "low");
		assert.equal(floor(["test/a.test.ts", "docs/a.md"]).tier, "low");
	});

	it("is medium for config files", () => {
		for (const name of ["tsconfig.json", "vite.config.ts", "config/app.yml", ".eslintrc.json", "tsconfig.build.json"]) {
			assert.equal(floor([name]).tier, "medium", name);
		}
	});

	it("keeps every reason once the tier is high", () => {
		const result = floor(["Makefile", "tsconfig.json"], { additions: 150 });
		assert.equal(result.tier, "high");
		assert.ok(result.reasons.some((reason) => /protected/.test(reason)));
		assert.ok(result.reasons.some((reason) => /changed lines/.test(reason)));
	});
});

describe("effectiveRisk", () => {
	it("lets the declaration only raise the floor", () => {
		assert.equal(effectiveRisk("low", "high"), "high");
		assert.equal(effectiveRisk("medium", "high"), "high");
		assert.equal(effectiveRisk("high", "low"), "high");
		assert.equal(effectiveRisk("medium", "low"), "medium");
		assert.equal(effectiveRisk("medium", undefined), "medium");
		assert.equal(effectiveRisk("low", "low"), "low");
	});

	it("accepts a riskFloor result", () => {
		assert.equal(effectiveRisk(floor(["Dockerfile"]), "low"), "high");
		assert.equal(effectiveRisk(floor(["src/a.ts"]), "medium"), "medium");
	});

	it("maxTier picks the highest", () => {
		assert.equal(maxTier("low", "medium", "low"), "medium");
		assert.equal(maxTier(), "low");
	});
});
