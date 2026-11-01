// Loops take turns. A loop whose gate says "wake" still waits for a slot: at most `maxConcurrent` iterations run at
// once, spend is paced across the day, and among loops waiting for a slot the highest priority (then the longest
// waiting) goes first. Pure functions; the loop task calls them and records `waitingSince` / `inFlightSince`.

/** 1 is most urgent, 5 least. */
export type Priority = 1 | 2 | 3 | 4 | 5;
export const PRIORITY_NAMES: Record<string, Priority> = { urgent: 1, high: 2, normal: 3, low: 4, idle: 5 };

/** An in-flight mark older than this is a leftover from a crash, not a running iteration. */
export const STALE_IN_FLIGHT_MS = 2 * 60 * 60_000;
/** How soon a loop waiting for its turn looks again (gate facts only, no model call). */
export const QUEUE_RECHECK_MINUTES = 10;

export type QueueLoop = {
	id: string;
	status: string;
	kind?: string;
	priority?: number;
	waitingSince?: number;
	inFlightSince?: number;
};

/** A loop's priority: its own, else by kind (owner requests and the budget check first, maintenance last). */
export function priorityOf(loop: Pick<QueueLoop, "priority" | "kind">): Priority {
	if (loop.priority !== undefined && Number.isInteger(loop.priority) && loop.priority >= 1 && loop.priority <= 5) return loop.priority as Priority;
	switch (loop.kind) {
		case "request":
			return 2;
		case "budget-review":
		case "assistant":
		case "infra":
			return 2;
		case "friction-sweep":
		case "ci-health":
		case "code-quality":
		case "cleanup":
		case "devils-advocate":
		case "business-review":
		case "strategy":
			return 4;
		default:
			return 3;
	}
}

/** Parse "1".."5" or a name (urgent, high, normal, low, idle). Undefined when it is neither. */
export function parsePriority(raw: unknown): Priority | undefined {
	if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 5) return raw as Priority;
	if (typeof raw !== "string") return undefined;
	const text = raw.trim().toLowerCase();
	if (/^[1-5]$/.test(text)) return Number(text) as Priority;
	return PRIORITY_NAMES[text];
}

const inFlight = (loop: QueueLoop, now: number) =>
	loop.status === "active" && loop.inFlightSince !== undefined && now - loop.inFlightSince < STALE_IN_FLIGHT_MS;

/** Turn order: priority, then who has waited longest, then id. Negative when `a` goes first. */
export function compareTurn(a: QueueLoop, b: QueueLoop, now: number): number {
	return priorityOf(a) - priorityOf(b) || (a.waitingSince ?? now) - (b.waitingSince ?? now) || a.id.localeCompare(b.id, "en", { numeric: true });
}

export type TurnInput = {
	loop: QueueLoop;
	loops: readonly QueueLoop[];
	now: number;
	/** 0 or less: no limit. */
	maxConcurrent: number;
	/** Spend in the last hour, all pi sessions. */
	hourSpend: number;
	/** Undefined: no pacing. */
	hourAllowance?: number;
	/** The pacing window `hourSpend` and `hourAllowance` cover. Default 1. */
	paceWindowHours?: number;
};

export type Turn = { start: true } | { start: false; reason: string };

/**
 * May this loop start an iteration now? No when every slot is busy, when the last hour already used the paced
 * allowance, or when a waiting loop is ahead of it in turn order. A loop that is waiting itself must also count as
 * waiting (`waitingSince` set) for others to queue behind it, which the caller records when this says no.
 */
export function takeTurn(input: TurnInput): Turn {
	const { loop, loops, now } = input;
	const others = loops.filter((other) => other.id !== loop.id);
	const running = others.filter((other) => inFlight(other, now));
	if (input.maxConcurrent > 0 && running.length >= input.maxConcurrent) {
		return { start: false, reason: `queued: ${running.length} of ${input.maxConcurrent} slots busy (${running.map((other) => other.id).join(", ")})` };
	}
	if (input.hourAllowance !== undefined && input.hourAllowance > 0 && input.hourSpend >= input.hourAllowance) {
		const window = input.paceWindowHours === undefined || input.paceWindowHours === 1 ? "hour" : `${input.paceWindowHours}h`;
		return { start: false, reason: `queued: pacing, $${input.hourSpend.toFixed(2)} spent in the last ${window} (allowance $${input.hourAllowance.toFixed(2)})` };
	}
	const me = { ...loop, waitingSince: loop.waitingSince ?? now };
	const ahead = others
		.filter((other) => other.status === "active" && other.waitingSince !== undefined && !inFlight(other, now))
		.filter((other) => compareTurn(other, me, now) < 0)
		.sort((a, b) => compareTurn(a, b, now));
	// Only as many loops as there are free slots get to go; the rest wait for the ones ahead.
	const free = input.maxConcurrent > 0 ? input.maxConcurrent - running.length : Number.POSITIVE_INFINITY;
	if (ahead.length >= free) return { start: false, reason: `queued behind ${ahead[0]!.id} (priority ${priorityOf(ahead[0]!)})` };
	return { start: true };
}

/** The queue as a person reads it: running first, then waiting in turn order, then everything else by next run. */
export function queueOrder<T extends QueueLoop & { nextRunAt?: number }>(loops: readonly T[], now: number): { loop: T; state: "running" | "waiting" | "scheduled" }[] {
	const active = loops.filter((loop) => loop.status === "active");
	const running = active.filter((loop) => inFlight(loop, now));
	const waiting = active.filter((loop) => !inFlight(loop, now) && loop.waitingSince !== undefined).sort((a, b) => compareTurn(a, b, now));
	const rest = active
		.filter((loop) => !inFlight(loop, now) && loop.waitingSince === undefined)
		.sort((a, b) => priorityOf(a) - priorityOf(b) || (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0));
	return [
		...running.map((loop) => ({ loop, state: "running" as const })),
		...waiting.map((loop) => ({ loop, state: "waiting" as const })),
		...rest.map((loop) => ({ loop, state: "scheduled" as const })),
	];
}

/** The goal for an owner request: one bounded task, finished in as few iterations as it takes. */
export function requestGoal(text: string): string {
	return `Owner request (a one-off task, not an ongoing goal): ${text.trim()}

Do exactly this, in as few iterations as it takes, as small verified PRs under the factory's usual rules. When it is fully done (merged, or parked for Tony with a clear note), call loop_report with status "done". If it is ambiguous or blocked, report "blocked" with the single concrete question.`;
}
