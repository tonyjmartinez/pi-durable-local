// The ship-PR decision, as a pure function: given a PR's state, name the ONE next action.
//
// Ported from `decide()` in kcd-skills `skills/autopilot/scripts/ship-pr.mjs` by Kent C. Dodds
// (https://github.com/kentcdodds/kcd-skills), used under the MIT License:
//
//   MIT License
//   Copyright (c) 2026 Kent C. Dodds
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
//   documentation files (the "Software"), to deal in the Software without restriction, including without limitation
//   the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
//   to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above
//   copyright notice and this permission notice shall be included in all copies or substantial portions of the
//   Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED. See
//   https://github.com/kentcdodds/kcd-skills/blob/main/LICENSE for the full text.
//
// Kent's order is kept: merged/closed, draft, conflicts, behind, failing CI, pending CI, reviewers, unresolved
// threads, requested changes, human approval, merge authority, merge. pi-durable adds the repo allowlist, the
// in-daemon AI review, and the one-way-door rule.
import type { Door, Tier } from "./prtemplate.ts";

/** `gh pr checks --json bucket` values. */
export type CheckBucket = "pass" | "fail" | "pending" | "skipping" | "cancel";

export type PrTickState = {
	state: "OPEN" | "MERGED" | "CLOSED";
	isDraft: boolean;
	/** A throwaway prototype branch (`<prefix>spike-*`): opened as a draft to react to, closed when decided, never merged. */
	isSpike?: boolean;
	/** GitHub `mergeable === "CONFLICTING"`. */
	conflicts: boolean;
	/** GitHub `mergeStateStatus === "BEHIND"`. */
	behind: boolean;
	/** Checks for the head commit. */
	checks: readonly { name: string; bucket: CheckBucket }[];
	/** GitHub `reviewDecision`; only CHANGES_REQUESTED matters here. */
	reviewDecision?: string | null;
	/** Open, non-outdated review threads. */
	unresolvedThreads?: readonly { id?: string; path?: string; line?: number; body?: string }[];
	/** The tier the PR is handled at: effectiveRisk(riskFloor(diff), declared). */
	tier: Tier;
	door: Door;
	/** Merge authority: the repo is in automerge.repos and the head branch is the agent's own. */
	mergeAllowed: boolean;
	/** The in-daemon review of the current head: undefined = not run yet, false = rejected. */
	aiReview?: boolean;
	/** Why the review rejected the head, shown when it does. */
	aiReviewReasons?: readonly string[];
	/** A person (not the agent) approved the PR; lifts the human-approval and tier limits, never CI or review. */
	humanApproved?: boolean;
	/** Reasons a human must look regardless of tier (protected paths, a needs-decision marker, missing template fields). */
	needsHuman?: readonly string[];
	/** Merged, and a post-merge deploy check is configured but has not run. */
	deployCheckPending?: boolean;
};

export type PrTickOptions = {
	/** Tiers the agent may merge by itself. Default low and medium. */
	autoMergeTiers: readonly Tier[];
	/** Tiers that need the in-daemon AI review before merge. Default medium and high. */
	aiReviewTiers: readonly Tier[];
	/** Tiers that need a human approval. Default high. */
	humanApprovalTiers: readonly Tier[];
	/** A repo with no passing check is never auto-merged. */
	requireChecks: boolean;
	/** How long to wait before ticking again while checks run. */
	waitSeconds: number;
};

export const DEFAULT_TICK_OPTIONS: PrTickOptions = {
	autoMergeTiers: ["low", "medium"],
	aiReviewTiers: ["medium", "high"],
	humanApprovalTiers: ["high"],
	requireChecks: true,
	waitSeconds: 60,
};

export type PrAction =
	| "done"
	| "stop"
	| "verify-deploy"
	| "mark-ready"
	| "resolve-conflicts"
	| "update-branch"
	| "fix-ci"
	| "wait-ci"
	| "address-review"
	| "park-human"
	| "no-merge-authority"
	| "review"
	| "merge";

export type PrDecision = {
	action: PrAction;
	reason: string;
	/** Failing check names, thread summaries, or review reasons, for the agent to act on. */
	details?: string[];
	waitSeconds?: number;
};

