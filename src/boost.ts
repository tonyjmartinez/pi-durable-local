// Budget boosts: a general's audited, temporary raise of the factory's daily cap.
//
// The daily cap (`loops.dailyBudgetUsd`) limits only what pi spends on the Claude API. Generals (Claude Code and Codex)
// run on their own app plans and are never limited by it. When pi work cannot wait for the rolling window to make room,
// a general can lend the factory extra headroom: `pd budget boost <usd> --by <name> --reason "..."`. Each boost lasts a
// few hours, is written to policy.json (so the daemon, sends and loops all see it), and is audited.

export type Boost = { usd: number; at: number; until: number; by: string; reason: string };

/** Largest single boost, so a typo cannot open the floodgates. */
export const MAX_BOOST_USD = 50;
export const DEFAULT_BOOST_HOURS = 24;
export const MAX_BOOST_HOURS = 48;

function valid(boost: Partial<Boost> | undefined): boost is Boost {
	return boost !== undefined && Number.isFinite(boost.usd) && boost.usd! > 0 && Number.isFinite(boost.until);
}

/** Boosts that still count at `now`. */
export function activeBoosts(boosts: readonly Partial<Boost>[] | undefined, now: number): Boost[] {
	return (boosts ?? []).filter(valid).filter((boost) => boost.until > now);
}

/** The cap in force: the base plus every active boost. A missing, zero or negative base means no cap, and stays so. */
export function effectiveCap(baseUsd: number, boosts: readonly Partial<Boost>[] | undefined, now: number): number {
	if (!Number.isFinite(baseUsd) || baseUsd <= 0) return baseUsd;
	return baseUsd + activeBoosts(boosts, now).reduce((sum, boost) => sum + boost.usd, 0);
}

/** The cap in force for a loaded policy. Every place that compares spend to the daily cap goes through this. */
export function dailyCapUsd(policy: { loops: { dailyBudgetUsd: number; boosts?: Partial<Boost>[] } }, now = Date.now()): number {
	return effectiveCap(policy.loops.dailyBudgetUsd, policy.loops.boosts, now);
}

/** Checks a boost request; throws with a message a general can act on. */
export function parseBoost(input: { usd?: unknown; hours?: unknown; by?: unknown; reason?: unknown }, now: number): Boost {
	const usd = Number(input.usd);
	if (!Number.isFinite(usd) || usd <= 0 || usd > MAX_BOOST_USD) throw new Error(`boost must be more than $0 and at most $${MAX_BOOST_USD}`);
	const hours = input.hours === undefined ? DEFAULT_BOOST_HOURS : Number(input.hours);
	if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_BOOST_HOURS) throw new Error(`--hours must be more than 0 and at most ${MAX_BOOST_HOURS}`);
	const by = typeof input.by === "string" ? input.by.trim() : "";
	if (!by) throw new Error("--by <general name> is required, so the audit log says who raised the cap");
	const reason = typeof input.reason === "string" ? input.reason.trim() : "";
	if (!reason) throw new Error('--reason "..." is required: what work cannot wait for the cap');
	return { usd: Math.round(usd * 100) / 100, at: now, until: now + hours * 60 * 60_000, by: by.slice(0, 60), reason: reason.slice(0, 300) };
}

/** Policy JSON with the boost added and expired boosts dropped. Returns a new object. */
export function withBoost<T extends { loops?: { boosts?: Partial<Boost>[] } & Record<string, unknown> }>(policy: T, boost: Boost, now: number): T {
	return { ...policy, loops: { ...policy.loops, boosts: [...activeBoosts(policy.loops?.boosts, now), boost] } };
}

/** "$5 by claude-general until 14:00Z (curb-cut v1.1)", for briefs and status. */
export function describeBoost(boost: Boost): string {
	return `$${boost.usd} by ${boost.by} until ${new Date(boost.until).toISOString().slice(11, 16)}Z (${boost.reason.slice(0, 60)})`;
}
