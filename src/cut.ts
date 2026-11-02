// Cutting waste: the budget reviewer may pause loops that spend money without producing results Tony cares about.
//
// Waste is spend without results. A loop "produces results" when the factory merged PRs from its session in the
// window; Tony ranks his interests in policy (`loops.ownerInterests`: repo plus what the focus is), and results on
// anything else count for little. A loop that costs nothing wastes nothing, so it is never cut, interest or not. The reviewer sees one row per live loop and may pause
// (never stop) loops through the `loop_cut` tool; every cut is audited, posted to the chat, and undone with
// `pd loop resume <id>`. The guard below is the hard limit; the prompt asks for judgement on top of it.

export type Interest = { repo: string; focus?: string };

export type CutLoop = {
	id: string;
	session: string;
	kind?: string;
	status: string;
	priority?: number;
	createdAt?: number;
	spendLog?: { at: number; usd: number }[];
};

export type LoopResult = {
	id: string;
	session: string;
	kind: string;
	status: string;
	repo?: string;
	/** 1 = Tony's top interest; undefined = not one of his interests. */
	rank?: number;
	spentUsd: number;
	merged: number;
	ageHours: number;
};

/** Hours of history a cut is judged on. */
export const CUT_WINDOW_HOURS = 48;
/** A loop younger than this has not had a fair chance yet. */
export const CUT_MIN_AGE_HOURS = 12;
/** Spend in the window below which a loop is not wasting enough to cut. */
export const CUT_MIN_SPEND_USD = 0.25;
/** Spend with no merge at all that makes even an interest loop stalled. */
export const STALLED_SPEND_USD = 0.5;
/** Cuts allowed per rolling window, so one bad run cannot gut the factory. */
export const MAX_CUTS = 3;
export const MAX_CUTS_WINDOW_HOURS = 4;
/** Kinds that keep the factory honest and cheap, or that never merge by design (their output is issues, reviews or
 * CI fixes, so "nothing merged" says nothing about them); never cut. Recommend them with friction_file instead. */
const UNCUTTABLE = new Set(["budget-review", "assistant", "devils-advocate", "business-review", "strategy", "ci-health"]);

/** Accepts ["owner/repo", ...] or [{ repo, focus }, ...]; anything else is dropped. */
export function parseInterests(raw: unknown): Interest[] {
	if (!Array.isArray(raw)) return [];
	const out: Interest[] = [];
	for (const item of raw) {
		if (typeof item === "string" && item.includes("/")) out.push({ repo: item });
		else if (item && typeof item === "object" && typeof (item as Interest).repo === "string") {
			const { repo, focus } = item as Interest;
			out.push(typeof focus === "string" && focus.trim() ? { repo, focus: focus.trim() } : { repo });
		}
	}
	return out;
}

export function interestRank(repo: string | undefined, interests: readonly Interest[]): number | undefined {
	if (repo === undefined) return undefined;
	const index = interests.findIndex((interest) => interest.repo.toLowerCase() === repo.toLowerCase());
	return index < 0 ? undefined : index + 1;
}

/** One row per active or paused loop: what it cost and what it merged in the window. */
export function loopResults(input: {
	loops: readonly CutLoop[];
	repoOf: (session: string) => string | undefined;
	audit: readonly { at?: unknown; event?: unknown; session?: unknown }[];
	interests: readonly Interest[];
	now: number;
	windowHours?: number;
}): LoopResult[] {
	const since = input.now - (input.windowHours ?? CUT_WINDOW_HOURS) * 3_600_000;
	const merges = new Map<string, number>();
	for (const entry of input.audit) {
		if (entry.event !== "merged" || typeof entry.session !== "string" || typeof entry.at !== "string") continue;
		if (Date.parse(entry.at) < since) continue;
		merges.set(entry.session, (merges.get(entry.session) ?? 0) + 1);
	}
	return input.loops
		.filter((loop) => loop.status === "active" || loop.status === "paused")
		.map((loop) => {
			const repo = input.repoOf(loop.session);
			const rank = interestRank(repo, input.interests);
			const spentUsd = (loop.spendLog ?? []).filter((entry) => entry.at >= since).reduce((sum, entry) => sum + entry.usd, 0);
			return {
				id: loop.id,
				session: loop.session,
				kind: loop.kind ?? "goal",
				status: loop.status,
				...(repo ? { repo } : {}),
				...(rank ? { rank } : {}),
				spentUsd,
				// Merges are counted per session: loops sharing one session share its results.
				merged: merges.get(loop.session) ?? 0,
				ageHours: loop.createdAt === undefined ? Number.POSITIVE_INFINITY : (input.now - loop.createdAt) / 3_600_000,
			};
		});
}

