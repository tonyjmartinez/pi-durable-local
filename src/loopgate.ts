// Decide, in code and before any model runs, whether a loop tick should wake an agent. Idle repos then cost nothing.
// The cleanup schedule and the "skip if no commits in 24h" rule follow Kent C. Dodds's autopilot cleanup automations
// (https://github.com/kentcdodds/kcd-skills, MIT). All times are epoch milliseconds.

/**
 * goal: always wakes. cleanup: skips when the base branch is idle. friction-sweep: skips with no open friction.
 * code-quality: a cleanup that also waits for the repo's product loop to go quiet. ci-health: wakes only on a red or
 * flaky base branch.
 */
export type LoopKind = "goal" | "cleanup" | "friction-sweep" | "code-quality" | "ci-health";

export type GateLoop = {
	/** Default "goal". */
	kind?: LoopKind;
	lastRunAt?: number;
	iteration: number;
	/** Cleanup loops skip when the base branch has seen no commit within this many hours. Default 24. */
	skipIfIdleHours?: number;
	/** Set when the loop went to sleep: the repo's work fingerprint at that moment. */
	dormant?: { fingerprint: string; since: number };
	/** ci-health: the CI finding the last completed iteration was woken for, so the same red commit is not retried. */
	lastCiKey?: string;
};

/** The base branch's recent workflow runs, as the ci-health gate sees them. */
export type GateCi = {
	/** The commit the newest run on the base branch tested. */
	headSha: string;
	/** Workflows whose newest completed run on the base branch failed. */
	failing: readonly string[];
	/** Workflows that failed in more than FLAKY_FAILURE_SHARE of their recent runs but are not failing now. */
	flaky: readonly string[];
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
	/** Open friction issues an agent may act on (not needs-decision or friction-skipped). */
	openFrictionIssues: number;
	/** Open issues as "count:latest update", so a new or edited issue changes it. */
	openIssuesKey?: string;
	/** code-quality: another loop on this repo (the product loop) is awake and may be editing the same files. */
	productLoopActive?: boolean;
	/** All loops' spend today as a share of the factory's daily cap (0..1+); undefined when there is no cap. */
	dailySpendShare?: number;
	/** ci-health: undefined when the runs could not be read. */
	ci?: GateCi;
};

export type WakeDecision = { wake: boolean; reason: string; nextCheckMinutes?: number };

export const DEFAULT_SKIP_IF_IDLE_HOURS = 24;
/** How soon to look again while checks run. */
export const CHECKS_RECHECK_MINUTES = 5;
/** How soon to look again when there is nothing to do. */
export const IDLE_RECHECK_MINUTES = 60;
/** How often a dormant loop looks at GitHub (no model call) for anything new. */
export const DORMANT_RECHECK_MINUTES = 6 * 60;
/** Consecutive iterations that changed nothing on GitHub before a loop goes dormant on its own. */
export const AUTO_DORMANT_AFTER = 3;
/** Maintenance loops (code-quality, ci-health) yield to product loops once today's spend passes this share of the cap. */
export const MAINTENANCE_SHARE_OF_DAILY = 0.7;
/** A workflow that failed in more than this share of its recent base-branch runs is flaky. */
export const FLAKY_FAILURE_SHARE = 0.2;
/** How many recent base-branch runs the ci-health gate reads. */
export const CI_RUNS_WINDOW = 10;

const HOUR = 3_600_000;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const validTime = (t: unknown): t is number => typeof t === "number" && Number.isFinite(t) && t > 0;

/** What an agent's work on GitHub looks like: the base head, its open PR heads, and the open issues. Equal before and after an iteration means the iteration changed nothing. */
export function workFingerprint(repo: Pick<GateRepo, "baseHeadSha" | "openAgentPrs" | "openIssuesKey">): string {
	const prs = repo.openAgentPrs.map((pr) => `${pr.number}@${pr.headSha}`).sort().join(",");
	return `${repo.baseHeadSha}|${prs}|${repo.openIssuesKey ?? ""}`;
}

/** After an iteration: the new no-op streak, and whether the loop should now go dormant. */
export function afterIteration(input: { before?: string; after?: string; streak: number; idleReported: boolean }): { streak: number; dormant: boolean } {
	const unchanged = input.before !== undefined && input.after !== undefined && input.before === input.after;
	const streak = unchanged ? input.streak + 1 : 0;
	return { streak, dormant: input.idleReported || streak >= AUTO_DORMANT_AFTER };
}

