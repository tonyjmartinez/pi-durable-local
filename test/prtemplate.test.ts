import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_POLICY } from "../src/config.ts";
import { effectiveRisk, formatHints, maxTier, parsePrBody, PR_TEMPLATE, riskFloor } from "../src/prtemplate.ts";

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

describe("hints", () => {
	const body = (recap: string, door = "Door: two-way", testing = "Ran `npm test`: 10 passing.") =>
		`## Intent\n\nFix it.\n\n${door}\n\n## Why\n\nBecause.\n\n## Testing\n\n${testing}\n\n## System recap\n\n${recap}\n`;
	const hintsOf = (text: string) => parsePrBody(text).hints;

	it("are empty when every field is filled in", () => {
		const parsed = parsePrBody(FILLED);
		assert.deepEqual(parsed.hints, {});
		assert.equal(formatHints(parsed), "");
	});

	it("cover every missing field of the unfilled template, each with an example", () => {
		const parsed = parsePrBody(PR_TEMPLATE);
		assert.deepEqual(Object.keys(parsed.hints).sort(), [...parsed.missing].sort());
		for (const [field, hint] of Object.entries(parsed.hints)) {
			assert.ok(hint.includes("`"), `${field} hint has a quoted example: ${hint}`);
		}
		assert.match(parsed.hints.touches!, /Touches: <area> \(composes\|extends\|adds\)/);
		assert.match(parsed.hints.risk!, /Risk: low/);
		assert.match(parsed.hints.door!, /Door: two-way/);
	});

	it("never quote the template's placeholders back", () => {
		const hints = Object.values(parsePrBody(PR_TEMPLATE).hints).join("\n");
		assert.ok(!hints.includes("()"), hints);
		assert.ok(!/not "/.test(hints), "a placeholder is not a wrong value");
	});

	it("tell the agent how to fix a Touches line that has no kind, using its own area", () => {
		const hint = hintsOf(body("- Risk: low. Content text only.\n- Touches: `src/content/plants/ponytail-palm.md` (the fun-fact line only). Rendered on `/plants/ponytail-palm/`.")).touches!;
		assert.match(hint, /needs a kind in parentheses/);
		assert.match(hint, /Touches: src\/content\/plants\/ponytail-palm\.md \(composes\)/);
		assert.ok(!hint.includes("``"), "no nested backticks in the example");
	});

	it("name the kinds when the kind is wrong, and say which word was used", () => {
		const hint = hintsOf(body("Risk: low\nTouches: parser (modifies)")).touches!;
		assert.match(hint, /composes, extends or adds, not "\(modifies\)"/);
		assert.match(hint, /Touches: parser \(composes\)/);
	});

	it("keep an area that has commentary or a dash short and clean", () => {
		assert.match(hintsOf(body("Risk: low\nTouches: guard - the audit hook (modifies)")).touches!, /Touches: guard \(composes\)/);
		assert.match(hintsOf(body("Risk: low\nTouches: the build system; also CI")).touches!, /Touches: the build system \(composes\)/);
		const long = hintsOf(body(`Risk: low\nTouches: ${"x".repeat(200)}`)).touches!;
		assert.ok(long.length < 260, String(long.length));
	});

	it("ask for a Touches line when there is none, or the label is empty", () => {
		for (const recap of ["Risk: low", "Risk: low\nTouches:", "Risk: low\nTouches: ()"]) {
			assert.match(hintsOf(body(recap)).touches!, /Add `Touches: <area> \(composes\|extends\|adds\)`/, recap);
		}
	});

	it("explain a Risk that is missing or not one of the three values", () => {
		assert.match(hintsOf(body("Touches: a (adds)")).risk!, /Add `Risk: low`/);
		assert.match(hintsOf(body("Risk: minimal\nTouches: a (adds)")).risk!, /Risk must be low, medium or high, not "minimal"/);
		assert.match(hintsOf(body("**Risk:** unsure\n**Touches:** a (adds)")).risk!, /not "unsure"/);
		assert.equal(hintsOf(body("Risk: Medium\nTouches: a (adds)")).risk, undefined);
	});

	it("explain a Door that is missing, names both values, or names neither", () => {
		const recap = "Risk: low\nTouches: a (adds)";
		assert.match(hintsOf(body(recap, "")).door!, /Add a line `Door: two-way`/);
		assert.match(hintsOf(body(recap, "Door: two-way or one-way")).door!, /names both values/);
		assert.match(hintsOf(body(recap, "Door: maybe")).door!, /not "maybe"/);
		assert.equal(hintsOf(body(recap, "Door: one way")).door, undefined);
	});

	it("ask Testing to list commands, both when it is missing and when it says nothing ran", () => {
		const recap = "Risk: low\nTouches: a (adds)";
		const missing = parsePrBody(body(recap, "Door: two-way", ""));
		assert.ok(missing.missing.includes("testing"));
		assert.match(missing.hints.testing!, /listing the commands you ran and their results, e\.g\. `npm test: 125 passing`/);
		const nothing = parsePrBody(body(recap, "Door: two-way", "none"));
		assert.ok(!nothing.missing.includes("testing"), "present, so not missing");
		assert.match(nothing.hints.testing!, /Testing says nothing was run/);
		assert.equal(nothing.testing?.ranNothing, true);
	});

	it("ask for Intent and Why by name", () => {
		const hints = hintsOf("Door: two-way\nRisk: low\nTouches: a (adds)\n## Testing\nnpm test ok");
		assert.match(hints.intent!, /`## Intent`/);
		assert.match(hints.why!, /`## Why`/);
	});

	it("are one line each, short, and only for fields that need fixing", () => {
		const bodies = [PR_TEMPLATE, "", "garbage", body("Touches: x"), body("Risk: ?\nTouches: a (b)", "Door: ?", "n/a"), FILLED];
		for (const text of bodies) {
			const parsed = parsePrBody(text);
			const allowed = new Set([...parsed.missing, ...(parsed.testing?.ranNothing ? ["testing"] : [])]);
			for (const [field, hint] of Object.entries(parsed.hints)) {
				assert.ok(allowed.has(field), `${field} has a hint but is fine`);
				assert.ok(!hint.includes("\n") && hint.length <= 260, `${field}: ${hint}`);
			}
			for (const field of parsed.missing) assert.ok(parsed.hints[field] !== undefined, `${field} is missing without a hint`);
		}
	});

	it("never throw, whatever the body", () => {
		for (const text of ["", "\n\n", "```", "<", "<!--", "Touches:", "Risk:", "Door:", "###", "**", "\u0000", "Touches: (", "Touches: )(", "Risk: \n\nTouches:\n(x)"]) {
			assert.doesNotThrow(() => formatHints(parsePrBody(text)), JSON.stringify(text));
		}
	});
});

describe("formatHints", () => {
	it("prints one `- field: hint` line per hint, in field order", () => {
		const text = formatHints(parsePrBody(PR_TEMPLATE));
		const lines = text.split("\n");
		assert.equal(lines.length, 6);
		assert.deepEqual(lines.map((line) => /^- (\w+):/.exec(line)?.[1]), ["intent", "door", "why", "testing", "risk", "touches"]);
	});

	it("prints only the field that needs fixing", () => {
		const text = formatHints(parsePrBody(FILLED.replace("Touches: pr_merge (composes)", "Touches: pr_merge")));
		assert.equal(text.split("\n").length, 1);
		assert.match(text, /^- touches: Touches needs a kind in parentheses/);
	});

	it("is empty when there are no hints", () => {
		assert.equal(formatHints({ hints: {} }), "");
	});
});
