import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePriority, priorityOf, queueOrder, STALE_IN_FLIGHT_MS, takeTurn } from "../src/queue.ts";
import { resolveLoopSpec, newLoop, applyLoopSettings } from "../src/ops.ts";

const NOW = 1_000_000_000;
const loop = (id: string, extra: Record<string, unknown> = {}) => ({ id, status: "active", ...extra });
const turn = (me: ReturnType<typeof loop>, loops: ReturnType<typeof loop>[], extra: Partial<Parameters<typeof takeTurn>[0]> = {}) =>
	takeTurn({ loop: me, loops: [me, ...loops], now: NOW, maxConcurrent: 2, hourSpend: 0, ...extra });

describe("priority", () => {
	it("defaults by kind: requests and the budget check first, maintenance last", () => {
		assert.equal(priorityOf({ kind: "request" }), 2);
		assert.equal(priorityOf({ kind: "budget-review" }), 2);
		assert.equal(priorityOf({ kind: "business-review" }), 4);
		assert.equal(priorityOf({}), 3);
		assert.equal(priorityOf({ kind: "design" }), 3);
		assert.equal(priorityOf({ kind: "ci-health" }), 4);
		assert.equal(priorityOf({ kind: "ci-health", priority: 1 }), 1, "an explicit priority wins");
		assert.equal(priorityOf({ priority: 9 }), 3, "an out-of-range one is ignored");
	});
	it("parses numbers and names", () => {
		assert.equal(parsePriority("1"), 1);
		assert.equal(parsePriority(4), 4);
		assert.equal(parsePriority("High"), 2);
		assert.equal(parsePriority("idle"), 5);
		assert.equal(parsePriority("7"), undefined);
		assert.equal(parsePriority("soon"), undefined);
	});
});

describe("takeTurn", () => {
	it("starts when a slot is free and nobody is ahead", () => {
		assert.deepEqual(turn(loop("L1"), [loop("L2", { inFlightSince: NOW - 1000 })]), { start: true });
	});
	it("waits when every slot is busy", () => {
		const t = turn(loop("L1"), [loop("L2", { inFlightSince: NOW - 1 }), loop("L3", { inFlightSince: NOW - 1 })]);
		assert.equal(t.start, false);
		assert.match((t as { reason: string }).reason, /2 of 2 slots busy \(L2, L3\)/);
	});
	it("ignores in-flight marks left by a crash, and paused loops", () => {
		const stale = loop("L2", { inFlightSince: NOW - STALE_IN_FLIGHT_MS - 1 });
		const paused = { ...loop("L3", { inFlightSince: NOW - 1 }), status: "paused" };
		assert.deepEqual(turn(loop("L1"), [stale, paused], { maxConcurrent: 1 }), { start: true });
	});
	it("lets a higher-priority waiting loop go first when slots are short", () => {
		const waiting = loop("L2", { priority: 1, waitingSince: NOW - 60_000 });
		const t = turn(loop("L1", { priority: 3 }), [waiting, loop("L3", { inFlightSince: NOW - 1 })]);
		assert.equal(t.start, false);
		assert.match((t as { reason: string }).reason, /queued behind L2 \(priority 1\)/);
		assert.deepEqual(turn(waiting, [loop("L1", { priority: 3, waitingSince: NOW - 120_000 }), loop("L3", { inFlightSince: NOW - 1 })]), { start: true }, "the urgent one takes the slot");
	});
	it("at equal priority, whoever waited longest goes first", () => {
		const early = loop("L2", { waitingSince: NOW - 600_000 });
		assert.equal(turn(loop("L1", { waitingSince: NOW - 60_000 }), [early], { maxConcurrent: 1 }).start, false);
		assert.equal(turn(early, [loop("L1", { waitingSince: NOW - 60_000 })], { maxConcurrent: 1 }).start, true);
	});
	it("with two free slots, the second in line also goes", () => {
		assert.equal(turn(loop("L1", { waitingSince: NOW - 1 }), [loop("L2", { priority: 1, waitingSince: NOW - 9 })]).start, true);
	});
	it("paces: waits while the last hour used the allowance", () => {
		const t = turn(loop("L1"), [], { hourSpend: 1.8, hourAllowance: 1.67 });
		assert.equal(t.start, false);
		assert.match((t as { reason: string }).reason, /pacing, \$1\.80 spent in the last hour \(allowance \$1\.67\)/);
		assert.equal(turn(loop("L1"), [], { hourSpend: 1.2, hourAllowance: 1.67 }).start, true);
	});
	it("no limit and no pacing: always starts unless someone is ahead", () => {
		assert.equal(turn(loop("L1"), [loop("L2", { inFlightSince: NOW }), loop("L3", { inFlightSince: NOW })], { maxConcurrent: 0 }).start, true);
	});
});

describe("queueOrder", () => {
	it("lists running, then waiting by turn, then scheduled by priority", () => {
		const order = queueOrder(
			[
				loop("L1", { nextRunAt: NOW + 5 }),
				loop("L2", { inFlightSince: NOW - 1 }),
				loop("L3", { waitingSince: NOW - 10, priority: 4 }),
				loop("L4", { waitingSince: NOW - 5, priority: 1 }),
				loop("L5", { kind: "request", nextRunAt: NOW + 9 }),
				{ ...loop("L6"), status: "paused" },
			],
			NOW,
		);
		assert.deepEqual(order.map((entry) => `${entry.loop.id}:${entry.state}`), ["L2:running", "L4:waiting", "L3:waiting", "L5:scheduled", "L1:scheduled"]);
	});
});

describe("owner requests", () => {
	it("become a bounded, high-priority request loop", () => {
		const spec = resolveLoopSpec({ session: "s", request: "add a dark mode toggle" });
		assert.equal(spec.kind, "request");
		assert.equal(spec.priority, 2);
		assert.equal(spec.maxIterations, 5);
		assert.match(spec.goal, /^Owner request .*: add a dark mode toggle/);
		assert.match(spec.goal, /status "done"/);
		const made = newLoop({ id: "L9", session: "s", spec, defaults: { defaultBudgetUsd: 100, defaultIntervalMinutes: 10, defaultMaxIterations: 17520 }, costAtStart: 0, now: NOW });
		assert.equal(made.kind, "request");
		assert.equal(made.priority, 2);
		assert.equal(made.budgetUsd, 5);
	});
	it("take a named priority, and refuse a bad one", () => {
		assert.equal(resolveLoopSpec({ request: "x", priority: "urgent" }).priority, 1);
		assert.throws(() => resolveLoopSpec({ request: "x", priority: "asap" }), /priority is 1-5/);
		assert.throws(() => resolveLoopSpec({ request: "x", goal: "y" }), /no goal or preset/);
	});
	it("pd loop set --priority changes a loop's turn", () => {
		const target = { priority: undefined } as never as Parameters<typeof applyLoopSettings>[0];
		applyLoopSettings(target, { priority: "low" });
		assert.equal(target.priority, 4);
	});
});
