import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cutRefusal, type LoopResult, loopResults, parseInterests, recentCutCount, resultsLines } from "../src/cut.ts";

const H = 3_600_000;
const now = Date.parse("2026-11-02T00:00:00Z");
const interests = parseInterests([
	{ repo: "t/succulents.info", focus: "website" },
	{ repo: "t/stillfocus", focus: "Flutter app" },
	"t/tonyjmartinez",
	{ repo: "t/tonezone-survivor", focus: "Flutter app" },
	42,
]);

const row = (over: Partial<LoopResult>): LoopResult => ({ id: "L1", session: "s", kind: "goal", status: "active", spentUsd: 1, merged: 0, ageHours: 100, ...over });
const refuse = (target: LoopResult | undefined, over: { priority?: number; offFocus?: boolean; recentCuts?: number } = {}) =>
	cutRefusal({ target, ...(over.priority === undefined ? {} : { targetPriority: over.priority }), callerSession: "budget-review", offFocus: over.offFocus ?? false, recentCuts: over.recentCuts ?? 0 });

describe("interests", () => {
	it("parses strings and { repo, focus }, drops junk, keeps rank order", () => {
		assert.deepEqual(interests.map((i) => i.repo), ["t/succulents.info", "t/stillfocus", "t/tonyjmartinez", "t/tonezone-survivor"]);
		assert.equal(interests[1]!.focus, "Flutter app");
		assert.deepEqual(parseInterests(undefined), []);
	});
});

describe("loopResults", () => {
	it("counts spend and per-session merges in the window, ranked by interest", () => {
		const rows = loopResults({
			loops: [
				{ id: "L1", session: "succ", status: "active", createdAt: now - 50 * H, spendLog: [{ at: now - H, usd: 1 }, { at: now - 60 * H, usd: 9 }] },
				{ id: "L2", session: "curb", status: "active", spendLog: [{ at: now - H, usd: 2 }] },
				{ id: "L3", session: "old", status: "done", spendLog: [{ at: now - H, usd: 5 }] },
			],
			repoOf: (s) => ({ succ: "t/succulents.info", curb: "t/curb-cut" })[s],
			audit: [
				{ at: new Date(now - 2 * H).toISOString(), event: "merged", session: "succ" },
				{ at: new Date(now - 3 * H).toISOString(), event: "merged", session: "succ" },
				{ at: new Date(now - 70 * H).toISOString(), event: "merged", session: "curb" },
			],
			interests,
			now,
		});
		assert.deepEqual(rows.map((r) => [r.id, r.rank, r.spentUsd, r.merged]), [["L1", 1, 1, 2], ["L2", undefined, 2, 0]]);
		const text = resultsLines(rows, interests).join("\n");
		assert.match(text, /1\. t\/succulents\.info \(website\)/);
		assert.match(text, /L2 curb .*NOT AN INTEREST: \$2\.00, 0 merged, NOTHING MERGED/);
		assert.match(text, /L1 succ .*#1: \$1\.00, 2 merged, \$0\.50\/merge/);
	});
});

describe("cutRefusal", () => {
	it("cuts a non-interest loop that spends without results", () => {
		assert.equal(refuse(row({ spentUsd: 2 })), undefined);
	});
	it("leaves loops that waste nothing", () => {
		assert.match(refuse(row({ spentUsd: 0.1 }))!, /not wasting money/);
	});
	it("protects the top interest unless stalled", () => {
		assert.match(refuse(row({ rank: 1, merged: 3 }))!, /top interest/);
		assert.match(refuse(row({ rank: 1, merged: 3 }), { offFocus: true })!, /top interest/);
		assert.equal(refuse(row({ rank: 1, merged: 0, spentUsd: 0.8 })), undefined);
	});
	it("cuts a producing interest loop only when off focus", () => {
		assert.match(refuse(row({ rank: 4, merged: 2 }))!, /offFocus/);
		assert.equal(refuse(row({ rank: 4, merged: 2 }), { offFocus: true }), undefined);
	});
	it("never cuts urgent, new, paused, its own, or watchdog loops, nor past the rate limit", () => {
		assert.match(refuse(row({}), { priority: 1 })!, /urgent/);
		assert.match(refuse(row({ ageHours: 3 }))!, /old/);
		assert.match(refuse(row({ status: "paused" }))!, /only active/);
		assert.match(refuse(row({ session: "budget-review" }))!, /own loop/);
		assert.match(refuse(row({ kind: "assistant" }))!, /never cut/);
		assert.match(refuse(row({}), { recentCuts: 3 })!, /already 3 cuts/);
		assert.match(refuse(undefined)!, /no such loop/);
	});
	it("counts recent cuts from the audit log", () => {
		const audit = [
			{ at: new Date(now - H).toISOString(), event: "loop_cut" },
			{ at: new Date(now - 5 * H).toISOString(), event: "loop_cut" },
			{ at: new Date(now - H).toISOString(), event: "loop_pause" },
		];
		assert.equal(recentCutCount(audit, now), 1);
	});
});
