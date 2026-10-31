// The maintenance loops (code-quality, ci-health) and the test-weakening park that guards every PR.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ciKey, IDLE_RECHECK_MINUTES, LOOP_SCHEDULE, MAINTENANCE_SHARE_OF_DAILY, shouldWake, summarizeRuns } from "../src/loopgate.ts";
import type { GateCi, GateLoop, GateRepo } from "../src/loopgate.ts";
import { newLoop } from "../src/ops.ts";
import { decidePr } from "../src/prtick.ts";
import { testWeakening } from "../src/testguard.ts";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-31T12:00:00Z");
const repo = (change: Partial<GateRepo> = {}): GateRepo => ({ baseHeadSha: "bbb", baseHeadCommittedAt: NOW - 2 * HOUR, lastSeenBaseSha: "aaa", openAgentPrs: [], openFrictionIssues: 0, ...change });
const wake = (loop: Partial<GateLoop>, change: Partial<GateRepo> = {}) => shouldWake({ loop: { iteration: 3, lastRunAt: NOW - 5 * HOUR, ...loop }, repo: repo(change), now: NOW });
const ci = (change: Partial<GateCi> = {}): GateCi => ({ headSha: "c0ffee1234", failing: [], flaky: [], ...change });

describe("ci-health gate", () => {
	const health = (loop: Partial<GateLoop> = {}, change: Partial<GateRepo> = {}) => wake({ kind: "ci-health", ...loop }, change);

	it("sleeps at no cost while the base branch is green", () => {
		const decision = health({}, { ci: ci() });
		assert.equal(decision.wake, false);
		assert.equal(decision.nextCheckMinutes, IDLE_RECHECK_MINUTES);
	});

	it("sleeps when the runs could not be read", () => {
		assert.equal(health({}, {}).wake, false);
	});

	it("wakes on a red base branch and names the workflows", () => {
		const decision = health({}, { ci: ci({ failing: ["test"] }) });
		assert.equal(decision.wake, true);
		assert.match(decision.reason, /failing on c0ffee1: test/);
	});

	it("wakes on a flaky workflow", () => {
		assert.match(health({}, { ci: ci({ flaky: ["e2e"] }) }).reason, /flaky: e2e/);
	});

	it("does not retry the same red commit every hour, but wakes for a new one", () => {
		const red = ci({ failing: ["test"] });
		assert.equal(health({ lastCiKey: ciKey(red) }, { ci: red }).wake, false);
		assert.equal(health({ lastCiKey: ciKey(red) }, { ci: { ...red, headSha: "deadbeef00" } }).wake, true);
	});

	it("is the exception to the daily-budget yield when the base is red", () => {
		const share = MAINTENANCE_SHARE_OF_DAILY + 0.1;
		assert.equal(health({}, { ci: ci({ flaky: ["e2e"] }), dailySpendShare: share }).wake, false);
		assert.equal(health({}, { ci: ci({ failing: ["test"] }), dailySpendShare: share }).wake, true);
	});
});

describe("summarizeRuns", () => {
	const run = (workflowName: string, conclusion: string | null, minutesAgo: number, headSha = "new", status = "completed") =>
		({ workflowName, conclusion, status, headSha, createdAt: new Date(NOW - minutesAgo * 60_000).toISOString() });

	it("is undefined with no runs", () => assert.equal(summarizeRuns([]), undefined));

	it("marks a workflow failing when its newest completed run failed, whatever the order", () => {
		const out = summarizeRuns([run("ci", "success", 30, "old"), run("ci", "failure", 5)]);
		assert.deepEqual(out, { headSha: "new", failing: ["ci"], flaky: [] });
	});

	it("marks a workflow flaky when over 20% of its runs failed but it is green now", () => {
		const runs = [run("ci", "success", 1), run("ci", "failure", 2), run("ci", "success", 3), run("ci", "success", 4)];
		assert.deepEqual(summarizeRuns(runs)?.flaky, ["ci"]);
		assert.deepEqual(summarizeRuns(runs.slice(0, 1).concat(runs.slice(2)))?.flaky, []);
	});

	it("ignores cancelled, skipped and running runs", () => {
		const out = summarizeRuns([run("ci", null, 1, "new", "in_progress"), run("ci", "cancelled", 2), run("ci", "skipped", 3), run("ci", "success", 4)]);
		assert.deepEqual(out?.failing, []);
	});
});

describe("code-quality gate", () => {
	const quality = (loop: Partial<GateLoop> = {}, change: Partial<GateRepo> = {}) => wake({ kind: "code-quality", ...loop }, change);

	it("runs like a cleanup when the product loop is quiet", () => {
		assert.equal(quality({}, { productLoopActive: false }).wake, true);
		assert.equal(quality({}, { baseHeadSha: "aaa" }).wake, false, "no new commits");
	});

	it("waits while the product loop on the repo is awake", () => {
		const decision = quality({}, { productLoopActive: true });
		assert.equal(decision.wake, false);
		assert.match(decision.reason, /product loop/);
	});

	it("yields to product loops late in the day's budget", () => {
		assert.equal(quality({}, { dailySpendShare: 0.69 }).wake, true);
		assert.equal(quality({}, { dailySpendShare: 0.7 }).wake, false);
	});
});

