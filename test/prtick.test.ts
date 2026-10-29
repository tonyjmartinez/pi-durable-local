import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_TICK_OPTIONS, decidePr } from "../src/prtick.ts";
import type { PrAction, PrTickState } from "../src/prtick.ts";

/** A PR that is ready to merge at low risk; each case changes one thing. */
const READY: PrTickState = {
	state: "OPEN",
	isDraft: false,
	conflicts: false,
	behind: false,
	checks: [{ name: "ci", bucket: "pass" }],
	tier: "low",
	door: "two-way",
	mergeAllowed: true,
};
const pr = (change: Partial<PrTickState>): PrTickState => ({ ...READY, ...change });

type Case = { name: string; state: PrTickState; action: PrAction; options?: Parameters<typeof decidePr>[1] };

const CASES: Case[] = [
	// Lifecycle (upstream: merged -> verify-deploy/done, closed -> stop)
	{ name: "merged", state: pr({ state: "MERGED" }), action: "done" },
	{ name: "merged with a deploy check pending", state: pr({ state: "MERGED", deployCheckPending: true }), action: "verify-deploy" },
	{ name: "merged beats a red check", state: pr({ state: "MERGED", checks: [{ name: "ci", bucket: "fail" }] }), action: "done" },
	{ name: "closed", state: pr({ state: "CLOSED" }), action: "stop" },
	{ name: "closed beats a draft", state: pr({ state: "CLOSED", isDraft: true }), action: "stop" },

	// Mechanical blockers, in upstream order (draft, conflicts, behind, CI)
	{ name: "draft", state: pr({ isDraft: true }), action: "mark-ready" },
	{ name: "draft before conflicts", state: pr({ isDraft: true, conflicts: true }), action: "mark-ready" },
	{ name: "conflicts", state: pr({ conflicts: true }), action: "resolve-conflicts" },
	{ name: "conflicts before behind", state: pr({ conflicts: true, behind: true }), action: "resolve-conflicts" },
	{ name: "behind", state: pr({ behind: true }), action: "update-branch" },
	{ name: "behind before failing CI", state: pr({ behind: true, checks: [{ name: "ci", bucket: "fail" }] }), action: "update-branch" },
	{ name: "failing check", state: pr({ checks: [{ name: "ci", bucket: "fail" }] }), action: "fix-ci" },
	{ name: "cancelled check counts as failing", state: pr({ checks: [{ name: "ci", bucket: "cancel" }] }), action: "fix-ci" },
	{ name: "failure beats pending", state: pr({ checks: [{ name: "a", bucket: "pending" }, { name: "b", bucket: "fail" }] }), action: "fix-ci" },
	{ name: "pending check", state: pr({ checks: [{ name: "ci", bucket: "pending" }] }), action: "wait-ci" },
	{ name: "pending beats review", state: pr({ checks: [{ name: "ci", bucket: "pending" }], reviewDecision: "CHANGES_REQUESTED" }), action: "wait-ci" },
	{ name: "skipped checks alone are not a pass", state: pr({ checks: [{ name: "ci", bucket: "skipping" }] }), action: "park-human" },
	{ name: "no checks at all", state: pr({ checks: [] }), action: "park-human" },
	{ name: "no checks is fine when CI is not required", state: pr({ checks: [] }), action: "merge", options: { requireChecks: false } },
	{ name: "a skipped check next to a passing one", state: pr({ checks: [{ name: "a", bucket: "pass" }, { name: "b", bucket: "skipping" }] }), action: "merge" },

	// Review feedback (upstream: unresolved threads, CHANGES_REQUESTED)
	{ name: "unresolved thread", state: pr({ unresolvedThreads: [{ id: "t1", path: "src/a.ts", line: 3, body: "off by one" }] }), action: "address-review" },
	{ name: "changes requested", state: pr({ reviewDecision: "CHANGES_REQUESTED" }), action: "address-review" },
	{ name: "approved review decision does not block", state: pr({ reviewDecision: "APPROVED" }), action: "merge" },
	{ name: "no unresolved threads", state: pr({ unresolvedThreads: [] }), action: "merge" },
	{ name: "automated review rejected the head", state: pr({ tier: "medium", aiReview: false, aiReviewReasons: ["no tests"] }), action: "address-review" },

	// Tiers
	{ name: "low merges on green CI", state: pr({ tier: "low" }), action: "merge" },
	{ name: "low does not need the review", state: pr({ tier: "low", aiReview: undefined }), action: "merge" },
	{ name: "medium needs the review first", state: pr({ tier: "medium" }), action: "review" },
	{ name: "medium with an approving review merges", state: pr({ tier: "medium", aiReview: true }), action: "merge" },
	{ name: "high parks for a human", state: pr({ tier: "high", aiReview: true }), action: "park-human" },
	{ name: "high parks even before the review runs", state: pr({ tier: "high" }), action: "park-human" },
	{ name: "medium parks when only low may auto-merge", state: pr({ tier: "medium", aiReview: true }), action: "park-human", options: { autoMergeTiers: ["low"] } },
	{ name: "nothing may auto-merge", state: pr({ tier: "low" }), action: "park-human", options: { autoMergeTiers: [] } },

	// Doors and human flags
	{ name: "one-way door parks even at low risk", state: pr({ door: "one-way" }), action: "park-human" },
	{ name: "needsHuman parks", state: pr({ needsHuman: ["touches protected paths: Dockerfile"] }), action: "park-human" },
	{ name: "empty needsHuman does not park", state: pr({ needsHuman: [] }), action: "merge" },

	// Human approval lifts the limits, never CI or review (upstream: approvedByHuman)
	{ name: "human approval lifts high", state: pr({ tier: "high", humanApproved: true, aiReview: true }), action: "merge" },
	{ name: "human approval still needs the review", state: pr({ tier: "high", humanApproved: true }), action: "review" },
	{ name: "human approval lifts a one-way door", state: pr({ door: "one-way", humanApproved: true }), action: "merge" },
	{ name: "human approval lifts needsHuman", state: pr({ needsHuman: ["x"], humanApproved: true }), action: "merge" },
	{ name: "human approval does not fix red CI", state: pr({ tier: "high", humanApproved: true, checks: [{ name: "ci", bucket: "fail" }] }), action: "fix-ci" },
	{ name: "human approval does not override requested changes", state: pr({ humanApproved: true, reviewDecision: "CHANGES_REQUESTED" }), action: "address-review" },
	{ name: "human approval does not override a rejecting review", state: pr({ tier: "high", humanApproved: true, aiReview: false }), action: "address-review" },
	{ name: "human approval does not grant merge authority", state: pr({ tier: "high", humanApproved: true, aiReview: true, mergeAllowed: false }), action: "no-merge-authority" },

	// Merge authority
	{ name: "repo not allowed", state: pr({ mergeAllowed: false }), action: "no-merge-authority" },
	{ name: "repo not allowed, medium: no review spend", state: pr({ tier: "medium", mergeAllowed: false }), action: "no-merge-authority" },
	{ name: "repo not allowed but CI red: fix it first", state: pr({ mergeAllowed: false, checks: [{ name: "ci", bucket: "fail" }] }), action: "fix-ci" },
];

