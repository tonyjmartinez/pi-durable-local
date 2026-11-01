import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countUnchecked, lensPrompt, nextLens, proposalDue, recordLens, PRODUCT_STRATEGIST_PROMPT, STRATEGIST_LENSES, strategistWake } from "../src/strategist.ts";
import { LOOP_PROMPTS, LOOP_SCHEDULE, shouldWake } from "../src/loopgate.ts";

describe("nextLens", () => {
	it("starts at the first, rotates, and skips the last three", () => {
		assert.equal(nextLens([]), 0);
		assert.equal(nextLens([0]), 1);
		assert.equal(nextLens([8]), 0);
		const seen: number[] = [];
		for (let i = 0; i < 30; i++) {
			const next = nextLens(seen);
			assert.ok(!seen.slice(-3).includes(next));
			seen.push(next);
		}
	});
	it("has nine lenses", () => assert.equal(STRATEGIST_LENSES.length, 9));
});

describe("countUnchecked", () => {
	it("counts open checklist items only", () => {
		assert.equal(countUnchecked("# R\n- [x] done\n- [ ] one\n  * [ ] two\n- [ ]\nplain"), 2);
	});
});

describe("strategistWake", () => {
	const base = { newMerges: false, };
	it("wakes on the first run", () => assert.equal(strategistWake(base).wake, true));
	it("wakes immediately when the product loop is starving, even inside 6h", () => {
		assert.equal(strategistWake({ ...base, hoursSinceLastRun: 1, lastRunAt: 1000, productIdleSince: 2000 }).wake, true);
	});
	it("does not re-wake for a builder that has been dormant since before the last run", () => {
		assert.equal(strategistWake({ ...base, hoursSinceLastRun: 2, lastRunAt: 5000, productIdleSince: 1000 }).wake, false);
	});
	it("runs at most once per 6h otherwise", () => {
		assert.equal(strategistWake({ ...base, hoursSinceLastRun: 2, proposalDue: true, roadmapUnclaimed: 0 }).wake, false);
	});
	it("wakes for a due proposal, or a thin roadmap", () => {
		assert.equal(strategistWake({ ...base, hoursSinceLastRun: 7, proposalDue: true }).wake, true);
		assert.match(strategistWake({ ...base, hoursSinceLastRun: 7, roadmapUnclaimed: 2 }).reason, /2 unclaimed/);
	});
	it("wakes after 24h only with new merges", () => {
		assert.equal(strategistWake({ ...base, hoursSinceLastRun: 25 }).wake, false);
		assert.equal(strategistWake({ ...base, hoursSinceLastRun: 25, newMerges: true }).wake, true);
	});
});

describe("strategy loop kind", () => {
	const repo = { baseHeadSha: "a", baseHeadCommittedAt: 1, openAgentPrs: [], openFrictionIssues: 0 };
	it("is wired as a preset with its own kind", () => {
		assert.equal(LOOP_SCHEDULE["product-strategist"].kind, "strategy");
		assert.equal(LOOP_PROMPTS["product-strategist"], PRODUCT_STRATEGIST_PROMPT);
	});
	it("shouldWake uses the strategist rule and the starving signal", () => {
		const now = 10 * 3_600_000;
		const loop = { kind: "strategy" as const, iteration: 1, lastRunAt: now - 3_600_000 };
		assert.equal(shouldWake({ loop, repo, now }).wake, false);
		assert.equal(shouldWake({ loop, repo: { ...repo, strategist: { productIdleSince: now } }, now }).wake, true);
	});
});

describe("proposalDue", () => {
	const now = Date.parse("2026-11-02T12:00:00Z");
	it("is true when any Default by has passed", () => {
		assert.equal(proposalDue(["x\nDefault by: 2026-11-01T12:00:00Z"], now), true);
		assert.equal(proposalDue(["**Default by:** 2026-11-03T12:00:00Z", "none here"], now), false);
		assert.equal(proposalDue(["Default by: someday"], now), false);
	});
});

describe("lens rotation", () => {
	it("injects the next lens and records the one used", () => {
		assert.match(lensPrompt([]), /Lens for this run: 1\. persona/);
		assert.match(lensPrompt([0]), /Lens for this run: 2\. genre/);
		assert.deepEqual(recordLens([0, 1, 2], undefined), [0, 1, 2, 3].slice(-3));
		assert.deepEqual(recordLens([0], 5), [0, 4]);
		assert.deepEqual(recordLens([0], 99), [0, 1]);
	});
});

describe("spikes", () => {
	it("the strategist prompt allows one draft spike per repo on pd/spike-<slug>", () => {
		assert.match(PRODUCT_STRATEGIST_PROMPT, /pd\/spike-<slug>/);
		assert.match(PRODUCT_STRATEGIST_PROMPT, /DRAFT PR/);
		assert.match(PRODUCT_STRATEGIST_PROMPT, /At most ONE open spike per repo/);
		assert.match(PRODUCT_STRATEGIST_PROMPT, /close the spike PR/);
	});
});
