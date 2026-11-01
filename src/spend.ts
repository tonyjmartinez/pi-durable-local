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

/** One sample of every session's lifetime cost added up. */
export type TotalSample = { at: number; total: number };

/**
 * The samples with one more, unless the last one is under `minGapMs` old. Drops samples older than `keepMs` but keeps
 * the newest of those, so a full window always has a baseline. Returns a new array.
 */
export function recordTotal(samples: readonly TotalSample[] | undefined, total: number, now: number, minGapMs = 5 * 60_000, keepMs = 2 * DAY_MS): TotalSample[] {
	const valid = (samples ?? []).filter((s) => Number.isFinite(s.at) && Number.isFinite(s.total));
	const last = valid[valid.length - 1];
	const next = !Number.isFinite(total) || (last !== undefined && now - last.at < minGapMs) ? valid : [...valid, { at: now, total }];
	const old = next.filter((s) => s.at <= now - keepMs);
	return [...old.slice(-1), ...next.filter((s) => s.at > now - keepMs)];
}

/**
 * Everything all sessions spent in the window, loops or not: the total now minus the total at the window's start
 * (the newest sample at or before it). Without a sample that old, the oldest one at or after `since` is the baseline,
 * which undercounts until a day of samples exists. Never negative (a deleted session lowers the total).
 */
export function totalSpendInWindow(samples: readonly TotalSample[] | undefined, total: number, now: number, since = 0, windowMs = DAY_MS): number {
	const start = Math.max(now - windowMs, since);
	const valid = (samples ?? []).filter((s) => Number.isFinite(s.at) && Number.isFinite(s.total)).sort((a, b) => a.at - b.at);
	const before = valid.filter((s) => s.at <= start);
	const baseline = start === since && since > now - windowMs
		? valid.find((s) => s.at >= since)
		: before[before.length - 1] ?? valid.find((s) => s.at >= since);
	if (baseline === undefined || !Number.isFinite(total)) return 0;
	return Math.max(0, total - baseline.total);
}

/** The factory's budget at a glance: the rolling day against the cap, and the pacing window against its allowance. */
export type BudgetStatus = {
	capUsd: number;
	/** Last 24h, all pi sessions (the larger of loop charges and session-total samples), counted from `since`. */
	daySpend: number;
	/** Loop charges alone over the same day, which age out on a known schedule. */
	loopDaySpend: number;
	exceeded: boolean;
	/** Undefined when pacing is off or there is no cap. */
	pace?: { windowHours: number; spent: number; allowance: number };
};

export function budgetStatus(input: {
	loops: readonly SpendingLoop[];
	samples?: readonly TotalSample[];
	now: number;
	capUsd: number;
	since?: number;
	pace?: boolean;
	paceBurst?: number;
	paceWindowHours?: number;
}): BudgetStatus {
	const since = Number.isFinite(input.since) ? input.since! : 0;
	const loops = input.loops.map((loop) => ({ ...loop, spendLog: loop.spendLog?.filter((entry) => entry.at >= since) }));
	const latest = input.samples?.[input.samples.length - 1];
	const spentIn = (windowMs: number) =>
		Math.max(dailySpend(loops, input.now, windowMs), latest === undefined ? 0 : totalSpendInWindow(input.samples, latest.total, input.now, since, windowMs));
	const capped = Number.isFinite(input.capUsd) && input.capUsd > 0;
	const daySpend = spentIn(DAY_MS);
	const status: BudgetStatus = { capUsd: input.capUsd, daySpend, loopDaySpend: dailySpend(loops, input.now), exceeded: capped && daySpend >= input.capUsd };
	if (input.pace && capped) {
		const windowHours = Number.isFinite(input.paceWindowHours) && input.paceWindowHours! > 0 ? Math.min(input.paceWindowHours!, 24) : 3;
		const burst = Number.isFinite(input.paceBurst) && input.paceBurst! > 0 ? input.paceBurst! : 2;
		status.pace = { windowHours, spent: spentIn(windowHours * 60 * 60_000), allowance: (input.capUsd / 24) * windowHours * burst };
	}
	return status;
}
