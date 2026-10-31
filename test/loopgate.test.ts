import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AUTO_DORMANT_AFTER, afterIteration, CHECKS_RECHECK_MINUTES, CLEANUP_PROMPTS, CLEANUP_SCHEDULE, DORMANT_RECHECK_MINUTES, IDLE_RECHECK_MINUTES, shouldWake, workFingerprint } from "../src/loopgate.ts";
import type { GateLoop, GatePr, GateRepo } from "../src/loopgate.ts";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-29T12:00:00Z");
const ago = (hours: number) => NOW - hours * HOUR;

const repo = (change: Partial<GateRepo> = {}): GateRepo => ({
	baseHeadSha: "bbb",
	baseHeadCommittedAt: ago(2),
	lastSeenBaseSha: "aaa",
	openAgentPrs: [],
	openFrictionIssues: 0,
	...change,
});
const pr = (n: number, checksState: GatePr["checksState"], extra: Partial<GatePr> = {}): GatePr => ({ number: n, headSha: `h${n}`, checksState, ...extra });
const wake = (loop: Partial<GateLoop>, change: Partial<GateRepo> = {}) => shouldWake({ loop: { iteration: 3, lastRunAt: ago(5), ...loop }, repo: repo(change), now: NOW });

describe("goal loops", () => {
	it("always wake with nothing open", () => {
		const decision = wake({});
		assert.equal(decision.wake, true);
		assert.equal(decision.nextCheckMinutes, undefined);
	});

	it("default to the goal kind", () => {
		assert.equal(wake({ kind: undefined }).wake, true);
		assert.equal(wake({ kind: "goal" }, { baseHeadSha: "aaa", baseHeadCommittedAt: ago(500) }).wake, true);
	});

	it("wake on the first iteration", () => {
		assert.equal(shouldWake({ loop: { iteration: 0 }, repo: repo(), now: NOW }).wake, true);
	});

	it("wait when every open agent PR is still running checks", () => {
		const decision = wake({}, { openAgentPrs: [pr(1, "pending"), pr(2, "pending")] });
		assert.equal(decision.wake, false);
		assert.match(decision.reason, /waiting for checks on 2 open PRs/);
		assert.equal(decision.nextCheckMinutes, CHECKS_RECHECK_MINUTES);
		assert.match(wake({}, { openAgentPrs: [pr(1, "pending")] }).reason, /1 open PR$/);
	});

	it("wake when any PR is not pending: a failure, or a pass to move on", () => {
		assert.equal(wake({}, { openAgentPrs: [pr(1, "pending"), pr(2, "fail")] }).wake, true);
		assert.equal(wake({}, { openAgentPrs: [pr(1, "pending"), pr(2, "pass")] }).wake, true);
		assert.equal(wake({}, { openAgentPrs: [pr(1, "pass")] }).wake, true);
		assert.match(wake({}, { openAgentPrs: [pr(1, "fail")] }).reason, /1 open PR/);
	});

	it("do not wait on PRs that are not there", () => {
		assert.equal(wake({}, { openAgentPrs: [] }).wake, true);
	});
});

