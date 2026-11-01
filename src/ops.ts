// The daemon's request handling, minus the daemon: validation, defaults and edits as pure functions, and the few
// operations that touch tasks or files through an injected interface. Importing this starts nothing, so every piece
// can be tested without opening the store or a socket.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { LOOP_PROMPTS, LOOP_SCHEDULE, type LoopPreset } from "./loopgate.ts";
import type { Loop, Memory } from "./state.ts";

export class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Sessions and memory

const SESSION_NAME = /^[a-z0-9][a-z0-9._-]{0,40}$/i;

/** A session name as typed: trimmed, letters, digits, `.`, `_`, `-`, at most 41 characters. */
export function validateSessionName(raw: unknown): string {
	const name = String(raw ?? "").trim();
	if (!SESSION_NAME.test(name)) throw new HttpError(400, "name: letters, digits, . _ - (max 41)");
	return name;
}

export function sendMode(body: Record<string, unknown>): "steer" | "followUp" {
	return body.mode === "steer" ? "steer" : "followUp";
}

/** A memory added by hand with `pd mem add`. */
export function newMemory(body: Record<string, unknown>, id: string, now: number): Memory {
	return {
		id,
		topic: String(body.topic ?? "note"),
		text: String(body.text ?? ""),
		tags: [],
		by: "tony",
		updatedAt: now,
		...(typeof body.project === "string" ? { project: resolve(body.project) } : {}),
	};
}

// ---------------------------------------------------------------------------------------------------------------
// The audit log

/** The last `count` entries, reading only the final `maxBytes` of the file and skipping torn or garbled lines. */
export function auditTail(file: string, count: number, maxBytes = 512 * 1024): unknown[] {
	// slice(-0) would be the whole array.
	if (!(count > 0)) return [];
	const size = statSync(file).size;
	const start = Math.max(0, size - maxBytes);
	const text = readFileSync(file).subarray(start).toString("utf8");
	// Starting mid-file means the first line is probably cut in two: drop it.
	return text.split("\n").slice(start > 0 ? 1 : 0).filter(Boolean).slice(-count).flatMap((line) => {
		try {
			return [JSON.parse(line)];
		} catch {
			return [];
		}
	});
}

// ---------------------------------------------------------------------------------------------------------------
// Approving a parked PR

export type Approval = { repo: string; number: number; expected: string };

/** `pd approve <repo> <pr> <sha7>`: the commit must be named, as the person saw it in the park comment. */
export function parseApproval(body: Record<string, unknown>): Approval {
	const repo = String(body.repo ?? "");
	const number = Number(body.number);
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.split("/").some((part) => part === "." || part === "..")) throw new HttpError(400, "repo must be owner/name");
	if (!Number.isSafeInteger(number) || number <= 0) throw new HttpError(400, "PR number must be a positive integer");
	const expected = String(body.sha ?? "").toLowerCase();
	if (!/^[0-9a-f]{7,40}$/.test(expected)) throw new HttpError(400, "pass the commit you reviewed: pd approve <repo> <pr> <sha7> (shown in the park comment)");
	return { repo, number, expected };
}

/** The approval binds the commit that was seen; if the agent pushed since, the person must look again. */
export function assertApprovedHead(head: string, expected: string): void {
	if (!head.startsWith(expected)) throw new HttpError(409, `PR head is now ${head.slice(0, 7)}, not ${expected}; review the new commit first`);
}

// ---------------------------------------------------------------------------------------------------------------
// Loops

export type LoopRequest = { session?: string; goal?: string; preset?: string; intervalMinutes?: number; maxIterations?: number; budgetUsd?: number };
export type LoopSpec = { goal: string; preset?: LoopPreset; intervalMinutes?: number; maxIterations?: number; budgetUsd?: number };
export type LoopDefaults = { defaultBudgetUsd: number; defaultIntervalMinutes: number; defaultMaxIterations: number };

/** What a request may ask for. The settings route enforces the same floor for the interval. */
export const LOOP_LIMITS = { intervalMinutes: [5, 60 * 24 * 30], maxIterations: [1, 1000], budgetUsd: [0.01, 1000] } as const;

const clamp = (value: number | undefined, [min, max]: readonly [number, number]): number | undefined =>
	value === undefined || !Number.isFinite(value) ? undefined : Math.min(Math.max(value, min), max);

/**
 * A loop request, resolved: a preset supplies the goal and the interval (unless one was given), a missing goal is
 * refused, and every number is clamped (a non-number falls back to the policy default later, by being undefined).
 */
