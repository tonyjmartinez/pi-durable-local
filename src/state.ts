// Session-scoped durable documents: every conversation in the daemon reads and writes the same copies.
import { appendFileSync } from "node:fs";
import { defineDoc } from "@earendil-works/pi-durable";
import { AUDIT_LOG } from "./config.ts";

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
	/** Session cost when the loop started, so the budget counts only the loop's own spend. */
	costAtStart: number;
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
}