describe("cleanup loops", () => {
	const cleanup = (loop: Partial<GateLoop> = {}, change: Partial<GateRepo> = {}) => wake({ kind: "cleanup", ...loop }, change);

	it("run the first time", () => {
		assert.deepEqual(shouldWake({ loop: { kind: "cleanup", iteration: 0 }, repo: repo({ baseHeadCommittedAt: ago(900) }), now: NOW }), { wake: true, reason: "first run" });
	});

	it("wake when the base branch moved recently", () => {
		const decision = cleanup({}, { baseHeadSha: "bbb", lastSeenBaseSha: "aaa", baseHeadCommittedAt: ago(3) });
		assert.equal(decision.wake, true);
		assert.match(decision.reason, /changed 3h ago/);
	});

	it("skip when the base head is the one seen last run", () => {
		const decision = cleanup({}, { baseHeadSha: "aaa", lastSeenBaseSha: "aaa", baseHeadCommittedAt: ago(1) });
		assert.equal(decision.wake, false);
		assert.match(decision.reason, /no new commits/);
		assert.equal(decision.nextCheckMinutes, IDLE_RECHECK_MINUTES);
	});

	it("skip when the base branch has been idle longer than the window, even if it changed since the last run", () => {
		const decision = cleanup({ lastRunAt: ago(24 * 6) }, { baseHeadSha: "bbb", lastSeenBaseSha: "aaa", baseHeadCommittedAt: ago(25) });
		assert.equal(decision.wake, false);
		assert.match(decision.reason, /idle: last commit 25h ago \(limit 24h\)/);
	});

	it("honours a custom window", () => {
		const base = { baseHeadSha: "bbb", lastSeenBaseSha: "aaa", baseHeadCommittedAt: ago(100) };
		assert.equal(cleanup({ lastRunAt: ago(24 * 6), skipIfIdleHours: 168 }, base).wake, true);
		assert.equal(cleanup({ lastRunAt: ago(24 * 6), skipIfIdleHours: 48 }, base).wake, false);
		assert.equal(cleanup({ skipIfIdleHours: 1 }, { ...base, baseHeadCommittedAt: ago(2) }).wake, false);
	});

	it("falls back to commit time when the last seen head is unknown", () => {
		const unknown = { lastSeenBaseSha: undefined };
		assert.equal(cleanup({ lastRunAt: ago(5) }, { ...unknown, baseHeadCommittedAt: ago(2) }).wake, true);
		assert.equal(cleanup({ lastRunAt: ago(5) }, { ...unknown, baseHeadCommittedAt: ago(6) }).wake, false);
		assert.equal(cleanup({ lastRunAt: undefined, iteration: 2 }, { ...unknown, baseHeadCommittedAt: ago(6) }).wake, true);
	});

	it("wake to look when the repo state is unavailable", () => {
		assert.equal(cleanup({}, { baseHeadSha: "" }).wake, true);
		assert.equal(cleanup({}, { baseHeadCommittedAt: Number.NaN }).wake, true);
		assert.equal(cleanup({}, { baseHeadCommittedAt: 0 }).wake, true);
	});

	it("wait on checks before anything else", () => {
		const decision = cleanup({}, { baseHeadCommittedAt: ago(1), openAgentPrs: [pr(1, "pending")] });
		assert.equal(decision.wake, false);
		assert.equal(decision.nextCheckMinutes, CHECKS_RECHECK_MINUTES);
	});

	it("wake when an open PR needs fixing, so the agent can finish it first", () => {
		assert.equal(cleanup({}, { baseHeadCommittedAt: ago(1), openAgentPrs: [pr(1, "fail")] }).wake, true);
	});
});

describe("friction-sweep loops", () => {
	const sweep = (change: Partial<GateRepo>) => wake({ kind: "friction-sweep" }, change);

	it("wake only when friction issues are open", () => {
		assert.equal(sweep({ openFrictionIssues: 0 }).wake, false);
		assert.equal(sweep({ openFrictionIssues: 0 }).nextCheckMinutes, IDLE_RECHECK_MINUTES);
		const decision = sweep({ openFrictionIssues: 4 });
		assert.equal(decision.wake, true);
		assert.match(decision.reason, /4 open friction issues/);
		assert.match(sweep({ openFrictionIssues: 1 }).reason, /1 open friction issue$/);
	});

	it("ignore the base branch and wait on checks", () => {
		assert.equal(sweep({ openFrictionIssues: 2, baseHeadSha: "aaa", lastSeenBaseSha: "aaa", baseHeadCommittedAt: ago(900) }).wake, true);
		assert.equal(sweep({ openFrictionIssues: 2, openAgentPrs: [pr(1, "pending")] }).wake, false);
	});
});

describe("reasons", () => {
	it("are always present and never throw", () => {
		const kinds = [undefined, "goal", "cleanup", "friction-sweep"] as const;
		for (const kind of kinds) {
			for (const prs of [[], [pr(1, "pending")], [pr(1, "fail")]]) {
				const decision = wake({ kind }, { openAgentPrs: prs, openFrictionIssues: 1 });
				assert.ok(decision.reason.length > 0);
				assert.equal(typeof decision.wake, "boolean");
				assert.ok(decision.wake || decision.nextCheckMinutes !== undefined, "a skip says when to look again");
			}
		}
	});
});

