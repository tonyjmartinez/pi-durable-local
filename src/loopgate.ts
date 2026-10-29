// Decide, in code and before any model runs, whether a loop tick should wake an agent. Idle repos then cost nothing.
// The cleanup schedule and the "skip if no commits in 24h" rule follow Kent C. Dodds's autopilot cleanup automations
// (https://github.com/kentcdodds/kcd-skills, MIT). All times are epoch milliseconds.

export type LoopKind = "goal" | "cleanup" | "friction-sweep";

export type GateLoop = {
	/** Default "goal". */
	kind?: LoopKind;
	lastRunAt?: number;
	iteration: number;
	/** Cleanup loops skip when the base branch has seen no commit within this many hours. Default 24. */
	skipIfIdleHours?: number;
};

export type GatePr = {
	number: number;
	headSha: string;
	/** The head commit the last pr_tick looked at. */
	lastTickedSha?: string;
	checksState: "pending" | "pass" | "fail";
};

export type GateRepo = {
	baseHeadSha: string;
	baseHeadCommittedAt: number;
	/** The base head the loop saw at its last run. */
	lastSeenBaseSha?: string;
	openAgentPrs: readonly GatePr[];
	openFrictionIssues: number;
};

export type WakeDecision = { wake: boolean; reason: string; nextCheckMinutes?: number };

export const DEFAULT_SKIP_IF_IDLE_HOURS = 24;
/** How soon to look again while checks run. */
export const CHECKS_RECHECK_MINUTES = 5;
/** How soon to look again when there is nothing to do. */
export const IDLE_RECHECK_MINUTES = 60;

const HOUR = 3_600_000;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const validTime = (t: unknown): t is number => typeof t === "number" && Number.isFinite(t) && t > 0;

export function shouldWake(input: { loop: GateLoop; repo: GateRepo; now: number }): WakeDecision {
	const { loop, repo, now } = input;
	const kind = loop.kind ?? "goal";
	const prs = repo.openAgentPrs;

	// Waiting on CI is not work: every open PR is still running its checks, so a model would only watch them.
	if (prs.length > 0 && prs.every((pr) => pr.checksState === "pending")) {
		return { wake: false, reason: `waiting for checks on ${plural(prs.length, "open PR")}`, nextCheckMinutes: CHECKS_RECHECK_MINUTES };
	}

	if (kind === "friction-sweep") {
		return repo.openFrictionIssues > 0
			? { wake: true, reason: `${plural(repo.openFrictionIssues, "open friction issue")}` }
			: { wake: false, reason: "no open friction issues", nextCheckMinutes: IDLE_RECHECK_MINUTES };
	}

	if (kind === "cleanup") {
		const idleHours = loop.skipIfIdleHours ?? DEFAULT_SKIP_IF_IDLE_HOURS;
		const firstRun = loop.iteration === 0 && loop.lastRunAt === undefined;
		if (firstRun) return { wake: true, reason: "first run" };
		if (repo.baseHeadSha === "" || !validTime(repo.baseHeadCommittedAt)) return { wake: true, reason: "base branch state unavailable; waking to look" };

		// New work since the last run: a different head if we know the last one, else a commit after the last run.
		const changed =
			repo.lastSeenBaseSha !== undefined
				? repo.lastSeenBaseSha !== repo.baseHeadSha
				: loop.lastRunAt === undefined || repo.baseHeadCommittedAt > loop.lastRunAt;
		if (!changed) return { wake: false, reason: "no new commits on the base branch since the last run", nextCheckMinutes: IDLE_RECHECK_MINUTES };

		const ageHours = (now - repo.baseHeadCommittedAt) / HOUR;
		if (ageHours > idleHours) {
			return { wake: false, reason: `base branch idle: last commit ${Math.floor(ageHours)}h ago (limit ${idleHours}h)`, nextCheckMinutes: IDLE_RECHECK_MINUTES };
		}
		return { wake: true, reason: `base branch changed ${Math.max(0, Math.floor(ageHours))}h ago` };
	}

	return { wake: true, reason: prs.length === 0 ? "goal loop" : `goal loop with ${plural(prs.length, "open PR")} to move` };
}

