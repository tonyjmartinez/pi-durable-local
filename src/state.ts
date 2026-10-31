// Session-scoped durable documents: every conversation in the daemon reads and writes the same copies.
import { appendFileSync } from "node:fs";
import { defineDoc } from "@earendil-works/pi-durable";
import { AUDIT_LOG, loadSecrets } from "./config.ts";
import { type NotifyEvent, notify } from "./notify.ts";

export type SessionInfo = {
	/** pi-durable ConversationId (a branded number). */
	conversationId: number;
	cwd: string;
	purpose: string;
	createdAt: number;
	/** origin URL captured when the session was created; the daemon pushes only here. */
	remote?: string;
};

export const Sessions = defineDoc<{ byName: Record<string, SessionInfo> }>({
	kind: "pdl.sessions",
	version: 1,
	scope: "session",
	initial: () => ({ byName: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});

export type Memory = {
	id: string;
	topic: string;
	text: string;
	/** Project directory the fact is about, or absent for facts that hold everywhere. */
	project?: string;
	tags: string[];
	/** Session name that wrote it last. */
	by: string;
	updatedAt: number;
};

export const Memories = defineDoc<{ items: Record<string, Memory>; nextId: number }>({
	kind: "pdl.memory",
	version: 1,
	scope: "session",
	initial: () => ({ items: {}, nextId: 1 }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});

export type LoopStatus = "active" | "paused" | "done" | "failed";

export type Loop = {
	id: string;
	session: string;
	goal: string;
	/** Compact next work item, supplied by loop_report for the next fresh iteration. */
	nextTask?: string;
	intervalMinutes: number;
	maxIterations: number;
	budgetUsd: number;
	iteration: number;
	status: LoopStatus;
	/** Why it stopped, or the agent's latest status line. */
	note: string;
	taskId?: number;
	createdAt: number;
	lastRunAt?: number;
	nextRunAt?: number;
	/** Session cost when the loop started (kept for history; budgets use `spent`). */
	costAtStart: number;
	/**
	 * This loop's own spend: the session's cost change across each of its iterations. Measured per loop, so two
	 * loops on one session don't charge each other.
	 */
	spent?: number;
	/** Time-stamped charges (last two days), for the factory-wide daily budget. */
	spendLog?: { at: number; usd: number }[];
	/** How the loop gate decides to wake it; see LoopKind in loopgate.ts. Default goal. */
	kind?: "goal" | "design" | "cleanup" | "friction-sweep" | "code-quality" | "ci-health";
	/** ci-health: the CI finding the last completed iteration was woken for. */
	lastCiKey?: string;
	skipIfIdleHours?: number;
	/** Base branch head when the loop last woke a model. */
	lastSeenBaseSha?: string;
	/** Ticks skipped without a model call, for status. */
	skipped?: number;
	/** Asleep because it ran out of work: wakes only when the repo's work fingerprint changes, or on resume. */
	dormant?: { fingerprint: string; since: number };
	/** Consecutive completed iterations that changed nothing on GitHub. */
	noopStreak?: number;
	/** The agent's last loop_report said "idle"; the iteration's end puts the loop to sleep. */
	idleReported?: boolean;
};

export const Loops = defineDoc<{ byId: Record<string, Loop>; nextId: number }>({
	kind: "pdl.loops",
	version: 1,
	scope: "session",
	initial: () => ({ byId: {}, nextId: 1 }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});

/** Subagent conversations, by conversation ID, mapped to the session that spawned them. */
export const Subagents = defineDoc<{ parentOf: Record<string, string> }>({
	kind: "pdl.subagents",
	version: 1,
	scope: "session",
	initial: () => ({ parentOf: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});

export function sessionNameOf(byName: Record<string, SessionInfo>, conversationId: number, parentOf?: Record<string, string>): string | undefined {
	for (const [name, info] of Object.entries(byName)) if (info.conversationId === conversationId) return name;
	// A subagent acts within its parent session's directory and rules.
	return parentOf?.[String(conversationId)];
}

/** Append-only record of every safety decision and merge, outside the database so it survives a reset. */
export function audit(event: string, data: Record<string, unknown>): void {
	try {
		appendFileSync(AUDIT_LOG, `${JSON.stringify({ at: new Date().toISOString(), event, ...data })}\n`, { mode: 0o600 });
	} catch {
		// Auditing must never take a tool call down.
	}
	const message = notificationFor(event, data);
	// PD_NOTIFY_URL (ntfy.sh topic, Discord webhook, or any JSON endpoint) is a secret: it lives in the env file.
	if (message !== undefined) void notify(message, { webhookUrl: loadSecrets().PD_NOTIFY_URL ?? process.env.PD_NOTIFY_URL });
}

/** The audit events worth a phone notification. */
export function notificationFor(event: string, data: Record<string, unknown>): NotifyEvent | undefined {
	const pr = data.repo !== undefined && data.pr !== undefined ? `${String(data.repo)}#${String(data.pr)}` : undefined;
	const url = pr === undefined ? undefined : `https://github.com/${String(data.repo)}/pull/${String(data.pr)}`;
	switch (event) {
		case "merged":
			return { type: "merged", title: `Merged ${pr}`, text: `tier ${String(data.tier ?? "?")} by ${String(data.session ?? "a session")}`, ...(url ? { url } : {}) };
		case "parked":
			return { type: "parked", title: `Needs you: ${pr}${data.sha ? ` @${String(data.sha)}` : ""}`, text: [String(data.reason ?? ""), ...((data.details as string[] | undefined) ?? [])].join("\n"), ...(url ? { url } : {}) };
		case "loop_report":
			return data.status === "blocked" ? { type: "loop_blocked", title: `Loop ${String(data.loop)} blocked`, text: String(data.note ?? "") } : undefined;
		case "loop_budget":
			return { type: "budget_hit", title: `Loop ${String(data.loop)} hit its budget`, text: String(data.note ?? "") };
		case "tick_error":
			return { type: "tick_error", title: `pr_tick failed on ${pr}`, text: String(data.error ?? ""), ...(url ? { url } : {}) };
		default:
			return undefined;
	}
}

/** Independent review verdicts, by `owner/repo#number@headSha`, so a review runs once per exact head commit. */
export const Reviews = defineDoc<{ byHead: Record<string, { approve: boolean; reasons: string[]; at: number }> }>({
	kind: "pdl.reviews",
	version: 1,
	scope: "session",
	initial: () => ({ byHead: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});

/** Human approvals (`pd approve`), by `owner/repo#number`, pinned to the head SHA that was approved. */
export const Approvals = defineDoc<{ byPr: Record<string, { sha: string; at: number }> }>({
	kind: "pdl.approvals",
	version: 1,
	scope: "session",
	initial: () => ({ byPr: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});

/** Parked PRs already reported, by review key, so a park notifies once per head commit and description. */
export const Parked = defineDoc<{ byKey: Record<string, number> }>({
	kind: "pdl.parked",
	version: 1,
	scope: "session",
	initial: () => ({ byKey: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});

/** Work branches by `owner/repo:branch`: which session owns each, and when the daemon last pushed it. */
export const Branches = defineDoc<{ byRef: Record<string, { session: string; pushedAt: number; sha: string }> }>({
	kind: "pdl.branches",
	version: 1,
	scope: "session",
	initial: () => ({ byRef: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});
