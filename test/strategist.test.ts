import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countUnchecked, nextLens, PRODUCT_STRATEGIST_PROMPT, STRATEGIST_LENSES, strategistWake } from "../src/strategist.ts";
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
	const base = { newMerges: false, productLoopIdle: false };
	it("wakes on the first run", () => assert.equal(strategistWake(base).wake, true));
	it("wakes immediately when the product loop is starving, even inside 6h", () => {
		assert.equal(strategistWake({ ...base, hoursSinceLastRun: 1, productLoopIdle: true }).wake, true);
	});
	it("runs at most once per 6h otherwise", () => {
		assert.equal(strategistWake({ ...base, hoursSinceLastRun: 2, proposalDue: true, roadmapUnclaimed: 0 }).wake, false);
	});
	it("wakes for a due proposal, a finished milestone or a thin roadmap", () => {
		assert.equal(strategistWake({ ...base, hoursSinceLastRun: 7, proposalDue: true }).wake, true);
		assert.equal(strategistWake({ ...base, hoursSinceLastRun: 7, milestoneDone: true }).wake, true);
		assert.match(strategistWake({ ...base, hoursSinceLastRun: 7, roadmapUnclaimed: 2 }).reason, /2 unclaimed/);
		assert.equal(strategistWake({ ...base, hoursSinceLastRun: 7, roadmapUnclaimed: 3 }).wake, false);
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
		assert.equal(shouldWake({ loop, repo: { ...repo, strategist: { productLoopIdle: true } }, now }).wake, true);
	});
});
