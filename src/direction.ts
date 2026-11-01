// Per-repo DIRECTION: a versioned instruction from a general that every loop on the repo must see and acknowledge.
// Pure bookkeeping, tested without a model or network (test/direction.test.ts). The daemon owns the durable doc.

export type Ack = { status: "pending" | "acked"; at: number };
export type Direction = {
	version: number;
	text: string;
	by: string;
	at: number;
	/** Per loop id: has it reported working under the current version? */
	acks: Record<string, Ack>;
	history: { version: number; text: string; by: string; at: number }[];
};
export type DirectionState = { byKey: Record<string, Direction> };

/** A repo's identity: owner/repo when the session has a GitHub remote, else the session name. */
export function directionKey(session: string, repo: string | undefined): string {
	return repo ?? session;
}

type LoopLike = { id: string; nextTask?: string; status?: string; dormant?: unknown; idleReported?: boolean; noopStreak?: number; nextRunAt?: number };

/** Set a new direction: bump the version, keep history, clear stale handoffs, mark every loop pending. Returns loops that were dormant. */
export function applyDirection(state: DirectionState, key: string, input: { text: string; by: string; now: number }, loops: LoopLike[]): { direction: Direction; woken: string[] } {
	const text = input.text.trim();
	if (text === "") throw new Error("direction text is empty");
	const old = state.byKey[key];
	const direction: Direction = { version: (old?.version ?? 0) + 1, text, by: input.by, at: input.now, acks: {}, history: [...(old?.history ?? []), ...(old ? [{ version: old.version, text: old.text, by: old.by, at: old.at }] : [])] };
	const woken: string[] = [];
	for (const loop of loops) {
		delete loop.nextTask;
		direction.acks[loop.id] = { status: "pending", at: input.now };
		if (loop.status === "active" && loop.dormant !== undefined) {
			delete loop.dormant;
			delete loop.idleReported;
			loop.noopStreak = 0;
			loop.nextRunAt = input.now;
			woken.push(loop.id);
		}
	}
	state.byKey[key] = direction;
	return { direction, woken };
}

/** The agent reported the version it worked under. True when that is the current one (and it is recorded). */
export function recordAck(direction: Direction | undefined, loopId: string, version: number | undefined, now: number): boolean {
	if (direction === undefined || version !== direction.version) return false;
	direction.acks[loopId] = { status: "acked", at: now };
	return true;
}

const when = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ") + "Z";

/** Whether this loop still has to act on the current direction (first iteration after a bump). */
export const needsPivot = (direction: Direction | undefined, loopId: string) => direction !== undefined && direction.acks[loopId]?.status === "pending";

/** Open PRs that were created before the direction was set. */
export function prsPredating<T extends { createdAt?: number }>(prs: readonly T[], direction: Direction): T[] {
	return prs.filter((pr) => pr.createdAt !== undefined && pr.createdAt < direction.at);
}

/** Text placed above the goal in every loop prompt; empty when the repo has no direction. */
export function directionPrompt(direction: Direction | undefined, loopId: string, oldPrs: readonly { number: number }[] = []): string {
	if (direction === undefined) return "";
	let out = `Current direction v${direction.version} (set by ${direction.by}, ${when(direction.at)}): ${direction.text}\nIt overrides the goal and any handoff where they conflict. Pass directionVersion: ${direction.version} to loop_report to confirm you worked under it.\n\n`;
	if (needsPivot(direction, loopId)) {
		out += "The direction just changed. This first iteration: ";
		out += oldPrs.length > 0
			? `your open PRs created before the change are ${oldPrs.map((pr) => `#${pr.number}`).join(", ")}; keep, rework or close each against the new direction. `
			: "you have no open PRs from before the change. ";
		out += "Also update project memory and any roadmap so they no longer point the old way.\n\n";
	}
	return out;
}

export type PivotLoop = { id: string; session: string; status: string; dormant?: boolean; lastRunAt?: number };
export type PivotDirection = { key: string; version: number; text: string; by: string; at: number; acks: Record<string, Ack> };
export const PIVOT_WINDOW = 48 * 3_600_000;
export const PIVOT_PENDING_LIMIT = 2 * 3_600_000;

const clip = (text: string, n: number) => (text.length <= n ? text : `${text.slice(0, n - 1)}…`);

/** Loops that need a general: finished an iteration after the bump without acking, or pending 2h after it. */
export function pivotStale(dir: PivotDirection, loops: readonly PivotLoop[], now: number): { loop: PivotLoop; why: string }[] {
	const out: { loop: PivotLoop; why: string }[] = [];
	for (const loop of loops) {
		if (loop.status !== "active" || dir.acks[loop.id]?.status !== "pending") continue;
		if (loop.lastRunAt !== undefined && loop.lastRunAt > dir.at) out.push({ loop, why: `finished an iteration after ${dir.key} direction v${dir.version} without acknowledging it` });
		else if (now - dir.at > PIVOT_PENDING_LIMIT) out.push({ loop, why: `still pending on ${dir.key} direction v${dir.version} after ${Math.floor((now - dir.at) / 3_600_000)}h` });
	}
	return out;
}

/** The PIVOTS section lines (empty when no direction was set in the last 48h). */
export function pivotLines(directions: readonly PivotDirection[], loops: readonly PivotLoop[], now: number): string[] {
	const recent = directions.filter((d) => now - d.at <= PIVOT_WINDOW);
	if (recent.length === 0) return [];
	const lines = ["", "PIVOTS (directions set in the last 48h)"];
	for (const dir of recent) {
		lines.push(`- ${dir.key} v${dir.version} by ${dir.by}, ${when(dir.at)}: ${clip(dir.text, 160)}`);
		const mine = loops.filter((l) => l.status === "active" && dir.acks[l.id] !== undefined);
		if (mine.length === 0) lines.push("    no active loops");
		for (const loop of mine) lines.push(`    ${loop.id} ${loop.session}${loop.dormant ? " (dormant)" : ""}: ${dir.acks[loop.id]!.status}`);
	}
	return lines;
}
