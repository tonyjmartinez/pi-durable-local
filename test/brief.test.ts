import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type AuditEntry, buildBrief, openParks } from "../src/brief.ts";

const park = (pr: number, sha: string, at = "2026-10-30T00:00:00Z"): AuditEntry => ({ at, event: "parked", repo: "o/r", pr, sha, reason: "Risk tier high needs human approval.", details: ["review: approved (looks right)"] });
const now = Date.parse("2026-10-31T00:00:00Z");
const base = { now, sessions: [], loops: [], audit: [], openPrs: new Set<string>(), decisions: [] };

describe("openParks", () => {
	it("keeps the latest park of an open PR, with its review", () => {
		const parks = openParks([park(1, "aaaaaaa"), park(1, "bbbbbbb")], new Set(["o/r#1"]));
		assert.equal(parks.length, 1);
		assert.equal(parks[0]!.sha, "bbbbbbb");
		assert.equal(parks[0]!.review, "approved (looks right)");
	});

	it("drops a PR once it is merged, closed, or approved at the parked head", () => {
		const audit: AuditEntry[] = [park(1, "aaaaaaa"), { at: "x", event: "merged", repo: "o/r", pr: 1 }, park(2, "ccccccc"), park(3, "ddddddd"), { at: "x", event: "human_approved", repo: "o/r", pr: 3, sha: "ddddddd" }];
		assert.deepEqual(openParks(audit, new Set(["o/r#1", "o/r#3"])), []);
	});

	it("keeps it when the approval was for an older head", () => {
		const audit: AuditEntry[] = [park(1, "aaaaaaa"), { at: "x", event: "human_approved", repo: "o/r", pr: 1, sha: "aaaaaaa" }, park(1, "bbbbbbb")];
		assert.equal(openParks(audit, new Set(["o/r#1"])).length, 1);
	});
});

describe("buildBrief", () => {
	it("says so when nothing needs a general", () => {
		assert.match(buildBrief(base), /^NEEDS A GENERAL: nothing/);
	});

	it("puts parked PRs, stuck loops and decisions first, with the command to act", () => {
		const out = buildBrief({
			...base,
			audit: [park(80, "7992b30")],
			openPrs: new Set(["o/r#80"]),
			loops: [{ id: "L6", session: "s", status: "paused", goal: "g", note: "blocked: no tool", budgetUsd: 1, iteration: 1 }],
			decisions: [{ repo: "o/r", number: 4, title: "Pick a browser" }],
		});
		assert.match(out, /^NEEDS A GENERAL \(3\)/);
		assert.match(out, /pd approve o\/r 80 7992b30/);
		assert.match(out, /pd loop resume L6/);
		assert.match(out, /decision o\/r#4: Pick a browser/);
	});

	it("counts merges in the last day and lists working and dormant loops", () => {
		const out = buildBrief({
			...base,
			audit: [{ at: "2026-10-30T12:00:00Z", event: "merged", repo: "o/r", pr: 9 }, { at: "2026-10-01T00:00:00Z", event: "merged", repo: "o/r", pr: 1 }],
			loops: [
				{ id: "L1", session: "a", status: "active", goal: "g", note: "slice 2 merged", spent: 0.5, budgetUsd: 100, iteration: 3 },
				{ id: "L2", session: "b", status: "active", dormant: true, goal: "g", budgetUsd: 1, iteration: 1 },
			],
			sessions: [{ name: "a", busy: true, model: "anthropic/claude-sonnet-5-5", cost: 1.5 }],
		});
		assert.match(out, /LAST 24H: 1 merged \(o\/r#9\)/);
		assert.match(out, /1 loops working, 1 dormant/);
		assert.match(out, /L2 b \(dormant\)/);
		assert.match(out, /Models in use: anthropic\/claude-sonnet-5-5/);
	});
});

describe("escalations", () => {
	const loop = (over: Record<string, unknown>) => ({ id: "L1", session: "s", status: "active", goal: "g", budgetUsd: 1, iteration: 1, ...over }) as Parameters<typeof buildBrief>[0]["loops"][number];
	const ask = { ask: "Need BALLDONTLIE_API_KEY", options: ["add key", "drop feature"], recommendation: "add key" };

	it("lists needsOwner of an active, dormant or paused loop", () => {
		const out = buildBrief({ ...base, loops: [loop({ id: "L1", needsOwner: ask }), loop({ id: "L2", dormant: true, needsOwner: ask }), loop({ id: "L3", status: "paused", note: "blocked", needsOwner: ask })] });
		assert.match(out, /NEEDS A GENERAL \(3\)/);
		assert.match(out, /loop L2 \(s, dormant, active\) asks: Need BALLDONTLIE_API_KEY/);
		assert.match(out, /options: add key \| drop feature/);
		assert.match(out, /recommendation: add key/);
	});

	it("drops loops the user paused, keeps system pauses and failures", () => {
		const out = buildBrief({ ...base, loops: [loop({ id: "L1", status: "paused", note: "paused by user" }), loop({ id: "L2", status: "paused", note: "budget hit" }), loop({ id: "L3", status: "failed", note: "boom" })] });
		assert.match(out, /NEEDS A GENERAL \(2\)/);
		assert.ok(!out.includes("L1"));
	});

	it("shows proposals with age and default-by, and not twice as decisions", () => {
		const out = buildBrief({
			...base,
			decisions: [{ repo: "o/r", number: 9, title: "Proposal: bold" }, { repo: "o/r", number: 4, title: "other" }],
			proposals: [{ repo: "o/r", number: 9, title: "Proposal: bold", createdAt: "2026-10-30T00:00:00Z", defaultBy: "2026-11-02T00:00:00Z" }],
		});
		assert.match(out, /PROPOSALS \(1\)\n- o\/r#9: Proposal: bold \(open 24h; adopts the recommendation by default at 2026-11-02/);
		assert.match(out, /NEEDS A GENERAL \(1\)/);
		assert.ok(!out.includes("decision o/r#9"));
	});
});
