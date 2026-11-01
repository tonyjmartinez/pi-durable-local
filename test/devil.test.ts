import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildEvidence, DEVIL_LENSES, DEVILS_ADVOCATE_PROMPT, EVIDENCE_MAX_CHARS } from "../src/devil.ts";
import { LOOP_PROMPTS, LOOP_SCHEDULE, shouldWake } from "../src/loopgate.ts";

const NOW = Date.parse("2026-10-31T12:00:00Z");
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const loop = { id: "L1", session: "succulents", kind: "goal", status: "active", iteration: 4, maxIterations: 100, intervalMinutes: 10, spent: 2.5, budgetUsd: 10, note: "shipped #12" };

describe("buildEvidence", () => {
	it("lists live loops, counts recent events and quotes the notable ones", () => {
		const text = buildEvidence({
			now: NOW,
			loops: [loop, { ...loop, id: "L0", status: "done" }],
			audit: [
				{ at: at(1), event: "parked", repo: "o/r", pr: 7, reason: "weakens tests" },
				{ at: at(2), event: "loop_skip", loop: "L1", reason: "session already busy" },
				{ at: at(3), event: "loop_report", loop: "L1", note: "nothing to do", ...{ status: "idle" } },
				{ at: at(100), event: "parked", repo: "o/r", pr: 1, reason: "too old to count" },
			],
			chat: [{ at: at(1), from: "claude-a", to: "all", text: "taking src/x.ts" }],
		});
		assert.match(text, /LOOPS \(1 active or paused of 2\)/);
		assert.match(text, /L1 succulents goal active iter 4\/100 every 10m \$2\.50\/\$10 \| shipped #12/);
		assert.match(text, /AUDIT LAST 72H \(3 events\)/);
		assert.match(text, /parked o\/r#7: weakens tests/);
		assert.match(text, /1x "session already busy"/);
		assert.match(text, /Loop reports by status: idle 1/);
		assert.match(text, /claude-a -> all: taking src\/x\.ts/);
		assert.doesNotMatch(text, /too old to count/);
	});

	it("skips garbled audit rows and redacts secrets", () => {
		const text = buildEvidence({ now: NOW, loops: [], audit: [{ event: "parked" } as never, { at: at(1), event: "blocked", reason: "token ghp_abcdefghijklmnopqrstuvwxyz123456" }], chat: [] });
		assert.match(text, /\(1 events\)/);
		assert.doesNotMatch(text, /ghp_/);
	});

	it("leads with the day's spend inside and outside loops when given", () => {
		const text = buildEvidence({ now: NOW, loops: [loop], audit: [], chat: [], spend: { capUsd: 10, allSessionsUsd: 14, loopsUsd: 9, byLoop: { L1: 6, L2: 3 } } });
		assert.match(text, /^SPEND LAST 24H: all pi sessions \$14\.00 \(loops \$9\.00, outside loops \$5\.00\) of a \$10 daily cap/);
		assert.match(text, /By loop: L1 \$6\.00, L2 \$3\.00/);
	});

	it("stays bounded", () => {
		const audit = Array.from({ length: 3000 }, (_, i) => ({ at: at(1), event: "parked", repo: "o/r", pr: i, reason: "x".repeat(300) }));
		const chat = Array.from({ length: 50 }, () => ({ at: at(1), from: "a", to: "all", text: "y".repeat(4000) }));
		assert.ok(buildEvidence({ now: NOW, loops: Array.from({ length: 200 }, (_, i) => ({ ...loop, id: `L${i}`, note: "z".repeat(500) })), audit, chat }).length <= EVIDENCE_MAX_CHARS);
	});
});

describe("devils-advocate preset", () => {
	it("is registered with its own kind, a 6h interval and a small budget", () => {
		assert.equal(LOOP_PROMPTS["devils-advocate"], DEVILS_ADVOCATE_PROMPT);
		assert.deepEqual(LOOP_SCHEDULE["devils-advocate"], { kind: "devils-advocate", intervalMinutes: 360, budgetUsd: 3 });
	});

	it("names every lens, forbids PRs and personal insults", () => {
		for (const lens of DEVIL_LENSES) assert.ok(DEVILS_ADVOCATE_PROMPT.includes(lens));
		assert.match(DEVILS_ADVOCATE_PROMPT, /do not open PRs/);
		assert.match(DEVILS_ADVOCATE_PROMPT, /never insult a person/);
		assert.match(DEVILS_ADVOCATE_PROMPT, /factory_evidence/);
	});

	it("wakes like a goal loop but yields to product work past 70% of the daily cap", () => {
		const repo = { baseHeadSha: "b", baseHeadCommittedAt: NOW - 3_600_000, openAgentPrs: [], openFrictionIssues: 0 };
		const loopState = { kind: "devils-advocate" as const, iteration: 2, lastRunAt: NOW - 7 * 3_600_000 };
		assert.equal(shouldWake({ loop: loopState, repo, now: NOW }).wake, true);
		assert.equal(shouldWake({ loop: loopState, repo: { ...repo, dailySpendShare: 0.8 }, now: NOW }).wake, false);
	});
});

describe("budget-review preset", () => {
	it("is its own kind, every 4h, and wakes on schedule even when dormant or near the cap", () => {
		assert.equal(LOOP_SCHEDULE["budget-review"].kind, "budget-review");
		assert.equal(LOOP_SCHEDULE["budget-review"].intervalMinutes, 240);
		assert.match(LOOP_PROMPTS["budget-review"], /factory_evidence/);
		const repo = { openAgentPrs: [], openFrictionIssues: 0, baseHeadSha: "abc", baseHeadCommittedAt: NOW, dailySpendShare: 0.95 } as never;
		const loop = { kind: "budget-review" as const, iteration: 3, lastRunAt: NOW - 1000, dormant: { fingerprint: "x", since: 0 } };
		assert.equal(shouldWake({ loop, repo, now: NOW }).wake, true);
	});
});

describe("business-review preset", () => {
	const mk = (share?: number) => ({ openAgentPrs: [], openFrictionIssues: 0, baseHeadSha: "abc", baseHeadCommittedAt: NOW, dailySpendShare: share }) as never;
	it("is daily, $3, with a prompt that reads factory_evidence and forbids outward action", () => {
		assert.deepEqual(LOOP_SCHEDULE["business-review"], { kind: "business-review", intervalMinutes: 1440, budgetUsd: 3 });
		assert.match(LOOP_PROMPTS["business-review"], /factory_evidence/);
		assert.match(LOOP_PROMPTS["business-review"], /Business: /);
	});
	it("wakes on schedule even when dormant, but is held back near the cap", () => {
		const loop = { kind: "business-review" as const, iteration: 3, lastRunAt: NOW - 1000, dormant: { fingerprint: "x", since: 0 } };
		assert.equal(shouldWake({ loop, repo: mk(0.1), now: NOW }).wake, true);
		assert.equal(shouldWake({ loop, repo: mk(0.95), now: NOW }).wake, false);
	});
	it("gates factory_evidence to business-review sessions", () => {
		const src = readFileSync(new URL("../src/extensions.ts", import.meta.url), "utf8");
		assert.match(src, /loop\.kind === "business-review"\) && loop\.status === "active"/);
	});
});