describe("decidePr", () => {
	for (const { name, state, action, options } of CASES) {
		it(`${action}: ${name}`, () => {
			const decision = decidePr(state, options);
			assert.equal(decision.action, action, decision.reason);
			assert.ok(decision.reason.length > 0);
		});
	}

	it("lists the failing and pending check names", () => {
		const failing = decidePr(pr({ checks: [{ name: "lint", bucket: "fail" }, { name: "test", bucket: "pass" }, { name: "build", bucket: "cancel" }] }));
		assert.deepEqual(failing.details, ["lint", "build"]);
		const pending = decidePr(pr({ checks: [{ name: "e2e", bucket: "pending" }] }));
		assert.deepEqual(pending.details, ["e2e"]);
	});

	it("says how long to wait, and lets the caller change it", () => {
		assert.equal(decidePr(pr({ checks: [{ name: "ci", bucket: "pending" }] })).waitSeconds, DEFAULT_TICK_OPTIONS.waitSeconds);
		assert.equal(decidePr(pr({ checks: [{ name: "ci", bucket: "pending" }] }), { waitSeconds: 5 }).waitSeconds, 5);
		assert.equal(decidePr(READY).waitSeconds, undefined);
	});

	it("summarizes unresolved threads for the agent", () => {
		const decision = decidePr(pr({ unresolvedThreads: [{ path: "src/a.ts", line: 3, body: "off by one" }, { body: "general note" }] }));
		assert.deepEqual(decision.details, ["src/a.ts:3 off by one", "(general) general note"]);
	});

	it("passes the automated review's reasons through", () => {
		const decision = decidePr(pr({ tier: "medium", aiReview: false, aiReviewReasons: ["no tests", "touches auth"] }));
		assert.deepEqual(decision.details, ["no tests", "touches auth"]);
	});

	it("explains a park", () => {
		assert.match(decidePr(pr({ tier: "high" })).reason, /high/);
		assert.match(decidePr(pr({ door: "one-way" })).reason, /one-way/i);
		assert.deepEqual(decidePr(pr({ needsHuman: ["a", "b"] })).details, ["a", "b"]);
		assert.match(decidePr(pr({ checks: [] })).reason, /CI/);
	});

	it("does not mutate its input or the defaults", () => {
		const state = pr({ checks: [{ name: "ci", bucket: "pass" }] });
		const snapshot = JSON.stringify(state);
		const defaults = JSON.stringify(DEFAULT_TICK_OPTIONS);
		decidePr(state, { autoMergeTiers: [] });
		assert.equal(JSON.stringify(state), snapshot);
		assert.equal(JSON.stringify(DEFAULT_TICK_OPTIONS), defaults);
	});

	it("is deterministic", () => {
		const state = pr({ tier: "medium", aiReview: true });
		assert.deepEqual(decidePr(state), decidePr(state));
	});

	it("walks a PR from draft to done, one action at a time", () => {
		const steps: [Partial<PrTickState>, PrAction][] = [
			[{ isDraft: true, checks: [] }, "mark-ready"],
			[{ checks: [{ name: "ci", bucket: "pending" }], tier: "medium" }, "wait-ci"],
			[{ checks: [{ name: "ci", bucket: "fail" }], tier: "medium" }, "fix-ci"],
			[{ tier: "medium" }, "review"],
			[{ tier: "medium", aiReview: false, aiReviewReasons: ["x"] }, "address-review"],
			[{ tier: "medium", aiReview: true }, "merge"],
			[{ state: "MERGED", tier: "medium", aiReview: true }, "done"],
		];
		for (const [change, action] of steps) assert.equal(decidePr(pr(change)).action, action, JSON.stringify(change));
	});
});
