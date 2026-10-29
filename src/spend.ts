// Spend over time, for a daily cap across all loops. A loop's `spent` is only a running total, so each iteration's
// charge is also written to a small time-stamped log on the loop (`spendLog`), which these pure functions read.

export const DAY_MS = 24 * 60 * 60 * 1000;

/** One iteration's charge to a loop. */
export type SpendEntry = { at: number; usd: number };

/** The part of a loop these functions read. */
export type SpendingLoop = { id?: string; spendLog?: readonly SpendEntry[] };

const valid = (entry: SpendEntry) => Number.isFinite(entry.at) && Number.isFinite(entry.usd) && entry.usd > 0;

/**
 * The log with one more charge, and anything older than `keepMs` (two days by default) dropped so it stays small.
 * Zero, negative and non-numeric charges are ignored. Returns a new array.
 */
export function recordSpend(log: readonly SpendEntry[] | undefined, usd: number, now: number, keepMs = 2 * DAY_MS): SpendEntry[] {
	const kept = (log ?? []).filter((entry) => valid(entry) && entry.at > now - keepMs);
	return Number.isFinite(usd) && usd > 0 ? [...kept, { at: now, usd }] : kept;
}

/** Everything the loops charged in the last `windowMs` (a day by default). */
export function dailySpend(loops: readonly SpendingLoop[], now: number, windowMs = DAY_MS): number {
	let total = 0;
	for (const loop of loops) {
		for (const entry of loop.spendLog ?? []) if (valid(entry) && entry.at > now - windowMs) total += entry.usd;
	}
	return total;
}

/** The same, per loop id, for showing where the day's money went. Loops that spent nothing are left out. */
export function spendByLoop(loops: readonly SpendingLoop[], now: number, windowMs = DAY_MS): Record<string, number> {
	const out: Record<string, number> = {};
	for (const loop of loops) {
		const spent = dailySpend([loop], now, windowMs);
		if (spent > 0 && loop.id !== undefined) out[loop.id] = spent;
	}
	return out;
}

export type DailyBudget = {
	spent: number;
	/** Null when there is no cap. */
	remaining: number | null;
	exceeded: boolean;
};

/** Where the loops stand against a daily cap. A missing, zero or negative cap means no cap. */
export function dailyBudget(loops: readonly SpendingLoop[], now: number, budgetUsd: number | undefined): DailyBudget {
	const spent = dailySpend(loops, now);
	if (budgetUsd === undefined || !Number.isFinite(budgetUsd) || budgetUsd <= 0) return { spent, remaining: null, exceeded: false };
	return { spent, remaining: Math.max(0, budgetUsd - spent), exceeded: spent >= budgetUsd };
}

/** When the cap will have room again: the moment the oldest charge still counted falls out of the window. */
export function nextRoomAt(loops: readonly SpendingLoop[], now: number, budgetUsd: number, windowMs = DAY_MS): number | undefined {
	const live = loops.flatMap((loop) => (loop.spendLog ?? []).filter((entry) => valid(entry) && entry.at > now - windowMs)).sort((a, b) => a.at - b.at);
	let spent = live.reduce((sum, entry) => sum + entry.usd, 0);
	if (spent < budgetUsd) return undefined;
	for (const entry of live) {
		spent -= entry.usd;
		if (spent < budgetUsd) return entry.at + windowMs;
	}
	return undefined;
}