const summarize = (thread: { path?: string; line?: number; body?: string }) =>
	`${thread.path ?? "(general)"}${thread.line === undefined ? "" : `:${thread.line}`} ${(thread.body ?? "").slice(0, 200)}`.trim();

export function decidePr(state: PrTickState, overrides: Partial<PrTickOptions> = {}): PrDecision {
	const options = { ...DEFAULT_TICK_OPTIONS, ...overrides };

	if (state.state === "MERGED") {
		return state.deployCheckPending === true
			? { action: "verify-deploy", reason: "Merged; run the configured deploy check against the merge commit." }
			: { action: "done", reason: "Pull request is merged." };
	}
	if (state.state === "CLOSED") return { action: "stop", reason: "Pull request is closed without merging." };

	if (state.isSpike === true) return { action: "park-human", reason: "A spike is a prototype to react to: it is never merged. Leave it for the proposal's decision, then close it." };
	if (state.isDraft) return { action: "mark-ready", reason: "Mark the draft pull request ready for review." };
	// GitHub reports a conflict when the base squash-merged an earlier commit of this same change; a rebase drops it.
	if (state.conflicts) {
		return {
			action: "resolve-conflicts",
			reason: "GitHub reports merge conflicts. Run git_sync, then git rebase origin/<base>: if the base already squash-merged an earlier commit of this change, the rebase skips it cleanly and that is expected. Fix any real conflicts, verify, then git_push with force.",
		};
	}
	if (state.behind) return { action: "update-branch", reason: "Update the branch from its base: git_sync, git rebase origin/<base>, verify, then git_push with force." };

	const failing = state.checks.filter((check) => check.bucket === "fail" || check.bucket === "cancel");
	if (failing.length > 0) return { action: "fix-ci", reason: "Fix the failing checks.", details: failing.map((check) => check.name) };
	const pending = state.checks.filter((check) => check.bucket === "pending");
	if (pending.length > 0) {
		return { action: "wait-ci", reason: "Checks are still running.", details: pending.map((check) => check.name), waitSeconds: options.waitSeconds };
	}
	if (options.requireChecks && !state.checks.some((check) => check.bucket === "pass")) {
		return { action: "park-human", reason: "No passing CI checks; a repo without CI is never auto-merged." };
	}

	const threads = state.unresolvedThreads ?? [];
	if (threads.length > 0) {
		return {
			action: "address-review",
			reason: "Fix each thread, or reply with why it is invalid, then resolve it.",
			details: threads.map(summarize),
		};
	}
	if (state.reviewDecision === "CHANGES_REQUESTED") {
		return { action: "address-review", reason: "A reviewer requested changes; address them and reply." };
	}
	if (state.aiReview === false) {
		return {
			action: "address-review",
			reason: "The automated review rejected this head commit; fix the reasons below, push, and it will be reviewed again.",
			details: [...(state.aiReviewReasons ?? [])],
		};
	}

	// A person who looked at it lifts the tier and door limits; nothing else does.
	if (state.humanApproved !== true) {
		if (state.door === "one-way") return { action: "park-human", reason: "One-way door: a human decides." };
		if (state.needsHuman !== undefined && state.needsHuman.length > 0) {
			return { action: "park-human", reason: "A human needs to look at this.", details: [...state.needsHuman] };
		}
		if (options.humanApprovalTiers.includes(state.tier)) {
			return { action: "park-human", reason: `Risk tier ${state.tier} needs human approval.` };
		}
		if (!options.autoMergeTiers.includes(state.tier)) {
			return { action: "park-human", reason: `Ready, but the agent has no merge authority for risk tier ${state.tier}.` };
		}
	}

	if (!state.mergeAllowed) {
		return { action: "no-merge-authority", reason: "This repo or branch is not allowed for agent merges; leave the PR for a human." };
	}
	if (options.aiReviewTiers.includes(state.tier) && state.aiReview === undefined) {
		return { action: "review", reason: `Risk tier ${state.tier} needs the automated review of this head commit.` };
	}
	return { action: "merge", reason: "All merge gates passed." };
}