/** What the ci-health loop would be woken for; equal keys mean the same finding. Empty means nothing to do. */
export function ciKey(ci: GateCi): string {
	if (ci.failing.length === 0 && ci.flaky.length === 0) return "";
	return `${ci.headSha}|red:${[...ci.failing].sort().join(",")}|flaky:${[...ci.flaky].sort().join(",")}`;
}

/**
 * The base branch's CI, from `gh run list --branch <base> --json headSha,workflowName,conclusion,status,createdAt`
 * (any order). Only completed runs count; runs that were cancelled or skipped say nothing about health.
 */
export function summarizeRuns(runs: readonly { headSha: string; workflowName: string; conclusion: string | null; status: string; createdAt: string }[]): GateCi | undefined {
	const newestFirst = [...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
	if (newestFirst.length === 0) return undefined;
	const judged = newestFirst.filter((run) => run.status === "completed" && (run.conclusion === "success" || run.conclusion === "failure" || run.conclusion === "timed_out"));
	const byWorkflow = new Map<string, boolean[]>();
	for (const run of judged) {
		const list = byWorkflow.get(run.workflowName) ?? [];
		list.push(run.conclusion !== "success");
		byWorkflow.set(run.workflowName, list);
	}
	const failing: string[] = [];
	const flaky: string[] = [];
	for (const [name, failed] of byWorkflow) {
		if (failed[0]) failing.push(name);
		else if (failed.length >= 3 && failed.filter(Boolean).length / failed.length > FLAKY_FAILURE_SHARE) flaky.push(name);
	}
	return { headSha: newestFirst[0]!.headSha, failing: failing.sort(), flaky: flaky.sort() };
}

export function shouldWake(input: { loop: GateLoop; repo: GateRepo; now: number }): WakeDecision {
	const { loop, repo, now } = input;
	const kind = loop.kind ?? "goal";
	const prs = repo.openAgentPrs;


	// Waiting on CI is not work: every open PR is still running its checks, so a model would only watch them.
	if (prs.length > 0 && prs.every((pr) => pr.checksState === "pending")) {
		return { wake: false, reason: `waiting for checks on ${plural(prs.length, "open PR")}`, nextCheckMinutes: CHECKS_RECHECK_MINUTES };
	}

	// A dormant loop said (or showed) it had nothing left to do. It sleeps until the repo changes under it.
	if (loop.dormant !== undefined) {
		return workFingerprint(repo) === loop.dormant.fingerprint
			? { wake: false, reason: "dormant: nothing new since it ran out of work", nextCheckMinutes: DORMANT_RECHECK_MINUTES }
			: { wake: true, reason: "dormant loop woke: new commits, PR activity or issues" };
	}

	// Maintenance waits while product loops need the day's budget. A red base branch is the exception: it blocks
	// every product PR anyway.
	const maintenance = kind === "code-quality" || kind === "ci-health";
	const baseRed = kind === "ci-health" && repo.ci !== undefined && repo.ci.failing.length > 0;
	if (maintenance && !baseRed && repo.dailySpendShare !== undefined && repo.dailySpendShare >= MAINTENANCE_SHARE_OF_DAILY) {
		return { wake: false, reason: `today's spend is ${Math.round(repo.dailySpendShare * 100)}% of the daily cap; product loops go first`, nextCheckMinutes: IDLE_RECHECK_MINUTES };
	}

	if (kind === "ci-health") {
		if (repo.ci === undefined) return { wake: false, reason: "no workflow runs on the base branch to read", nextCheckMinutes: IDLE_RECHECK_MINUTES };
		const key = ciKey(repo.ci);
		if (key === "") return { wake: false, reason: "base branch CI is green and steady", nextCheckMinutes: IDLE_RECHECK_MINUTES };
		if (key === loop.lastCiKey) return { wake: false, reason: `already worked on this CI state at ${repo.ci.headSha.slice(0, 7)}; waiting for a new commit`, nextCheckMinutes: IDLE_RECHECK_MINUTES };
		const parts = [
			repo.ci.failing.length > 0 ? `failing on ${repo.ci.headSha.slice(0, 7)}: ${repo.ci.failing.join(", ")}` : undefined,
			repo.ci.flaky.length > 0 ? `flaky: ${repo.ci.flaky.join(", ")}` : undefined,
		].filter(Boolean);
		return { wake: true, reason: `base branch CI ${parts.join("; ")}` };
	}

	if (kind === "code-quality" && repo.productLoopActive === true) {
		return { wake: false, reason: "the product loop on this repo is awake; quality work waits so they don't edit the same files", nextCheckMinutes: IDLE_RECHECK_MINUTES };
	}

	if (kind === "friction-sweep") {
		return repo.openFrictionIssues > 0
			? { wake: true, reason: `${plural(repo.openFrictionIssues, "open friction issue")}` }
			: { wake: false, reason: "no open friction issues", nextCheckMinutes: IDLE_RECHECK_MINUTES };
	}

	if (kind === "cleanup" || kind === "code-quality") {
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
export type LoopScheduleEntry = { kind: LoopKind; intervalMinutes: number; skipIfIdleHours?: number; budgetUsd?: number };

export const CLEANUP_SCHEDULE: Record<CleanupName, LoopScheduleEntry> = {
	"keep-tests-tight": { kind: "cleanup", intervalMinutes: 24 * 60, skipIfIdleHours: 24 },
	"docs-freshness": { kind: "cleanup", intervalMinutes: 24 * 60, skipIfIdleHours: 24 },
	"legacy-reaper": { kind: "cleanup", intervalMinutes: 7 * 24 * 60, skipIfIdleHours: 7 * 24 },
	"friction-sweep": { kind: "friction-sweep", intervalMinutes: 24 * 60 },
	"code-quality": { kind: "code-quality", intervalMinutes: 24 * 60, skipIfIdleHours: 24, budgetUsd: 5 },
	"ci-health": { kind: "ci-health", intervalMinutes: 60, budgetUsd: 5 },
};

export type CleanupName = "keep-tests-tight" | "docs-freshness" | "legacy-reaper" | "friction-sweep" | "code-quality" | "ci-health";

/** Branch prefixes (after the factory's own pd/) that mark maintenance PRs, which get the stricter test rules. */
export const MAINTENANCE_BRANCH_SLUGS = ["quality-", "ci-"] as const;

const RULES = `Rules for every iteration:
- Keep this iteration cheap: at most 12 substantive assistant turns. Make one focused pass and stop once the small change is verified or a genuine blocker is found.
- Bound command output: use targeted searches and summaries; never dump whole generated files, dependency trees, or long build logs. Capture only relevant error lines. Do not delegate routine work or browse unless repository evidence is insufficient.
- Start with git_sync and branch from the base branch as pd/<short-slug>. If a PR of yours is already open, finish it first (pr_tick, then act on what it says) before starting anything new. Never have more than 3 of your PRs open.
- Ship ONE small, verified, two-way-door change. Run the repo's verify command (tests, typecheck, lint) before and after, and put what you ran and what you could not verify in the PR's Testing section.
- Use pr_create with the PR template, and merge only through pr_tick / pr_merge. Do not touch protected paths (.github, lockfiles, package.json, configs, secrets); leave those for a human.
- Routine product decisions are yours: choose a small, reversible option using the repo goals, user needs, evidence, and conventions; record the rationale. Do not mark ordinary product tradeoffs as needs-decision. Keep one-way changes, safety-policy changes, protected paths, and decisions requiring owner-only facts for the human; when blocked, use friction_file, if you have it, with options and a recommendation.
- Never invent facts. Check claims against the code and git history, not memory.`;

const END = "End every iteration the same way: open at most ONE PR, or none if nothing to do; finish with loop_report. When there is nothing worthwhile to do, report status \"idle\" so the loop sleeps until the repo changes.";

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
List the open issues labelled friction with issue_list (label friction, search "-label:needs-decision -label:friction-skipped") and read one with issue_view. Take the highest priority first (P0, then P1, P2, P3); within a priority, the oldest. If you already have a PR open for an issue, finish that PR instead of starting another.
- Fix the root cause, not the symptom. Reference the issue in the PR (Fixes #N) and say how you reproduced the problem and how you know it is gone.
- If an issue is already fixed or is invalid, close it with issue_close and a one-line note saying why, and count that as your iteration.
- For a routine, reversible product decision, choose the option that best serves users and document why. Mark needs-decision only for a one-way change, a safety-policy change, or a fact only the owner can provide; include the options and a recommendation.
${RULES}
${END}`,

	"code-quality": `Improve code quality without changing behavior.
Find one spot where the code is harder to read or change than it needs to be, and make it simpler: duplicated logic, an overgrown function, a confusing name, a lint or type error, an any that hides a real type, an error that is swallowed. Prefer code touched by recent commits (git log on the base branch) and code that recent bugs or friction issues came from.
- Behavior must not change. The existing tests must pass unchanged: do not edit a test's assertions in the same PR as the code it tests. If a behavior has no test, add one first, in the same PR, that passes before and after.
- Never weaken a check to make it pass: no .skip, .only, xit, test.todo, retries, --passWithNoTests, @ts-ignore, @ts-expect-error, eslint-disable, or loosened types. The daemon parks PRs that add these markers or delete tests or assertions.
- Name the branch pd/quality-<slug>. Declare Touches: <area> (composes) and Door: two-way. At most 200 changed lines; one theme per PR.
- Leave tests alone otherwise (keep-tests-tight owns pruning them) and leave product changes to the product loop.
${RULES}
${END}`,

	"ci-health": `Keep the base branch's CI green and steady.
You were woken because the base branch's CI is failing or flaky (the reason is in the wake line above). Read the failing runs read-only: gh run list --branch <base> --limit 10, then gh run view <id> --log-failed (capture only the relevant error lines).
- Failing: find the commit that broke it and fix the cause in code or tests with one small PR. If a test caught a real bug, fix the code, not the test.
- Flaky: find why the test is nondeterministic (timing, ordering, shared state, network, randomness) and make it deterministic. File a friction issue naming the test and the evidence. Never quarantine, skip, or retry a test to get green.
- You cannot change CI configuration: .github/, test-runner configs, lockfiles and dependency manifests are protected and pushes touching .github/ are refused. If the fix really is a CI change (caching, a missing secret, a job that is skipped but reports success, a slow step), write the proposed workflow or a short note to docs/proposed-ci/<name>.md in a PR for Tony, with the evidence, and report it in loop_report.
- If the failure is outside the repo (an outage, an expired token, a missing secret), do no code work: file friction with needs-decision and report "blocked".
- Never weaken tests: no .skip, .only, xit, test.todo, retries, --passWithNoTests, lowered coverage thresholds, deleted assertions. The daemon parks any PR that does.
- Name the branch pd/ci-<slug>. Door: two-way. At most 200 changed lines.
${RULES}
${END}`,
};

export type LoopPreset = CleanupName | "product-gardener";

export const PRODUCT_GARDENER_PROMPT = [
	"Incrementally improve this repository for its users. Act as the product-minded maintainer, not just a ticket taker.",
	"Orient first: read the project instructions and README, inspect recent commits, existing issues and pull requests, and identify the repository type and its users.",
	"For an application or site, look for a small improvement to usability, accessibility, reliability, or performance. For a library or developer tool, reduce a concrete user or contributor pain point. Prefer evidence already in the repository and avoid broad speculative research.",
	"Choose one small, useful, reversible improvement yourself. State the user problem and why this is the best next step in the PR. For uncertain but low-risk product choices, make a conservative assumption, record it, and continue without asking the owner.",
	"Follow the repository contribution rules and existing stack. Find and run its documented verification command. Avoid new dependencies, migrations, public API changes, unverified factual claims, and changes to protected paths unless the project rules allow them and there is a clear need.",
	"Do not make irreversible product, privacy, security, financial, legal, or public-commitment decisions. If the next useful step requires owner-only facts or crosses a human gate, explain the exact blocker and recommend a next step. If no worthwhile small change is supported by evidence, do no code work and report that."
].join("\n");

export const LOOP_PROMPTS: Record<LoopPreset, string> = {
	...CLEANUP_PROMPTS,
	"product-gardener": PRODUCT_GARDENER_PROMPT,
};

export const LOOP_SCHEDULE: Record<LoopPreset, LoopScheduleEntry> = {
	...CLEANUP_SCHEDULE,
	"product-gardener": { kind: "goal", intervalMinutes: 30 },
};