export function resolveLoopSpec(body: LoopRequest): LoopSpec {
	let goal = body.goal;
	let intervalMinutes = body.intervalMinutes;
	let preset: LoopPreset | undefined;
	if (body.preset !== undefined) {
		if (typeof body.preset !== "string" || !Object.hasOwn(LOOP_PROMPTS, body.preset)) {
			throw new HttpError(400, `unknown preset; one of ${Object.keys(LOOP_PROMPTS).join(", ")}`);
		}
		preset = body.preset as LoopPreset;
		goal = LOOP_PROMPTS[preset];
		intervalMinutes ??= LOOP_SCHEDULE[preset].intervalMinutes;
	}
	if (!goal) throw new HttpError(400, "goal is required");
	return {
		goal,
		...(preset === undefined ? {} : { preset }),
		intervalMinutes: clamp(intervalMinutes, LOOP_LIMITS.intervalMinutes),
		maxIterations: clamp(body.maxIterations, LOOP_LIMITS.maxIterations),
		budgetUsd: clamp(body.budgetUsd, LOOP_LIMITS.budgetUsd),
	};
}

/** A preset loop is one per session: a second ci-health or code-quality loop on the same repo only doubles the spend. */
export function assertNoTwin(loops: Iterable<Pick<Loop, "id" | "session" | "kind" | "status">>, session: string, spec: LoopSpec): void {
	if (spec.preset === undefined) return;
	const kind = LOOP_SCHEDULE[spec.preset].kind;
	const twin = [...loops].find((loop) => loop.session === session && loop.kind === kind && (loop.status === "active" || loop.status === "paused"));
	if (twin) throw new HttpError(409, `loop ${twin.id} is already a ${kind} loop on ${session}; resume or stop it instead`);
}

/** Resuming must not bring back a loop that another live loop of the same kind replaced on its session. */
export function assertNoTwinOnResume(loops: Iterable<Pick<Loop, "id" | "session" | "kind" | "status">>, loop: Pick<Loop, "id" | "session" | "kind">): void {
	if (loop.kind === undefined) return;
	const twin = [...loops].find((other) => other.id !== loop.id && other.session === loop.session && other.kind === loop.kind && other.status === "active");
	if (twin) throw new HttpError(409, `loop ${twin.id} is already the live ${loop.kind} loop on ${loop.session}; stop it first to resume ${loop.id}`);
}

/** A new loop record. The caller creates its task and stores it. */
export function newLoop(input: { id: string; session: string; spec: LoopSpec; defaults: LoopDefaults; costAtStart: number; now: number }): Loop {
	const { spec, defaults } = input;
	const schedule = spec.preset === undefined ? undefined : LOOP_SCHEDULE[spec.preset];
	return {
		id: input.id,
		session: input.session,
		goal: spec.goal,
		intervalMinutes: spec.intervalMinutes ?? defaults.defaultIntervalMinutes,
		maxIterations: spec.maxIterations ?? defaults.defaultMaxIterations,
		// A preset with its own budget (the maintenance loops) is capped below the product default.
		budgetUsd: spec.budgetUsd ?? schedule?.budgetUsd ?? defaults.defaultBudgetUsd,
		iteration: 0,
		status: "active",
		note: "",
		createdAt: input.now,
		nextRunAt: input.now,
		costAtStart: input.costAtStart,
		...(schedule === undefined ? {} : { kind: schedule.kind, ...(schedule.skipIfIdleHours ? { skipIfIdleHours: schedule.skipIfIdleHours } : {}) }),
	};
}

/** `pd loop set`: only sane values are applied; the rest are ignored. Mutates the loop it is given (a draft). */
export function applyLoopSettings(loop: Loop, body: Record<string, unknown>): void {
	if (typeof body.intervalMinutes === "number" && body.intervalMinutes >= LOOP_LIMITS.intervalMinutes[0]) loop.intervalMinutes = body.intervalMinutes;
	if (typeof body.maxIterations === "number" && body.maxIterations >= 1) loop.maxIterations = body.maxIterations;
	if (typeof body.budgetUsd === "number" && body.budgetUsd > 0) loop.budgetUsd = body.budgetUsd;
}

/** What pause and stop record on the loop. */
export function stopPatch(action: "pause" | "stop"): { status: "done" | "paused"; note: string } {
	return action === "stop" ? { status: "done", note: "stopped by user" } : { status: "paused", note: "paused by user" };
}

/** An active, awake loop already has a task: resuming it would start a second one. A dormant one is woken. */
export function assertResumable(loop: Pick<Loop, "id" | "status" | "dormant">): void {
	if (loop.status === "active" && loop.dormant === undefined) throw new HttpError(409, `loop ${loop.id} is already active`);
}