/** The RESULTS section of the evidence digest. */
export function resultsLines(rows: readonly LoopResult[], interests: readonly Interest[], windowHours = CUT_WINDOW_HOURS): string[] {
	const lines = [
		`TONY'S INTERESTS (ranked): ${interests.map((interest, i) => `${i + 1}. ${interest.repo}${interest.focus ? ` (${interest.focus})` : ""}`).join("; ") || "none set"}`,
		`RESULTS LAST ${windowHours}H (per loop: interest rank, spend, PRs merged by its session, cost per merge; most wasteful matter most)`,
	];
	const sorted = [...rows].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || b.spentUsd - a.spentUsd);
	for (const row of sorted) {
		const age = Number.isFinite(row.ageHours) ? `, age ${Math.floor(row.ageHours)}h` : "";
		const perMerge = row.merged > 0 ? `$${(row.spentUsd / row.merged).toFixed(2)}/merge` : row.spentUsd >= STALLED_SPEND_USD ? "NOTHING MERGED" : "no merges";
		lines.push(`- ${row.id} ${row.session} ${row.kind} ${row.status} ${row.repo ?? "no repo"} ${row.rank ? `#${row.rank}` : "NOT AN INTEREST"}: $${row.spentUsd.toFixed(2)}, ${row.merged} merged, ${perMerge}${age}`);
	}
	return lines;
}

/**
 * Why this cut is refused, or undefined when it is allowed. A cut must stop real waste:
 * - only active loops, never budget-review or assistant loops, never the caller's own, never urgent (priority 1);
 * - not younger than CUT_MIN_AGE_HOURS, and it must have spent at least CUT_MIN_SPEND_USD in the window;
 * - a loop on one of Tony's interests may be cut only when it is stalled (STALLED_SPEND_USD spent, nothing merged) or
 *   when the reviewer says its work is off the stated focus; his top interest only when stalled;
 * - at most MAX_CUTS per MAX_CUTS_WINDOW_HOURS.
 */
export function cutRefusal(input: {
	target: LoopResult | undefined;
	targetPriority?: number;
	callerSession: string;
	offFocus: boolean;
	recentCuts: number;
}): string | undefined {
	const { target } = input;
	if (target === undefined) return "no such loop, or it is not active";
	if (target.status !== "active") return `${target.id} is ${target.status}; only active loops can be cut`;
	if (UNCUTTABLE.has(target.kind)) return `${target.kind} loops are never cut (they do not merge by design); recommend it with friction_file instead`;
	if (target.session === input.callerSession) return "you cannot cut your own loop";
	if (input.targetPriority === 1) return `${target.id} is urgent (priority 1), set by Tony or a general; recommend it with friction_file instead`;
	if (target.ageHours < CUT_MIN_AGE_HOURS) return `${target.id} is only ${Math.floor(target.ageHours)}h old; give it ${CUT_MIN_AGE_HOURS}h`;
	if (target.spentUsd < CUT_MIN_SPEND_USD) return `${target.id} spent only $${target.spentUsd.toFixed(2)} in ${CUT_WINDOW_HOURS}h; it is not wasting money, leave it`;
	if (input.recentCuts >= MAX_CUTS) return `already ${input.recentCuts} cuts in the last ${MAX_CUTS_WINDOW_HOURS}h; file the rest with friction_file`;
	if (target.rank !== undefined) {
		const stalled = target.merged === 0 && target.spentUsd >= STALLED_SPEND_USD;
		if (target.rank === 1 && !stalled) return `${target.id} works on Tony's top interest and is producing; never cut it unless it is stalled`;
		if (!stalled && !input.offFocus) return `${target.id} works on interest #${target.rank} and merged ${target.merged}; cut it only if stalled, or with offFocus true when its work is off the stated focus`;
	}
	return undefined;
}

/** Cuts in the audit log within the cap window. */
export function recentCutCount(audit: readonly { at?: unknown; event?: unknown }[], now: number): number {
	const since = now - MAX_CUTS_WINDOW_HOURS * 3_600_000;
	return audit.filter((entry) => entry.event === "loop_cut" && typeof entry.at === "string" && Date.parse(entry.at) >= since).length;
}
