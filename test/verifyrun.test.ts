import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { argvToString, packageManagerOf, pickVerifyCommand, summarizeVerify, summarizeVerifyRuns } from "../src/verifyrun.ts";

describe("pickVerifyCommand", () => {
	it("prefers verify, then check, ci, validate", () => {
		const all = { test: "t", verify: "v", check: "c", ci: "i", validate: "x" };
		assert.deepEqual(pickVerifyCommand(all), [["npm", "run", "verify"]]);
		assert.deepEqual(pickVerifyCommand({ test: "t", check: "c", ci: "i" }), [["npm", "run", "check"]]);
		assert.deepEqual(pickVerifyCommand({ test: "t", ci: "i", validate: "x" }), [["npm", "run", "ci"]]);
		assert.deepEqual(pickVerifyCommand({ test: "t", validate: "x" }), [["npm", "run", "validate"]]);
	});

	it("falls back to typecheck, lint, test and build, cheapest first", () => {
		assert.deepEqual(pickVerifyCommand({ build: "b", test: "t", lint: "l", typecheck: "tsc --noEmit" }), [
			["npm", "run", "typecheck"],
			["npm", "run", "lint"],
			["npm", "run", "test"],
			["npm", "run", "build"],
		]);
	});

	it("takes whichever parts exist and the first spelling of each", () => {
		assert.deepEqual(pickVerifyCommand({ test: "node --test", build: "tsc" }), [["npm", "run", "test"], ["npm", "run", "build"]]);
		assert.deepEqual(pickVerifyCommand({ "type-check": "a", tsc: "b", test: "t" }), [["npm", "run", "type-check"], ["npm", "run", "test"]]);
		assert.deepEqual(pickVerifyCommand({ build: "b" }), [["npm", "run", "build"]]);
	});

	it("ignores empty scripts and the npm no-test placeholder", () => {
		assert.deepEqual(pickVerifyCommand({ test: 'echo "Error: no test specified" && exit 1' }), []);
		assert.deepEqual(pickVerifyCommand({ verify: "  ", test: "t" }), [["npm", "run", "test"]]);
		assert.deepEqual(pickVerifyCommand({ verify: "" }), []);
	});

	it("returns nothing when there is nothing to run", () => {
		assert.deepEqual(pickVerifyCommand({}), []);
		assert.deepEqual(pickVerifyCommand({ start: "node ." , dev: "vite" }), []);
		assert.deepEqual(pickVerifyCommand(undefined), []);
		assert.deepEqual(pickVerifyCommand(null as never), []);
	});

	it("uses the package manager named in package.json", () => {
		assert.deepEqual(pickVerifyCommand({ verify: "v" }, undefined, { packageManager: "pnpm@9.1.0" }), [["pnpm", "run", "verify"]]);
		assert.deepEqual(pickVerifyCommand({ verify: "v" }, undefined, { packageManager: "yarn@4.0.0" }), [["yarn", "run", "verify"]]);
		assert.deepEqual(pickVerifyCommand({ verify: "v" }, undefined, { packageManager: "bun@1.1.0" }), [["bun", "run", "verify"]]);
		assert.deepEqual(pickVerifyCommand({ verify: "v" }, undefined, { packageManager: "npm@10" }), [["npm", "run", "verify"]]);
		assert.deepEqual(pickVerifyCommand({ verify: "v" }, undefined, { packageManager: "something-else" }), [["npm", "run", "verify"]]);
		assert.equal(packageManagerOf(undefined), "npm");
	});

	it("lets a policy override win: one argv, or a list", () => {
		assert.deepEqual(pickVerifyCommand({ verify: "v" }, ["make", "check"]), [["make", "check"]]);
		assert.deepEqual(pickVerifyCommand({ verify: "v" }, [["cargo", "test"], ["cargo", "clippy"]]), [["cargo", "test"], ["cargo", "clippy"]]);
		assert.deepEqual(pickVerifyCommand(undefined, ["go", "test", "./..."]), [["go", "test", "./..."]]);
	});

	it("ignores an invalid override rather than running something odd", () => {
		for (const bad of ["npm test && curl evil", [], [[]], [""], [1, 2], [["ok"], "no"], {}, 5, null]) {
			assert.deepEqual(pickVerifyCommand({ test: "t" }, bad), [["npm", "run", "test"]], JSON.stringify(bad));
		}
	});

	it("never builds a shell string", () => {
		for (const argv of pickVerifyCommand({ verify: "rm -rf / ; echo" })) assert.deepEqual(argv, ["npm", "run", "verify"]);
	});
});

