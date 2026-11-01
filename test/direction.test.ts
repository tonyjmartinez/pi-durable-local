import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBrief } from "../src/brief.ts";
import { applyDirection, directionKey, directionPrompt, type DirectionState, needsPivot, pivotLines, pivotStale, prsPredating, recordAck } from "../src/direction.ts";

const loops = () => [{ id: "L1", nextTask: "old", status: "active", dormant: { fingerprint: "x" } }, { id: "L2", nextTask: "old2", status: "active" }];

test("applyDirection bumps version, keeps history, clears handoffs, wakes dormant", () => {
	const state: DirectionState = { byKey: {} };
	const ls = loops();
	const first = applyDirection(state, "o/r", { text: " go photos ", by: "opus", now: 1000 }, ls);
	assert.equal(first.direction.version, 1);
	assert.deepEqual(first.woken, ["L1"]);
	assert.ok(ls.every((l) => l.nextTask === undefined));
	assert.equal(first.direction.acks.L2!.status, "pending");
	const second = applyDirection(state, "o/r", { text: "again", by: "tony", now: 2000 }, ls);
	assert.equal(second.direction.version, 2);
	assert.deepEqual(second.direction.history.map((h) => h.text), ["go photos"]);
	assert.throws(() => applyDirection(state, "o/r", { text: " ", by: "x", now: 1 }, ls));
});

test("recordAck only for the current version", () => {
	const state: DirectionState = { byKey: {} };
	const { direction } = applyDirection(state, "o/r", { text: "t", by: "b", now: 1 }, loops());
	assert.equal(recordAck(direction, "L2", 0, 5), false);
	assert.equal(needsPivot(direction, "L2"), true);
	assert.equal(recordAck(direction, "L2", 1, 5), true);
	assert.equal(needsPivot(direction, "L2"), false);
	assert.equal(recordAck(undefined, "L2", 1, 5), false);
});

test("prompt and PR selection", () => {
	const { direction } = applyDirection({ byKey: {} }, "o/r", { text: "photo-led", by: "opus", now: 1000 }, loops());
	const old = prsPredating([{ number: 4, createdAt: 500 }, { number: 5, createdAt: 1500 }, { number: 6 }], direction);
	assert.deepEqual(old.map((p) => p.number), [4]);
	const text = directionPrompt(direction, "L1", old);
	assert.match(text, /Current direction v1 \(set by opus/);
	assert.match(text, /overrides the goal/);
	assert.match(text, /#4/);
	assert.equal(directionPrompt(undefined, "L1"), "");
	recordAck(direction, "L1", 1, 2000);
	assert.doesNotMatch(directionPrompt(direction, "L1", old), /just changed/);
	assert.equal(directionKey("s", undefined), "s");
});

test("stale loops and brief", () => {
	const { direction } = applyDirection({ byKey: {} }, "o/r", { text: "photo-led", by: "opus", now: 1000 }, loops());
	const pd = { key: "o/r", ...direction };
	const ls = [{ id: "L1", session: "a", status: "active", lastRunAt: 2000 }, { id: "L2", session: "b", status: "active", lastRunAt: 500 }];
	assert.equal(pivotStale(pd, ls, 3000).length, 1);
	assert.equal(pivotStale(pd, ls, 1000 + 3 * 3_600_000).length, 2);
	assert.equal(pivotLines([pd], ls, 1000 + 49 * 3_600_000).length, 0);
	assert.match(pivotLines([pd], ls, 3000).join("\n"), /L2 b: pending/);
	const brief = buildBrief({ now: 3000, sessions: [], loops: ls.map((l) => ({ ...l, goal: "g", budgetUsd: 1, iteration: 1 })), audit: [], openPrs: new Set(), decisions: [], directions: [pd] });
	assert.match(brief, /NEEDS A GENERAL \(1\)/);
	assert.match(brief, /PIVOTS/);
});