/** Suggested interval and idle window for each cleanup brief. */
export const CLEANUP_SCHEDULE: Record<CleanupName, { kind: LoopKind; intervalMinutes: number; skipIfIdleHours?: number }> = {
	"keep-tests-tight": { kind: "cleanup", intervalMinutes: 24 * 60, skipIfIdleHours: 24 },
	"docs-freshness": { kind: "cleanup", intervalMinutes: 24 * 60, skipIfIdleHours: 24 },
	"legacy-reaper": { kind: "cleanup", intervalMinutes: 7 * 24 * 60, skipIfIdleHours: 7 * 24 },
	"friction-sweep": { kind: "friction-sweep", intervalMinutes: 24 * 60 },
};

export type CleanupName = "keep-tests-tight" | "docs-freshness" | "legacy-reaper" | "friction-sweep";

const RULES = `Rules for every iteration:
- Start with git_sync and branch from the base branch as pd/<short-slug>. If a PR of yours is already open, finish it first (pr_tick, then act on what it says) before starting anything new. Never have more than 3 of your PRs open.
- Ship ONE small, verified, two-way-door change. Run the repo's verify command (tests, typecheck, lint) before and after, and put what you ran and what you could not verify in the PR's Testing section.
- Use pr_create with the PR template, and merge only through pr_tick / pr_merge. Do not touch protected paths (.github, lockfiles, package.json, configs, secrets); leave those for a human.
- Anything that needs a product or policy call is not yours to decide: file it as friction with needs-decision (friction_file, if you have it) and move on.
- Never invent facts. Check claims against the code and git history, not memory.`;

const END = "End every iteration the same way: open at most ONE PR, or none if nothing to do; finish with loop_report.";

export const CLEANUP_PROMPTS: Record<CleanupName, string> = {
	"keep-tests-tight": `Keep the test suite tight.
Find tests that are redundant, flaky, or coupled to implementation details (they break on refactors, not on behavior changes), and remove or rewrite them so every behavior stays covered. Look first at tests that failed or were retried recently, tests that duplicate another test's assertions, and tests that assert on private structure or exact call counts.
- Never delete the only test of a behavior. Before deleting, name the behavior and the remaining test that still covers it.
- Prefer deleting over rewriting, and rewriting over adding. A smaller suite that catches the same bugs is the goal.
- Changing a test's expectation next to the code it tests is medium risk: say why the old expectation was wrong.
- Keep the PR small: a handful of tests, one theme.
${RULES}
${END}`,

	"docs-freshness": `Keep the docs true.
Read the commits since the last run (git log on the base branch) and fix AGENTS.md, the README, decision records, and other docs that those commits made stale: renamed commands, moved files, changed defaults, removed features. Trim sections nobody cites; shorter and correct beats long and out of date.
- Every command and path you write must be one you ran or confirmed exists.
- Do not rewrite for style or add new documentation nobody asked for. Fix what is wrong, delete what is dead.
- If a decision record is contradicted by the code, flag it rather than silently rewriting history: update the record only when its "revisit if" condition clearly holds, otherwise file friction.
${RULES}
${END}`,

	"legacy-reaper": `Reap legacy code.
Remove what is provably dead: unused exports and files, unreachable branches, feature flags whose removal condition has been met, deprecated paths with no callers, and Cleanup: issues whose "ready when" condition now holds.
- Prove it before you delete it: search for every reference (code, config, scripts, docs, tests), run typecheck and the tests, and say how you checked.
- Skip anything public, anything with a data or contract implication, and anything you are not sure about. Those are one-way doors: file them as friction with needs-decision.
- One theme per PR (for example, one expired flag or one dead module), so it is easy to revert.
${RULES}
${END}`,

	"friction-sweep": `Sweep the friction issues.
List the open issues labelled friction. Skip any marked needs-decision or friction-skipped. Take the highest priority first (P0, then P1, P2, P3); within a priority, the oldest. If you already have a PR open for an issue, finish that PR instead of starting another.
- Fix the root cause, not the symptom. Reference the issue in the PR (Fixes #N) and say how you reproduced the problem and how you know it is gone.
- If an issue is already fixed or is invalid, close it with a one-line note saying why, and count that as your iteration.
- If the fix is a policy or product decision, add needs-decision and a comment with your options (each marked one-way or two-way door) and your recommendation; do not pick for the human.
${RULES}
${END}`,
};