/** Resume: a fresh budget window, scheduled now. Mutates the loop it is given (a draft); the caller sets `taskId`. */
export function applyResume(loop: Loop, cost: number, now: number): void {
	Object.assign(loop, { status: "active", note: "resumed", nextRunAt: now });
	// Resuming is also how a person wakes a dormant loop.
	delete loop.dormant;
	delete loop.idleReported;
	loop.noopStreak = 0;
	loop.costAtStart = cost;
	// A resumed loop gets a fresh budget window.
	loop.spent = 0;
}

/** The slice of the harness that ending a loop's task needs. Methods, so a real harness fits it. */
export interface TaskControl {
	getTask(id: never, context: never): Promise<{ state: { status: string } } | undefined>;
	abortTask(id: never, context: never): Promise<unknown>;
	waitForTask(id: never, context: never): Promise<unknown>;
}

/**
 * End the loop's task if it is still alive, so only one task runs a loop. Pausing aborts and moves on; resuming also
 * waits for the abort to land. Returns whether a live task was aborted.
 */
export async function endLiveTask(tasks: TaskControl, taskId: number | undefined, context: unknown, options: { wait: boolean }): Promise<boolean> {
	if (taskId === undefined) return false;
	const task = await tasks.getTask(taskId as never, context as never);
	if (task === undefined || task.state.status === "terminal") return false;
	await tasks.abortTask(taskId as never, context as never);
	if (options.wait) await tasks.waitForTask(taskId as never, context as never);
	return true;
}

// ---------------------------------------------------------------------------------------------------------------
// `pd factory`

const REPO = /^[\w.-]+\/[\w.-]+$/;
const PROJECT_NAME = /^[a-z0-9][a-z0-9._-]{0,40}$/;

/** `owner/name`, with no `.` or `..` part that could point the clone outside the projects directory. */
export function parseRepo(raw: unknown): { repo: string; owner: string; name: string } {
	const repo = String(raw ?? "");
	if (!REPO.test(repo) || repo.split("/").some((part) => part === "." || part === "..")) throw new HttpError(400, "repo must be owner/name");
	const [owner, name] = repo.split("/") as [string, string];
	return { repo, owner, name };
}

/** The session name for a project: given, or the repo name without its extension; lowercase, and a safe name. */
export function projectSessionName(repoName: string, given: unknown): string {
	const name = String(given ?? repoName.replace(/\.[a-z]+$/i, "")).toLowerCase();
	if (!PROJECT_NAME.test(name) || name.includes("..")) throw new HttpError(400, "invalid session name");
	return name;
}

/** Where a repo is cloned: its name under the first writable root (`~` expanded). */
export function projectDir(writableRoot: string, repoName: string, home: string): string {
	return resolve(writableRoot.replace(/^~(?=\/|$)/, home), repoName);
}

/** Cloning runs with the daemon's credentials: no hooks, no global or system config, no prompts. */
export function cloneArgs(repo: string, dir: string): string[] {
	return ["-c", "core.hooksPath=/dev/null", "clone", "--quiet", `git@github.com:${repo}.git`, dir];
}

export function cloneEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return { ...base, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
}

type PolicyJson = { automerge?: { repos?: string[]; baseBranches?: Record<string, string>; [key: string]: unknown }; [key: string]: unknown };

/** The policy with this project's base branch and, if asked, its merge allowlist entry applied. Pure; the input is not changed. */
export function editProjectPolicy(policy: PolicyJson, change: { repo: string; baseBranch?: string; merge?: boolean }): { policy: PolicyJson; mergeEnabled: boolean } {
	const edited: PolicyJson = { ...policy, automerge: { ...policy.automerge } };
	const automerge = edited.automerge!;
	// Where PRs for this repo should land, for repos whose GitHub default isn't the deploy branch.
	if (change.baseBranch) automerge.baseBranches = { ...automerge.baseBranches, [change.repo]: change.baseBranch };
	// The person running `pd factory --merge` is the approval.
	if (change.merge) automerge.repos = [...new Set([...(automerge.repos ?? []), change.repo])];
	return { policy: edited, mergeEnabled: Boolean(change.merge) };
}

/** Apply a project's policy change to the policy file; nothing is read or written when there is nothing to change. */
export function updateProjectPolicy(file: string, change: { repo: string; baseBranch?: string; merge?: boolean }): { mergeEnabled: boolean } | undefined {
	if (!change.baseBranch && !change.merge) return undefined;
	const { policy, mergeEnabled } = editProjectPolicy(JSON.parse(readFileSync(file, "utf8")) as PolicyJson, change);
	writeFileSync(file, `${JSON.stringify(policy, null, "\t")}\n`);
	return { mergeEnabled };
}