describe("CLEANUP_PROMPTS", () => {
	const names = ["keep-tests-tight", "docs-freshness", "legacy-reaper", "friction-sweep"] as const;

	it("has the four briefs", () => {
		assert.deepEqual(Object.keys(CLEANUP_PROMPTS).sort(), [...names].sort());
		assert.deepEqual(Object.keys(CLEANUP_SCHEDULE).sort(), [...names].sort());
	});

	for (const name of names) {
		it(`${name}: ends with the one-PR rule and loop_report`, () => {
			const prompt = CLEANUP_PROMPTS[name];
			assert.ok(prompt.includes("open at most ONE PR, or none if nothing to do; finish with loop_report."));
			assert.ok(prompt.trimEnd().endsWith('report status "idle" so the loop sleeps until the repo changes.'));
			assert.ok(prompt.length > 400 && prompt.length < 4000);
		});

		it(`${name}: carries the shared safety rules`, () => {
			const prompt = CLEANUP_PROMPTS[name];
			for (const needle of ["git_sync", "pr_create", "pr_tick", "protected paths", "Never have more than 3", "two-way-door", "needs-decision"]) {
				assert.ok(prompt.includes(needle), `${name} is missing ${needle}`);
			}
		});
	}

	it("only names tools that exist or are marked optional", () => {
		const known = new Set(["git_sync", "pr_create", "pr_tick", "pr_merge", "loop_report", "friction_file"]);
		for (const name of names) {
			for (const tool of CLEANUP_PROMPTS[name].match(/\b(?:git|pr|loop|friction)_[a-z_]+\b/g) ?? []) assert.ok(known.has(tool), `${name} mentions unknown tool ${tool}`);
		}
		assert.match(CLEANUP_PROMPTS["keep-tests-tight"], /friction_file, if you have it/);
	});

	it("tells each brief apart", () => {
		assert.match(CLEANUP_PROMPTS["keep-tests-tight"], /Never delete the only test/);
		assert.match(CLEANUP_PROMPTS["docs-freshness"], /git log/);
		assert.match(CLEANUP_PROMPTS["legacy-reaper"], /Prove it before you delete/);
		assert.match(CLEANUP_PROMPTS["friction-sweep"], /P0, then P1, P2, P3/);
	});

	it("pairs each brief with a schedule: daily, weekly for the reaper, a sweep kind for friction", () => {
		assert.deepEqual(CLEANUP_SCHEDULE["keep-tests-tight"], { kind: "cleanup", intervalMinutes: 1440, skipIfIdleHours: 24 });
		assert.equal(CLEANUP_SCHEDULE["legacy-reaper"].intervalMinutes, 10080);
		assert.equal(CLEANUP_SCHEDULE["legacy-reaper"].skipIfIdleHours, 168);
		assert.equal(CLEANUP_SCHEDULE["friction-sweep"].kind, "friction-sweep");
	});
});

describe("dormant loops", () => {
	const asleep = (change: Partial<GateRepo> = {}) => ({ fingerprint: workFingerprint(repo(change)), since: ago(10) });

	it("sleep without a model call while nothing changed, and look again in hours", () => {
		for (const kind of ["goal", "cleanup", "friction-sweep"] as const) {
			const decision = wake({ kind, dormant: asleep({ openIssuesKey: "2:x" }) }, { openIssuesKey: "2:x", openFrictionIssues: 4 });
			assert.equal(decision.wake, false, kind);
			assert.equal(decision.nextCheckMinutes, DORMANT_RECHECK_MINUTES);
			assert.match(decision.reason, /dormant/);
		}
	});

	it("wake on a new base commit, PR activity, or a new or edited issue", () => {
		const dormant = asleep({ openIssuesKey: "2:x" });
		assert.equal(wake({ dormant }, { openIssuesKey: "2:x", baseHeadSha: "ccc" }).wake, true);
		assert.equal(wake({ dormant }, { openIssuesKey: "2:x", openAgentPrs: [pr(9, "pass")] }).wake, true);
		assert.equal(wake({ dormant }, { openIssuesKey: "3:y" }).wake, true);
		assert.equal(wake({ dormant }, { openIssuesKey: "2:z" }).wake, true);
	});

	it("still wait for running checks before anything else", () => {
		const decision = wake({ dormant: asleep() }, { openAgentPrs: [pr(1, "pending")] });
		assert.equal(decision.wake, false);
		assert.equal(decision.nextCheckMinutes, CHECKS_RECHECK_MINUTES);
	});
});

describe("workFingerprint", () => {
	it("ignores PR order but sees a new PR head", () => {
		const a = workFingerprint(repo({ openAgentPrs: [pr(1, "pass"), pr(2, "fail")] }));
		assert.equal(a, workFingerprint(repo({ openAgentPrs: [pr(2, "pass"), pr(1, "pass")] })), "checks state is not work");
		assert.notEqual(a, workFingerprint(repo({ openAgentPrs: [pr(1, "pass", { headSha: "new" }), pr(2, "fail")] })));
	});
});

describe("afterIteration", () => {
	it("counts iterations that changed nothing and sleeps after a few", () => {
		let streak = 0;
		for (let i = 1; i < AUTO_DORMANT_AFTER; i++) {
			const next = afterIteration({ before: "f", after: "f", streak, idleReported: false });
			assert.equal(next.dormant, false);
			streak = next.streak;
		}
		assert.deepEqual(afterIteration({ before: "f", after: "f", streak, idleReported: false }), { streak: AUTO_DORMANT_AFTER, dormant: true });
	});

	it("resets on any change, and never counts what it cannot see", () => {
		assert.deepEqual(afterIteration({ before: "f", after: "g", streak: 2, idleReported: false }), { streak: 0, dormant: false });
		assert.deepEqual(afterIteration({ before: undefined, after: "g", streak: 2, idleReported: false }), { streak: 0, dormant: false });
	});

	it("sleeps at once when the agent reports idle, even if it did some work", () => {
		assert.equal(afterIteration({ before: "f", after: "g", streak: 0, idleReported: true }).dormant, true);
	});
});