describe("maintenance presets", () => {
	it("get their own small budget and kind", () => {
		const defaults = { defaultBudgetUsd: 100, defaultIntervalMinutes: 30, defaultMaxIterations: 10 };
		for (const preset of ["code-quality", "ci-health"] as const) {
			const loop = newLoop({ id: "L1", session: "s", spec: { goal: "g", preset }, defaults, costAtStart: 0, now: NOW });
			assert.equal(loop.kind, preset);
			assert.equal(loop.budgetUsd, 5);
		}
		assert.equal(LOOP_SCHEDULE["ci-health"].intervalMinutes, 60);
		const explicit = newLoop({ id: "L2", session: "s", spec: { goal: "g", preset: "ci-health", budgetUsd: 9 }, defaults, costAtStart: 0, now: NOW });
		assert.equal(explicit.budgetUsd, 9);
	});
});

describe("testWeakening", () => {
	const patch = (...lines: string[]) => `@@ -1,3 +1,3 @@\n${lines.join("\n")}`;

	it("passes an ordinary change", () => {
		assert.deepEqual(testWeakening([{ filename: "src/a.test.ts", patch: patch("+it('adds', () => expect(add(1, 1)).toBe(2));") }]), []);
	});

	it("parks skipped, focused and todo tests from any session", () => {
		for (const line of ["+it.skip('x', () => {})", "+  test.only('x', () => {})", "+xit('x', () => {})", "+describe.skip('x', () => {})", "+test.todo('x')", "+@pytest.mark.skip(reason='x')"]) {
			assert.equal(testWeakening([{ filename: "test/a.test.ts", patch: patch(line) }]).length, 1, line);
		}
	});

	it("ignores .skip in application code and lines that only moved", () => {
		assert.deepEqual(testWeakening([{ filename: "src/stream.ts", patch: patch("+stream.skip(3);") }]), []);
		assert.deepEqual(testWeakening([{ filename: "test/a.test.ts", patch: patch("-it.skip('x', () => {})", "+  it.skip('x', () => {})") }]), []);
	});

	it("parks test-runner retries but not a test of the code's own retry option", () => {
		assert.equal(testWeakening([{ filename: "test/a.test.ts", patch: patch("+  this.retries(3);") }]).length, 1);
		assert.equal(testWeakening([{ filename: "playwright.config.ts", patch: patch("+  retries: 2,") }]).length, 1);
		assert.deepEqual(testWeakening([{ filename: "test/http.test.ts", patch: patch("+const client = make({ retries: 3 });") }]), []);
	});

	it("parks --passWithNoTests anywhere", () => {
		assert.match(testWeakening([{ filename: "package.json", patch: patch('-"test": "vitest run"', '+"test": "vitest run --passWithNoTests"') }])[0]!, /passes with no tests/);
	});

	it("parks a lowered coverage threshold, not a raised one", () => {
		assert.match(testWeakening([{ filename: "vitest.config.ts", patch: patch("-  lines: 80,", "+  lines: 70,") }])[0]!, /lowered from 80 to 70/);
		assert.deepEqual(testWeakening([{ filename: "vitest.config.ts", patch: patch("-  lines: 80,", "+  lines: 85,") }]), []);
	});

	it("strict mode: no deleted tests or assertions, no silenced checks, no unchecked test diffs", () => {
		const removed = [{ filename: "test/a.test.ts", patch: patch("-it('a', () => {", "-  expect(a).toBe(1);", "-});") }];
		assert.deepEqual(testWeakening(removed), [], "keep-tests-tight may prune tests outside maintenance branches");
		assert.match(testWeakening(removed, { strict: true }).join(), /removes 1 test/);
		assert.match(testWeakening([{ filename: "test/a.test.ts", patch: patch("-  expect(a).toBe(1);") }], { strict: true }).join(), /removes 1 assertion/);
		assert.match(testWeakening([{ filename: "src/a.ts", patch: patch("+// @ts-ignore") }], { strict: true }).join(), /silences/);
		assert.match(testWeakening([{ filename: "test/big.test.ts" }], { strict: true }).join(), /too large/);
		assert.deepEqual(testWeakening([{ filename: "test/big.test.ts" }]), []);
	});
});

describe("conflict wording (#38)", () => {
	const base = { state: "OPEN" as const, isDraft: false, behind: false, checks: [], tier: "low" as const, door: "two-way" as const, mergeAllowed: true };
	it("tells the agent a clean rebase over a squash-merged commit is expected", () => {
		const decision = decidePr({ ...base, conflicts: true });
		assert.equal(decision.action, "resolve-conflicts");
		assert.match(decision.reason, /git rebase origin\/<base>/);
		assert.match(decision.reason, /squash-merged an earlier commit/);
		assert.match(decision.reason, /force/);
	});
});