describe("argvToString", () => {
	it("quotes only what needs it", () => {
		assert.equal(argvToString(["npm", "run", "verify"]), "npm run verify");
		assert.equal(argvToString(["node", "--test", "test/*.test.ts"]), "node --test 'test/*.test.ts'");
		assert.equal(argvToString(["echo", "it's"]), "echo 'it'\\''s'");
		assert.equal(argvToString(["a b"]), "'a b'");
	});
});

const NODE_PASS = `ℹ tests 302
ℹ suites 20
ℹ pass 302
ℹ fail 0
ℹ cancelled 0
ℹ duration_ms 4210.5`;

const TSC_FAIL = `src/a.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.
src/b.ts(3,1): error TS2304: Cannot find name 'foo'.
Found 2 errors in 2 files.`;

describe("summarizeVerify", () => {
	it("reports a pass with the summary lines", () => {
		const text = summarizeVerify(["npm", "run", "verify"], 0, NODE_PASS);
		assert.match(text, /^`npm run verify`: passed \(exit 0\)\n```\n/);
		assert.match(text, /tests 302/);
		assert.match(text, /pass 302/);
		assert.match(text, /fail 0/);
		assert.ok(text.endsWith("```"));
	});

	it("reports a failure with the failing lines, not the whole log", () => {
		const noise = Array.from({ length: 300 }, (_, i) => `compiling module ${i}`).join("\n");
		const text = summarizeVerify(["npm", "run", "typecheck"], 2, `${noise}\n${TSC_FAIL}`);
		assert.match(text, /FAILED \(exit 2\)/);
		assert.match(text, /TS2322/);
		assert.match(text, /TS2304/);
		assert.match(text, /Found 2 errors/);
		assert.ok(!text.includes("compiling module 5\n"), "noise is not quoted");
	});

	it("does not count 'fail 0' as a failure on a failed run", () => {
		const text = summarizeVerify(["npm", "test"], 1, "ℹ pass 9\nℹ fail 0\nnot ok 4 - parses dates\n  error: expected 1 got 2");
		assert.match(text, /not ok 4/);
		assert.match(text, /expected 1 got 2/);
		assert.ok(!/ℹ fail 0/.test(text));
	});

	it("keeps the final line of a failed run", () => {
		const text = summarizeVerify(["make"], 2, "error: boom\nsome detail\nmake: *** [Makefile:3: all] Error 2\ndone");
		assert.match(text, /done$/m);
	});

	it("falls back to the last lines when nothing matches", () => {
		const text = summarizeVerify(["npm", "run", "x"], 0, "a\nb\nc\nd\ne");
		assert.match(text, /c\nd\ne/);
		assert.ok(!/^a$/m.test(text));
	});

	it("says so when there was no output", () => {
		assert.equal(summarizeVerify(["npm", "test"], 0, ""), "`npm test`: passed (exit 0)");
		assert.equal(summarizeVerify(["npm", "test"], 1, "  \n\n"), "`npm test`: FAILED (exit 1)");
	});

	it("reports a timeout or a missing exit code", () => {
		assert.match(summarizeVerify(["npm", "test"], null, "x", { timedOut: true }), /timed out/);
		assert.match(summarizeVerify(["npm", "test"], 0, "tests 3", { timedOut: true }), /timed out/);
		assert.match(summarizeVerify(["npm", "test"], undefined, "x"), /did not finish/);
		assert.match(summarizeVerify(["npm", "test"], null, "x"), /did not finish/);
	});

	it("strips terminal colors", () => {
		const text = summarizeVerify(["npm", "test"], 0, "\u001b[32m✓\u001b[0m 12 passed\n\u001b[2K\u001b[1Gdone");
		assert.ok(!text.includes("\u001b"));
		assert.match(text, /12 passed/);
	});

	it("redacts credentials in the command and the output", () => {
		const text = summarizeVerify(["node", "x.js", "--token=ghp_abcdefghijklmnopqrstuvwxyz0123456789"], 1, "error: ANTHROPIC_API_KEY=abc12345xyz rejected\nsk-ant-api03-AbCdEfGhIjKlMnOpQrStUv");
		assert.ok(!/ghp_|abc12345xyz|sk-ant/.test(text), text);
		assert.match(text, /\[redacted\]/);
	});

	it("truncates long lines and the whole text", () => {
		const long = `error ${"x".repeat(500)}`;
		const text = summarizeVerify(["npm", "test"], 1, long);
		assert.ok(text.length < 400);
		assert.match(text, /…/);
		const many = Array.from({ length: 100 }, (_, i) => `error TS${2000 + i}: ${"y".repeat(150)}`).join("\n");
		const capped = summarizeVerify(["npm", "test"], 1, many, { maxChars: 600 });
		assert.ok(capped.length <= 600, String(capped.length));
		assert.ok(capped.startsWith("`npm test`: FAILED (exit 1)"));
	});

	it("limits the quoted lines", () => {
		const many = Array.from({ length: 50 }, (_, i) => `error number ${i}`).join("\n");
		const text = summarizeVerify(["npm", "test"], 1, many, { maxLines: 5 });
		assert.ok((text.match(/^error number/gm) ?? []).length <= 5);
		assert.match(text, /error number 49/);
	});

	it("understands other runners' summaries", () => {
		assert.match(summarizeVerify(["pnpm", "run", "test"], 0, " Test Files  4 passed (4)\n      Tests  31 passed (31)\n   Duration  1.2s"), /31 passed/);
		assert.match(summarizeVerify(["cargo", "test"], 0, "test result: ok. 12 passed; 0 failed; 0 ignored"), /12 passed/);
		assert.match(summarizeVerify(["pytest"], 1, "FAILED tests/test_a.py::test_x - assert 1 == 2\n1 failed, 3 passed in 0.12s"), /FAILED tests\/test_a\.py/);
	});

	it("never throws", () => {
		for (const out of ["", "\u0000", "x".repeat(200_000), "\r\n\r\n"]) assert.doesNotThrow(() => summarizeVerify(["a"], 1, out));
	});
});

describe("summarizeVerifyRuns", () => {
	it("summarizes several commands with an overall verdict", () => {
		const { passed, text } = summarizeVerifyRuns([
			{ argv: ["npm", "run", "typecheck"], exitCode: 0, outputTail: "Found 0 errors." },
			{ argv: ["npm", "run", "test"], exitCode: 0, outputTail: NODE_PASS },
		]);
		assert.equal(passed, true);
		assert.match(text, /^All 2 verify commands passed\./);
		assert.match(text, /`npm run typecheck`: passed/);
		assert.match(text, /`npm run test`: passed/);
	});

	it("fails overall when any command fails or times out", () => {
		const result = summarizeVerifyRuns([
			{ argv: ["npm", "run", "lint"], exitCode: 0, outputTail: "ok" },
			{ argv: ["npm", "run", "test"], exitCode: 1, outputTail: "not ok 1 - a" },
			{ argv: ["npm", "run", "build"], exitCode: null, outputTail: "", timedOut: true },
		]);
		assert.equal(result.passed, false);
		assert.match(result.text, /^2 of 3 verify commands failed\./);
		assert.match(result.text, /timed out/);
	});

	it("says plainly when there was nothing to run", () => {
		const result = summarizeVerifyRuns([]);
		assert.equal(result.passed, false);
		assert.match(result.text, /No verify command was run/);
	});

	it("handles one command with the singular wording", () => {
		assert.match(summarizeVerifyRuns([{ argv: ["npm", "test"], exitCode: 0, outputTail: "pass 3" }]).text, /^All 1 verify command passed\./);
	});

	it("shares the character budget between commands", () => {
		const big = Array.from({ length: 40 }, (_, i) => `error TS${i}: ${"z".repeat(120)}`).join("\n");
		const { text } = summarizeVerifyRuns([
			{ argv: ["a"], exitCode: 1, outputTail: big },
			{ argv: ["b"], exitCode: 1, outputTail: big },
		], { maxChars: 1000 });
		assert.ok(text.length < 1300, String(text.length));
	});
});
