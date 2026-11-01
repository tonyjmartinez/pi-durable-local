import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DAY_MS, dailyBudget, dailySpend, nextRoomAt, recordSpend, spendByLoop } from "../src/spend.ts";
import type { SpendEntry } from "../src/spend.ts";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const hoursAgo = (hours: number) => NOW - hours * 3_600_000;
const entry = (hours: number, usd: number): SpendEntry => ({ at: hoursAgo(hours), usd });
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

describe("dailySpend", () => {
	it("is zero for no loops, and for loops that have not spent", () => {
		assert.equal(dailySpend([], NOW), 0);
		assert.equal(dailySpend([{ id: "L1" }, { id: "L2", spendLog: [] }], NOW), 0);
	});

	it("adds every charge in the last 24 hours across all loops", () => {
		const loops = [{ id: "L1", spendLog: [entry(1, 0.5), entry(5, 0.25)] }, { id: "L2", spendLog: [entry(23, 1)] }];
		close(dailySpend(loops, NOW), 1.75);
	});

	it("leaves out charges at or beyond the edge of the window", () => {
		const loops = [{ spendLog: [entry(25, 9), entry(24, 8), entry(23.99, 1)] }];
		close(dailySpend(loops, NOW), 1);
	});

	it("takes the window as a parameter", () => {
		const loops = [{ spendLog: [entry(1, 1), entry(5, 2), entry(30, 4)] }];
		close(dailySpend(loops, NOW, 2 * 3_600_000), 1);
		close(dailySpend(loops, NOW, 48 * 3_600_000), 7);
	});

	it("counts a charge stamped slightly in the future (clock skew) rather than losing it", () => {
		close(dailySpend([{ spendLog: [{ at: NOW + 5_000, usd: 0.3 }] }], NOW), 0.3);
	});

	it("ignores malformed, zero and negative entries", () => {
		const log = [{ at: Number.NaN, usd: 1 }, { at: hoursAgo(1), usd: Number.NaN }, { at: hoursAgo(1), usd: -5 }, { at: hoursAgo(1), usd: 0 }, entry(1, 0.2)];
		close(dailySpend([{ spendLog: log }], NOW), 0.2);
	});

	it("does not change what it is given", () => {
		const log = [entry(1, 1)];
		const snapshot = JSON.stringify(log);
		dailySpend([{ spendLog: log }], NOW);
		assert.equal(JSON.stringify(log), snapshot);
	});
});

describe("recordSpend", () => {
	it("appends a charge and returns a new array", () => {
		const log = [entry(1, 0.5)];
		const next = recordSpend(log, 0.25, NOW);
		assert.deepEqual(next, [entry(1, 0.5), { at: NOW, usd: 0.25 }]);
		assert.equal(log.length, 1, "the old log is unchanged");
	});

	it("starts a log from nothing", () => {
		assert.deepEqual(recordSpend(undefined, 0.1, NOW), [{ at: NOW, usd: 0.1 }]);
	});

	it("drops charges older than two days, so the log stays small", () => {
		const next = recordSpend([entry(60, 9), entry(47, 1), entry(1, 2)], 0.5, NOW);
		assert.deepEqual(next.map((e) => e.usd), [1, 2, 0.5]);
		assert.deepEqual(recordSpend([entry(10, 1)], 0.5, NOW, 5 * 3_600_000).map((e) => e.usd), [0.5], "the keep time is a parameter");
	});

	it("records nothing for a zero, negative or non-numeric charge, but still prunes", () => {
		for (const usd of [0, -1, Number.NaN, Infinity * 0]) assert.deepEqual(recordSpend([entry(1, 1)], usd, NOW), [entry(1, 1)]);
		assert.deepEqual(recordSpend([entry(60, 1)], 0, NOW), []);
	});

	it("keeps a log that dailySpend reads back correctly", () => {
		let log: SpendEntry[] | undefined;
		for (let i = 0; i < 10; i++) log = recordSpend(log, 0.1, NOW - (10 - i) * 3_600_000);
		close(dailySpend([{ spendLog: log }], NOW), 1);
	});
});

describe("spendByLoop", () => {
	it("splits the day's spend by loop, leaving out loops that spent nothing", () => {
		const out = spendByLoop([{ id: "L1", spendLog: [entry(1, 0.5), entry(2, 0.5)] }, { id: "L2" }, { id: "L3", spendLog: [entry(30, 5)] }, { id: "L4", spendLog: [entry(3, 2)] }], NOW);
		assert.deepEqual(Object.keys(out).sort(), ["L1", "L4"]);
		close(out.L1!, 1);
		close(out.L4!, 2);
	});
});

