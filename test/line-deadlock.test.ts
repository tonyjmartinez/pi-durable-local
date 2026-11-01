// A commit callback runs on the harness's Session line. Calling anything else that waits for that line from inside it
// (reading or ending a task, inspecting the scheduler) never returns, and every later write and /status hangs with it.
// `pd direct` once did exactly that and wedged the daemon until a restart.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const LINE_CALLS = /\b(endLiveTask|getTask|abortTask|waitForTask|retryTask)\s*\(|\.inspect\s*\(/;

/** The body of every `.commit(async (tx) => { … })` callback in a source file, found by brace matching. */
function commitBodies(source: string): { line: number; body: string }[] {
	const out: { line: number; body: string }[] = [];
	const start = /\.commit\(\s*async\s*\(\s*tx\s*\)\s*=>\s*\{/g;
	for (let match = start.exec(source); match !== null; match = start.exec(source)) {
		let depth = 1;
		let i = match.index + match[0].length;
		for (; i < source.length && depth > 0; i++) {
			if (source[i] === "{") depth++;
			else if (source[i] === "}") depth--;
		}
		out.push({ line: source.slice(0, match.index).split("\n").length, body: source.slice(match.index + match[0].length, i) });
	}
	return out;
}

describe("commit callbacks", () => {
	it("never wait on the Session line they already hold", () => {
		const offenders: string[] = [];
		for (const file of readdirSync("src").filter((name) => name.endsWith(".ts"))) {
			for (const { line, body } of commitBodies(readFileSync(`src/${file}`, "utf8"))) {
				const hit = LINE_CALLS.exec(body);
				if (hit) offenders.push(`src/${file}:${line} calls ${hit[0]} inside a commit`);
			}
		}
		assert.deepEqual(offenders, []);
	});

	it("finds a line call inside a commit (the check itself works)", () => {
		const bad = "await harness.commit(async (tx) => {\n\tif (x) { y(); }\n\tawait endLiveTask(harness, id, context, { wait: false });\n}, context);";
		assert.equal(commitBodies(bad).length, 1);
		assert.match(commitBodies(bad)[0]!.body, LINE_CALLS);
	});
});