describe("dailyBudget", () => {
	const loops = [{ id: "L1", spendLog: [entry(1, 1.5)] }, { id: "L2", spendLog: [entry(2, 1)] }];

	it("says how much is left under the cap", () => {
		const status = dailyBudget(loops, NOW, 5);
		close(status.spent, 2.5);
		close(status.remaining!, 2.5);
		assert.equal(status.exceeded, false);
	});

	it("is exceeded exactly at the cap, and over it", () => {
		assert.equal(dailyBudget(loops, NOW, 2.5).exceeded, true);
		assert.equal(dailyBudget(loops, NOW, 2.5).remaining, 0);
		assert.equal(dailyBudget(loops, NOW, 1).exceeded, true);
		assert.equal(dailyBudget(loops, NOW, 1).remaining, 0, "never negative");
	});

	it("has no cap when the budget is missing, zero, negative or not a number", () => {
		for (const cap of [undefined, 0, -3, Number.NaN, Infinity * 0]) {
			const status = dailyBudget(loops, NOW, cap);
			assert.equal(status.exceeded, false, String(cap));
			assert.equal(status.remaining, null);
			close(status.spent, 2.5);
		}
	});

	it("frees up as old charges age out of the day", () => {
		const aging = [{ spendLog: [entry(23.5, 4), entry(1, 0.5)] }];
		assert.equal(dailyBudget(aging, NOW, 4).exceeded, true);
		assert.equal(dailyBudget(aging, NOW + 3_600_000, 4).exceeded, false, "an hour later the 4 dollars are out of the window");
	});
});

describe("nextRoomAt", () => {
	it("is undefined while there is room", () => {
		assert.equal(nextRoomAt([{ spendLog: [entry(1, 1)] }], NOW, 5), undefined);
	});

	it("is when enough of the oldest charges have aged out to get back under the cap", () => {
		const loops = [{ spendLog: [entry(20, 1), entry(10, 1), entry(2, 1)] }];
		assert.equal(nextRoomAt(loops, NOW, 3), hoursAgo(20) + DAY_MS, "dropping the oldest charge frees the cap");
		assert.equal(nextRoomAt(loops, NOW, 2), hoursAgo(10) + DAY_MS, "two must age out to get under 2");
	});

	it("looks across loops", () => {
		const loops = [{ spendLog: [entry(22, 2)] }, { spendLog: [entry(3, 2)] }];
		assert.equal(nextRoomAt(loops, NOW, 4), hoursAgo(22) + DAY_MS);
	});

	it("is undefined when nothing has been spent", () => {
		assert.equal(nextRoomAt([], NOW, 1), undefined);
	});
});

describe("factory-wide spend from session totals", () => {
	const h = 60 * 60_000;
	it("samples at most every five minutes and keeps one baseline older than the window", async () => {
		const { recordTotal } = await import("../src/spend.ts");
		let s = recordTotal(undefined, 1, 0);
		s = recordTotal(s, 2, 60_000);
		assert.deepEqual(s, [{ at: 0, total: 1 }]);
		s = recordTotal(s, 2, h);
		s = recordTotal(s, 3, 3 * DAY_MS);
		s = recordTotal(s, 4, 3 * DAY_MS + h);
		assert.deepEqual(s.map((x) => x.total), [2, 3, 4], "very old samples go, but the newest old one stays as a baseline");
	});
	it("charges the change since the window started, loops or not", async () => {
		const { totalSpendInWindow } = await import("../src/spend.ts");
		const samples = [{ at: 0, total: 5 }, { at: 2 * h, total: 8 }, { at: 20 * h, total: 12 }];
		assert.equal(totalSpendInWindow(samples, 20, 25 * h), 15, "baseline is the newest sample at or before the window start (5 at 0h)");
		assert.equal(totalSpendInWindow(samples, 20, 27 * h), 12, "later, the 8 at 2h is the baseline");
		assert.equal(totalSpendInWindow(samples, 20, 10 * h), 15, "a young history uses the oldest sample");
		assert.equal(totalSpendInWindow(samples, 20, 25 * h, 19 * h), 8, "a reset (since) moves the baseline forward");
		assert.equal(totalSpendInWindow(samples, 1, 25 * h), 0, "never negative");
		assert.equal(totalSpendInWindow(undefined, 9, 0), 0);
	});
});
