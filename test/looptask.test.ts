// LoopTask's phases (wait, run, await, abort) driven by a fake runtime and a fake harness: no daemon, no store.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { UsageDoc } from "@earendil-works/pi-durable";
import { makeFakeGh, makeStore, readAudit } from "./fakegh.helper.ts";

const root = mkdtempSync(join(tmpdir(), "pd-loop-"));
process.env.PD_DATA_DIR = join(root, "data");
process.env.PD_CONFIG_DIR = join(root, "cfg");
delete process.env.PD_NOTIFY_URL;
mkdirSync(process.env.PD_DATA_DIR, { recursive: true });
mkdirSync(process.env.PD_CONFIG_DIR, { recursive: true });
const AUDIT = join(process.env.PD_DATA_DIR, "audit.jsonl");

const gh = makeFakeGh(join(root, "fake"));
const ext = await import("../src/extensions.ts");
const { Loops, Sessions, Subagents } = await import("../src/state.ts");
type Loop = import("../src/state.ts").Loop;

const phases = ext.LoopTask.definition.phases as Record<"wait" | "run" | "await", (task: unknown, runtime: unknown, context: unknown) => Promise<unknown>>;
const initial = ext.LoopTask.definition.initial as unknown as (input: { loopId: string }) => Record<string, unknown>;
const abort = ext.LoopTask.definition.abort as (task: unknown, runtime: unknown, context: unknown) => Promise<unknown>;

type Directive = { status: string; checkpoint?: Record<string, unknown>; outcome?: { status: string; result?: { iterations: number } } } | undefined;

let store: ReturnType<typeof makeStore>;
let usage: Record<number, unknown>;
let submissions: Map<string, { id: number }>;
let submits: { requestId: string; content: string; entry: { kind: string; data: Record<string, unknown> } }[];
let settle: { status: string };
let waits: number;
let conversationExists: boolean;
let directives: Directive[];
let sleeps: { until: number; checkpoint: Record<string, unknown> }[];
let failNextCommit: boolean;
/** Tasks `inspect()` reports; a busy session has one that is not a background task. */
let busyTasks: { record: { background: boolean; conversationId: number } }[];
/** The conversation's recent entries, newest first, as `entries()` returns them. */
let recentEntries: { kind: string }[];
let resets: string[];
let entriesCalls: number;
/** What the fake conversation was asked to do, in order. */
let order: string[];
/** What a reset does to the session's measured cost (a reset itself can cost a little). */
let resetAddsCost: number;
let currentModel = "anthropic/claude-sonnet-5-5";

const cost = (total: number) => ({ models: { m: { cost: { total } } }, tools: {} });
const context = {} as never;
const task = (checkpoint: Record<string, unknown>, loopId = "L1") => ({ input: { loopId }, state: { checkpoint } });
const loopDoc = (id = "L1") => store.peek<{ byId: Record<string, Loop> }>(Loops).byId[id];
const events = () => readAudit(AUDIT);
const near = (actual: number, expected: number, within = 5_000) => assert.ok(Math.abs(actual - expected) < within, `${actual} is not within ${within} of ${expected}`);

const runtime = () => ({
	snapshot: async (doc: unknown, ...rest: unknown[]) => (doc === UsageDoc ? usage[rest[0] as number] : store.snapshot(doc as never)),
	commit: async (callback: (tx: { doc: (doc: never) => Promise<unknown> }) => unknown) => {
		if (failNextCommit) {
			failNextCommit = false;
			throw new Error("process died before the checkpoint committed");
		}
		const directive = (await callback({ doc: async (doc) => store.peek(doc) })) as Directive;
		directives.push(directive);
		return directive;
	},
	sleepUntil: async (until: number, checkpoint: Record<string, unknown>) => {
		sleeps.push({ until, checkpoint });
	},
});

const baseLoop = (change: Partial<Loop> = {}): Loop => ({
	id: "L1", session: "s1", goal: "Improve the thing", intervalMinutes: 60, maxIterations: 5, budgetUsd: 3, iteration: 0, status: "active",
	note: "", createdAt: 0, nextRunAt: 1_000, costAtStart: 0, ...change,
});

function setup(options: { loop?: Partial<Loop> | null; remote?: string | null; session?: boolean } = {}) {
	if (options.loop !== null) store.seed(Loops, { byId: { L1: baseLoop(options.loop) }, nextId: 2 });
	const sessions = options.session === false ? {} : { s1: { conversationId: 1, cwd: "/work/r", purpose: "", createdAt: 0, ...(options.remote === null ? {} : { remote: options.remote ?? undefined }) } };
	store.seed(Sessions, { byName: sessions });
}

beforeEach(() => {
	store = makeStore();
	usage = { 1: cost(0) };
	submissions = new Map();
	submits = [];
	settle = { status: "done" };
	waits = 0;
	conversationExists = true;
	directives = [];
	sleeps = [];
	failNextCommit = false;
	busyTasks = [];
	recentEntries = [];
	resets = [];
	entriesCalls = 0;
	order = [];
	resetAddsCost = 0;
	currentModel = "anthropic/claude-sonnet-5-5";
	writeFileSync(AUDIT, "");
	writeFileSync(join(process.env.PD_CONFIG_DIR!, "policy.json"), "{}");
	gh.script([]);
	let next = 100;
	ext.setHarness({
		inspect: async () => ({ tasks: busyTasks }),
		commit: async (callback: (tx: unknown) => unknown) => callback({ submissionByRequest: async (conversation: number, requestId: string) => submissions.get(`${conversation}:${requestId}`) }),
		conversation: async (id: number) =>
			conversationExists
				? {
						entries: async () => {
							entriesCalls++;
							return { items: recentEntries };
						},
						reset: async (handoff: string) => {
							order.push("reset");
							resets.push(handoff);
							usage[1] = cost(((usage[1] as { models: { m: { cost: { total: number } } } })?.models?.m?.cost?.total ?? 0) + resetAddsCost);
						},
						agent: async () => ({ model: { provider: currentModel.split("/")[0], modelId: currentModel.split("/").slice(1).join("/") } }),
						configure: async (change: { model: { provider: string; modelId: string } }) => {
							order.push("configure");
							currentModel = `${change.model.provider}/${change.model.modelId}`;
						},
						submit: async (input: { requestId: string; content: string; entry: { kind: string; data: Record<string, unknown> } }) => {
							order.push("submit");
							submits.push({ requestId: input.requestId, content: input.content, entry: input.entry });
							const key = `${id}:${input.requestId}`;
							if (!submissions.has(key)) submissions.set(key, { id: next++ });
							return submissions.get(key);
						},
					}
				: undefined,
		submission: async () => ({
			wait: async () => {
				waits++;
				return settle;
			},
		}),
	} as never);
});

const REMOTE = "git@github.com:o/r.git";
const BASE_SHA = "b".repeat(40);
const recent = () => new Date(Date.now() - 2 * 3_600_000).toISOString();

/** Script the GitHub reads the loop gate makes. */
function gate(options: { baseSha?: string; at?: string; prs?: { number: number; sha: string; branch?: string; check: "success" | "in_progress" | "failure" }[]; frictionIssues?: number; baseFails?: boolean; issues?: { updatedAt: string }[] } = {}) {
	const prs = options.prs ?? [];
	gh.script([
		{ match: "^repo view o/r --json defaultBranchRef", responses: ["main\n"] },
		{ match: "^api repos/o/r/commits/main --jq", responses: [options.baseFails ? { code: 1, stderr: "HTTP 502" } : JSON.stringify({ sha: options.baseSha ?? BASE_SHA, at: options.at ?? recent() })] },
		{ match: "^api user --jq \\.login$", responses: ["factorybot\n"] },
		{ match: "^pr list --repo o/r --author factorybot", responses: [JSON.stringify(prs.map((pr) => ({ number: pr.number, headRefOid: pr.sha, headRefName: pr.branch ?? "pd/x" })))] },
		...prs.map((pr) => ({
			match: `commits/${pr.sha}/check-runs`,
			responses: [`${JSON.stringify({ name: "ci", status: pr.check === "in_progress" ? "in_progress" : "completed", conclusion: pr.check === "in_progress" ? null : pr.check, app: { slug: "github-actions" } })}\n`],
		})),
		{ match: "/status\\?per_page=100$", responses: [JSON.stringify({ statuses: [] })] },
		{ match: "^issue list --repo o/r --label friction", responses: [`${options.frictionIssues ?? 0}\n`] },
		{ match: "^issue list --repo o/r --state open --limit 200", responses: [JSON.stringify(options.issues ?? [])] },
	]);
}

describe("the task definition", () => {
	it("starts at the first iteration's run phase", () => {
		assert.deepEqual(initial({ loopId: "L1" }), { phase: "run", iteration: 0 });
		assert.equal(ext.LoopTask.definition.name, "pdl.loop");
	});
});

describe("wait phase", () => {
	it("sleeps until the loop is due, then runs the loop's current iteration", async () => {
		setup({ loop: { nextRunAt: 123_456, iteration: 2 } });
		await phases.wait(task({ phase: "wait" }), runtime(), context);
		assert.deepEqual(sleeps, [{ until: 123_456, checkpoint: { phase: "run", iteration: 2 } }]);
		assert.deepEqual(directives, []);
	});

	it("runs at once when no time was set", async () => {
		setup({ loop: { nextRunAt: undefined } });
		await phases.wait(task({ phase: "wait" }), runtime(), context);
		near(sleeps[0]!.until, Date.now());
	});

	it("ends the task when the loop is no longer active, or gone", async () => {
		for (const status of ["paused", "done", "failed"] as const) {
			store = makeStore();
			setup({ loop: { status, iteration: 4 } });
			directives = [];
			sleeps = [];
			await phases.wait(task({ phase: "wait" }), runtime(), context);
			assert.deepEqual(directives, [{ status: "terminal", outcome: { status: "completed", result: { iterations: 4 } } }], status);
			assert.deepEqual(sleeps, []);
		}
		store = makeStore();
		setup({ loop: null });
		directives = [];
		await phases.wait(task({ phase: "wait" }), runtime(), context);
		assert.deepEqual(directives, [{ status: "terminal", outcome: { status: "completed", result: { iterations: 0 } } }]);
	});
});

describe("abort", () => {
	it("pauses an active loop and ends the task as aborted", async () => {
		setup();
		await abort(task({ phase: "wait" }), runtime(), context);
		assert.equal(loopDoc()!.status, "paused");
		assert.equal(loopDoc()!.note, "stopped");
		assert.deepEqual(directives, [{ status: "terminal", outcome: { status: "aborted" } }]);
	});

	it("leaves a loop that is not active as it was", async () => {
		setup({ loop: { status: "done", note: "stopped by user" } });
		await abort(task({ phase: "wait" }), runtime(), context);
		assert.equal(loopDoc()!.status, "done");
		assert.equal(loopDoc()!.note, "stopped by user");
		assert.equal(directives[0]!.outcome!.status, "aborted");
	});

	it("still ends the task when the loop was removed", async () => {
		setup({ loop: null });
		await abort(task({ phase: "wait" }), runtime(), context);
		assert.equal(directives[0]!.outcome!.status, "aborted");
	});
});

describe("run phase: when to stop", () => {
	const run = (checkpoint: Record<string, unknown> = { phase: "run", iteration: 0 }) => phases.run(task(checkpoint), runtime(), context);

	it("ends quietly when the loop is gone or not active", async () => {
		setup({ loop: null });
		await run();
		assert.deepEqual(directives, [{ status: "terminal", outcome: { status: "completed", result: { iterations: 0 } } }]);
		assert.equal(submits.length, 0);
		directives = [];
		setup({ loop: { status: "paused", note: "paused by user", iteration: 2 } });
		await run();
		assert.equal(loopDoc()!.status, "paused");
		assert.equal(loopDoc()!.note, "paused by user");
		assert.equal(directives[0]!.status, "terminal");
		assert.equal(submits.length, 0);
	});

	it("fails the loop when its session is gone", async () => {
		setup({ session: false });
		await run();
		assert.equal(loopDoc()!.status, "failed");
		assert.equal(loopDoc()!.note, "session s1 no longer exists");
		assert.equal(directives[0]!.status, "terminal");
		assert.equal(submits.length, 0);
	});

	it("pauses at the budget and says so in the audit log", async () => {
		setup({ loop: { spent: 4 } });
		await run();
		assert.equal(loopDoc()!.status, "paused");
		assert.equal(loopDoc()!.note, "budget reached: $4.00 of $3");
		assert.equal(submits.length, 0);
		const entry = events().find((event) => event.event === "loop_budget");
		assert.match(String(entry?.note), /\$4\.00 of \$3; resume with pd loop resume L1/);
	});

	it("pauses exactly at the budget and runs just under it", async () => {
		setup({ loop: { spent: 3 } });
		await run();
		assert.equal(loopDoc()!.status, "paused");
		store = makeStore();
		setup({ loop: { spent: 2.99 } });
		await run();
		assert.equal(loopDoc()!.status, "active");
		assert.equal(submits.length, 1);
	});

	it("treats a loop that has spent nothing yet as at zero", async () => {
		setup();
		assert.equal(loopDoc()!.spent, undefined);
		await run();
		assert.equal(loopDoc()!.status, "active");
		assert.equal(submits.length, 1);
	});

	it("budgets the loop's own spend, whatever the session has spent in total", async () => {
		setup();
		usage[1] = cost(50);
		await run();
		assert.equal(loopDoc()!.status, "active", "a session that spent a lot elsewhere does not pause a loop that has not");
		assert.equal(submits.length, 1);
	});

	it("measures the session's cost, subagents included, before it submits", async () => {
		setup();
		usage[1] = cost(1);
		usage[2] = cost(2.5);
		store.seed(Subagents, { parentOf: { "2": "s1" } });
		await run();
		assert.equal((directives[0]!.checkpoint as { costBefore: number }).costBefore, 3.5);
	});

	it("does not count another session's subagents in that measure", async () => {
		setup();
		usage[1] = cost(1);
		usage[2] = cost(100);
		store.seed(Subagents, { parentOf: { "2": "other" } });
		await run();
		assert.equal(loopDoc()!.status, "active");
		assert.equal((directives[0]!.checkpoint as { costBefore: number }).costBefore, 1);
	});

	it("is done at the iteration cap", async () => {
		setup({ loop: { iteration: 5, maxIterations: 5 } });
		await run({ phase: "run", iteration: 5 });
		assert.equal(loopDoc()!.status, "done");
		assert.equal(loopDoc()!.note, "reached 5 iterations");
		assert.equal(submits.length, 0);
	});
});

describe("run phase: submitting an iteration", () => {
	const run = (checkpoint: Record<string, unknown> = { phase: "run", iteration: 0 }) => phases.run(task(checkpoint), runtime(), context);

	it("sends the prompt under a request id for this iteration, then checkpoints to await", async () => {
		setup({ remote: null });
		await run();
		assert.equal(submits.length, 1);
		assert.equal(submits[0]!.requestId, "loop:L1:0");
		assert.deepEqual(submits[0]!.entry, { kind: "pdl.loop-tick", data: { loopId: "L1", iteration: 0 } });
		assert.match(submits[0]!.content, /^\[loop L1, iteration 1\/5\]\nOngoing goal: Improve the thing/);
		assert.match(submits[0]!.content, /already covered by an open PR .* skip it and take the next unclaimed item/, "a taken item is skipped, not a reason to idle");
		assert.deepEqual(directives, [{ status: "running", checkpoint: { phase: "await", iteration: 0, costBefore: 0 } }]);
	});

	it("uses the iteration from the checkpoint", async () => {
		setup({ loop: { iteration: 2 }, remote: null });
		await run({ phase: "run", iteration: 2 });
		assert.equal(submits[0]!.requestId, "loop:L1:2");
		assert.deepEqual(submits[0]!.entry.data, { loopId: "L1", iteration: 2 });
		assert.match(submits[0]!.content, /iteration 3\/5/);
	});

	it("fails the loop when the conversation is gone", async () => {
		setup({ remote: null });
		conversationExists = false;
		await run();
		assert.equal(loopDoc()!.status, "failed");
		assert.equal(loopDoc()!.note, "conversation missing");
		assert.equal(submits.length, 0);
	});

	it("does not submit again after a crash between submitting and checkpointing", async () => {
		setup({ remote: null });
		failNextCommit = true;
		await assert.rejects(run(), /process died/);
		assert.equal(submits.length, 1);
		assert.deepEqual(directives, [], "the checkpoint never committed");
		// The phase reruns from its top with the same checkpoint.
		await run();
		assert.equal(submits.length, 1, "the iteration went out once");
		assert.deepEqual(directives, [{ status: "running", checkpoint: { phase: "await", iteration: 0 } }]);
	});

	it("goes straight to await for an iteration already sent, without gating it again", async () => {
		setup({ loop: { kind: "cleanup", iteration: 1, lastRunAt: 1, lastSeenBaseSha: BASE_SHA }, remote: REMOTE });
		gate({ baseSha: BASE_SHA });
		submissions.set("1:loop:L1:1", { id: 7 });
		await run({ phase: "run", iteration: 1 });
		assert.equal(gh.calls().length, 0, "no GitHub reads for an iteration that is already out");
		assert.equal(submits.length, 0);
		assert.deepEqual(directives, [{ status: "running", checkpoint: { phase: "await", iteration: 1 } }]);
		assert.equal(loopDoc()!.skipped, undefined, "a gate that would have skipped did not run");
	});

	it("reattaches an in-flight iteration before checking the budget, so work that ran is counted", async () => {
		setup({ remote: null });
		usage[1] = cost(9);
		submissions.set("1:loop:L1:0", { id: 7 });
		await run();
		assert.equal(loopDoc()!.status, "active");
		assert.deepEqual(directives, [{ status: "running", checkpoint: { phase: "await", iteration: 0 } }]);
	});
});

describe("run phase: the skip gate", () => {
	const run = (checkpoint: Record<string, unknown> = { phase: "run", iteration: 0 }) => phases.run(task(checkpoint), runtime(), context);

	it("wakes a goal loop and remembers the base it saw", async () => {
		setup({ remote: REMOTE });
		gate();
		await run();
		assert.equal(submits.length, 1);
		assert.deepEqual(directives, [{ status: "running", checkpoint: { phase: "await", iteration: 0, costBefore: 0, baseSha: BASE_SHA, fingerprint: `${BASE_SHA}||0:` } }]);
		assert.equal(loopDoc()!.lastSeenBaseSha, undefined, "recorded only once the iteration succeeds");
	});

	it("skips without a model call while every open PR is still running checks", async () => {
		setup({ remote: REMOTE });
		gate({ prs: [{ number: 3, sha: "c".repeat(40), check: "in_progress" }] });
		const before = Date.now();
		await run();
		assert.equal(submits.length, 0);
		assert.deepEqual(directives, [{ status: "running", checkpoint: { phase: "wait" } }]);
		const loop = loopDoc()!;
		assert.equal(loop.skipped, 1);
		assert.equal(loop.note, "skipped: waiting for checks on 1 open PR");
		near(loop.nextRunAt!, before + 5 * 60_000);
		assert.equal(loop.iteration, 0);
		assert.equal(loop.lastRunAt, undefined);
		const skip = events().find((event) => event.event === "loop_skip");
		assert.deepEqual([skip?.loop, skip?.nextCheckMinutes], ["L1", 5]);
	});

	it("counts each skip", async () => {
		setup({ remote: REMOTE });
		gate({ prs: [{ number: 3, sha: "c".repeat(40), check: "in_progress" }] });
		await run();
		await run();
		assert.equal(loopDoc()!.skipped, 2);
	});

	it("wakes when an open PR needs work", async () => {
		setup({ remote: REMOTE });
		gate({ prs: [{ number: 3, sha: "c".repeat(40), check: "failure" }] });
		await run();
		assert.equal(submits.length, 1);
	});

	it("ignores PRs outside the work-branch prefix", async () => {
		setup({ remote: REMOTE });
		gate({ prs: [{ number: 3, sha: "c".repeat(40), branch: "feature/x", check: "in_progress" }] });
		await run();
		assert.equal(submits.length, 1, "a human's PR does not hold the loop");
	});

	it("skips a cleanup loop when the base branch has not moved since its last run", async () => {
		setup({ loop: { kind: "cleanup", iteration: 1, lastRunAt: Date.now() - 3_600_000, lastSeenBaseSha: BASE_SHA }, remote: REMOTE });
		gate({ baseSha: BASE_SHA });
		await run({ phase: "run", iteration: 1 });
		assert.equal(submits.length, 0);
		assert.match(loopDoc()!.note, /no new commits on the base branch/);
		near(loopDoc()!.nextRunAt!, Date.now() + 60 * 60_000);
	});

	it("wakes a cleanup loop when the base moved recently", async () => {
		setup({ loop: { kind: "cleanup", iteration: 1, lastRunAt: Date.now() - 3 * 3_600_000, lastSeenBaseSha: "old" }, remote: REMOTE });
		gate({ baseSha: BASE_SHA });
		await run({ phase: "run", iteration: 1 });
		assert.equal(submits.length, 1);
		assert.equal((directives[0]!.checkpoint as { baseSha: string }).baseSha, BASE_SHA);
	});

	it("skips a cleanup loop when the base changed but has been idle past its window", async () => {
		setup({ loop: { kind: "cleanup", skipIfIdleHours: 24, iteration: 1, lastRunAt: Date.now() - 5 * 86_400_000, lastSeenBaseSha: "old" }, remote: REMOTE });
		gate({ baseSha: BASE_SHA, at: new Date(Date.now() - 3 * 86_400_000).toISOString() });
		await run({ phase: "run", iteration: 1 });
		assert.equal(submits.length, 0);
		assert.match(loopDoc()!.note, /base branch idle/);
	});

	it("runs a cleanup loop's first iteration whatever the base is doing", async () => {
		setup({ loop: { kind: "cleanup" }, remote: REMOTE });
		gate({ baseSha: BASE_SHA, at: new Date(Date.now() - 90 * 86_400_000).toISOString() });
		await run();
		assert.equal(submits.length, 1);
	});

	it("wakes a friction sweep only when friction issues are open", async () => {
		setup({ loop: { kind: "friction-sweep" }, remote: REMOTE });
		gate({ frictionIssues: 0 });
		await run();
		assert.equal(submits.length, 0);
		assert.equal(loopDoc()!.note, "skipped: no open friction issues");
		gate({ frictionIssues: 3 });
		await run();
		assert.equal(submits.length, 1);
	});

	it("wakes anyway when GitHub cannot be read, with no base to remember", async () => {
		setup({ remote: REMOTE });
		gate({ baseFails: true });
		await run();
		assert.equal(submits.length, 1);
		assert.deepEqual(directives, [{ status: "running", checkpoint: { phase: "await", iteration: 0, costBefore: 0 } }]);
	});

	it("does not gate a session whose origin is not GitHub", async () => {
		setup({ remote: "https://example.com/r.git" });
		gate({ prs: [{ number: 3, sha: "c".repeat(40), check: "in_progress" }] });
		await run();
		assert.equal(submits.length, 1);
		assert.equal(gh.calls().length, 0);
	});
});

describe("await phase", () => {
	const wait = (checkpoint: Record<string, unknown>) => phases.await(task(checkpoint), runtime(), context);
	const sent = (iteration = 0) => submissions.set(`1:loop:L1:${iteration}`, { id: 9 });

	it("waits for the submission, counts the iteration, and schedules the next", async () => {
		setup({ loop: { intervalMinutes: 30 } });
		sent();
		const before = Date.now();
		await wait({ phase: "await", iteration: 0 });
		assert.equal(waits, 1);
		const loop = loopDoc()!;
		assert.equal(loop.iteration, 1);
		near(loop.lastRunAt!, before);
		near(loop.nextRunAt!, before + 30 * 60_000);
		assert.deepEqual(directives, [{ status: "running", checkpoint: { phase: "wait" } }]);
	});

	it("puts the loop to sleep when the agent reported idle, keyed to the repo as it ended", async () => {
		setup({ loop: { idleReported: true }, remote: REMOTE });
		sent();
		gate({ baseSha: BASE_SHA });
		await wait({ phase: "await", iteration: 0, baseSha: BASE_SHA, fingerprint: `${BASE_SHA}||0:` });
		const loop = loopDoc()!;
		assert.equal(loop.status, "active", "dormant loops stay scheduled so the gate can wake them");
		assert.equal(loop.dormant?.fingerprint, `${BASE_SHA}||0:`);
		assert.equal(loop.idleReported, undefined);
		assert.match(loop.note, /^dormant: nothing left to do/);
	});

	it("puts the loop to sleep on its own after iterations that changed nothing", async () => {
		setup({ loop: { noopStreak: 2 }, remote: REMOTE });
		sent();
		gate({ baseSha: BASE_SHA });
		await wait({ phase: "await", iteration: 0, fingerprint: `${BASE_SHA}||0:` });
		assert.equal(loopDoc()!.noopStreak, 3);
		assert.match(loopDoc()!.note, /^dormant: 3 iterations changed nothing/);
	});

	it("resets the streak when the iteration changed something", async () => {
		setup({ loop: { noopStreak: 2 }, remote: REMOTE });
		sent();
		gate({ baseSha: BASE_SHA, prs: [{ number: 4, sha: "c".repeat(40), check: "success" }] });
		await wait({ phase: "await", iteration: 0, fingerprint: `${BASE_SHA}||0:` });
		assert.equal(loopDoc()!.noopStreak, 0);
		assert.equal(loopDoc()!.dormant, undefined);
	});

	it("records the base commit it saw only when the iteration completed", async () => {
		setup();
		sent();
		await wait({ phase: "await", iteration: 0, baseSha: BASE_SHA });
		assert.equal(loopDoc()!.lastSeenBaseSha, BASE_SHA);
	});

	it("does not record it for a failed iteration, so it is tried again", async () => {
		setup();
		sent();
		settle = { status: "unanswered" };
		await wait({ phase: "await", iteration: 0, baseSha: BASE_SHA });
		const loop = loopDoc()!;
		assert.equal(loop.lastSeenBaseSha, undefined);
		assert.equal(loop.iteration, 1, "the iteration still counts");
		assert.equal(loop.note, "iteration 1 ended unanswered");
	});

	it("leaves lastSeenBaseSha alone when there was no base to record", async () => {
		setup({ loop: { lastSeenBaseSha: "kept" } });
		sent();
		await wait({ phase: "await", iteration: 0 });
		assert.equal(loopDoc()!.lastSeenBaseSha, "kept");
	});

	it("moves on when no submission was ever made", async () => {
		setup();
		await wait({ phase: "await", iteration: 0 });
		assert.equal(waits, 0);
		assert.equal(loopDoc()!.iteration, 1);
		assert.equal(loopDoc()!.note, "iteration 1 ended without a submission");
	});

	it("moves on when the session is gone", async () => {
		setup({ session: false });
		sent();
		await wait({ phase: "await", iteration: 0 });
		assert.equal(waits, 0);
		assert.equal(loopDoc()!.iteration, 1);
	});

	it("finishes the loop at the iteration cap", async () => {
		setup({ loop: { iteration: 4, maxIterations: 5 } });
		sent(4);
		await wait({ phase: "await", iteration: 4 });
		assert.equal(loopDoc()!.iteration, 5);
		assert.equal(loopDoc()!.status, "done");
		assert.equal(loopDoc()!.note, "reached 5 iterations");
	});

	it("keeps the reason a loop paused itself, while still counting the iteration", async () => {
		setup({ loop: { status: "paused", note: "needs a decision from Tony" } });
		sent();
		settle = { status: "unanswered" };
		await wait({ phase: "await", iteration: 0 });
		assert.equal(loopDoc()!.status, "paused");
		assert.equal(loopDoc()!.note, "needs a decision from Tony");
		assert.equal(loopDoc()!.iteration, 1);
	});

	describe("charging the loop for the iteration", () => {
		it("adds what the session spent while the iteration ran", async () => {
			setup({ loop: { spent: 0.2 } });
			sent();
			usage[1] = cost(1.5);
			await wait({ phase: "await", iteration: 0, costBefore: 1 });
			near(loopDoc()!.spent!, 0.7, 1e-9);
		});

		it("includes the cost of the session's subagents", async () => {
			setup();
			sent();
			usage[1] = cost(1);
			usage[2] = cost(3);
			store.seed(Subagents, { parentOf: { "2": "s1" } });
			await wait({ phase: "await", iteration: 0, costBefore: 1 });
			near(loopDoc()!.spent!, 3, 1e-9);
		});

		it("accumulates across iterations", async () => {
			setup({ loop: { spent: 1 } });
			sent();
			usage[1] = cost(0.5);
			await wait({ phase: "await", iteration: 0, costBefore: 0 });
			near(loopDoc()!.spent!, 1.5, 1e-9);
		});

		it("charges an iteration that failed or was not answered", async () => {
			setup();
			sent();
			settle = { status: "unanswered" };
			usage[1] = cost(0.4);
			await wait({ phase: "await", iteration: 0, costBefore: 0 });
			near(loopDoc()!.spent!, 0.4, 1e-9);
		});

		it("charges a loop that paused itself during the iteration", async () => {
			setup({ loop: { status: "paused", note: "blocked" } });
			sent();
			usage[1] = cost(0.6);
			await wait({ phase: "await", iteration: 0, costBefore: 0 });
			near(loopDoc()!.spent!, 0.6, 1e-9);
			assert.equal(loopDoc()!.status, "paused");
		});

		it("charges nothing when the cost before is unknown, as after a crash that reattached", async () => {
			setup();
			sent();
			usage[1] = cost(9);
			await wait({ phase: "await", iteration: 0 });
			assert.equal(loopDoc()!.spent, undefined);
		});

		it("never charges a negative amount", async () => {
			setup({ loop: { spent: 1 } });
			sent();
			usage[1] = cost(0.5);
			await wait({ phase: "await", iteration: 0, costBefore: 2 });
			assert.equal(loopDoc()!.spent, 1);
		});

		it("charges nothing for a session that is gone", async () => {
			setup({ session: false, loop: { spent: 1 } });
			await wait({ phase: "await", iteration: 0, costBefore: 2 });
			assert.equal(loopDoc()!.spent, 1);
		});

		it("pauses the loop on its next run once the iterations have used the budget", async () => {
			setup({ loop: { budgetUsd: 1, maxIterations: 5 }, remote: null });
			await phases.run(task({ phase: "run", iteration: 0 }), runtime(), context);
			usage[1] = cost(1.2);
			await phases.await(task({ phase: "await", iteration: 0, costBefore: 0 }), runtime(), context);
			assert.equal(loopDoc()!.status, "active");
			await phases.run(task({ phase: "run", iteration: 1 }), runtime(), context);
			assert.equal(loopDoc()!.status, "paused");
			assert.match(loopDoc()!.note, /budget reached: \$1\.20 of \$1/);
			assert.equal(submits.length, 1);
		});
	});

	it("ends the task when the loop was removed", async () => {
		setup({ loop: null });
		sent();
		await wait({ phase: "await", iteration: 3 });
		assert.deepEqual(directives, [{ status: "terminal", outcome: { status: "completed", result: { iterations: 3 } } }]);
	});
});

const entry = (kind: string) => ({ kind });
const setPolicy = (loops: Record<string, unknown>) => writeFileSync(join(process.env.PD_CONFIG_DIR!, "policy.json"), JSON.stringify({ loops }));

describe("scanForLastInput", () => {
	// A fake conversation, newest first, paged by index.
	const pager = (kinds: string[]) => async (limit: number, cursor: number | undefined) => {
		const start = cursor ?? 0;
		const items = kinds.slice(start, start + limit).map(entry);
		return { items, next: start + limit < kinds.length ? start + limit : undefined };
	};
	const own = (n: number) => Array.from({ length: n }, () => "pi.assistant");

	it("pages past a long iteration to the loop's own tick, so the loop resets", async () => {
		const scan = await ext.scanForLastInput(pager([...own(120), "pdl.loop-tick", ...own(10)]));
		assert.equal(scan.settled, true);
		assert.equal(ext.mayResetForLoop(scan.items, Number.POSITIVE_INFINITY), true);
	});

	it("still finds a person's message behind a long task, so the loop does not reset", async () => {
		const scan = await ext.scanForLastInput(pager([...own(120), "pi.user", "pdl.loop-tick"]));
		assert.equal(scan.settled, true);
		assert.equal(ext.mayResetForLoop(scan.items, Number.POSITIVE_INFINITY), false);
	});

	it("is settled at the start of the history", async () => {
		const scan = await ext.scanForLastInput(pager(own(70)));
		assert.deepEqual([scan.items.length, scan.settled], [70, true]);
	});

	it("gives up (unsettled, no reset) past the scan limit", async () => {
		const scan = await ext.scanForLastInput(pager([...own(300), "pdl.loop-tick"]), 50, 200);
		assert.equal(scan.settled, false);
		assert.equal(ext.mayResetForLoop(scan.items, scan.items.length), false);
	});
});

describe("mayResetForLoop", () => {
	const may = (...kinds: string[]) => ext.mayResetForLoop(kinds.map(entry));

	it("is true for a conversation nobody has spoken in", () => {
		assert.equal(may(), true);
		assert.equal(may("pi.assistant", "pi.tool-result", "pi.system"), true, "only the agent's own entries");
	});

	it("is true when the newest input is the loop's own tick", () => {
		assert.equal(may("pi.assistant", "pi.tool-result", "pdl.loop-tick"), true);
		assert.equal(may("pdl.loop-tick", "pi.user"), true, "a person's older message does not matter");
		assert.equal(may("pdl.loop-tick", "pdl.peer"), true, "nor does an older peer message");
	});

	it("is false when a person has written since the last tick", () => {
		assert.equal(may("pi.assistant", "pi.user", "pi.assistant", "pdl.loop-tick"), false);
		assert.equal(may("pi.user"), false, "even with no tick at all");
	});

	it("is false when another session has written since the last tick", () => {
		assert.equal(may("pi.assistant", "pdl.peer", "pdl.loop-tick"), false);
		assert.equal(may("pdl.peer"), false);
	});

	it("uses the newest input, whatever came before it", () => {
		assert.equal(may("pdl.loop-tick", "pi.user", "pdl.loop-tick"), true);
		assert.equal(may("pi.user", "pdl.loop-tick", "pi.user"), false);
	});

	it("ignores entries that are not inputs", () => {
		assert.equal(may("pi.compaction", "pi.reset", "pdl.other", "pdl.loop-tick"), true);
	});

	// The loop looks at the newest 50 entries. A person who asked for a long task (30 tool calls is 60 entries) has
	// their message pushed out of that window, so "no input found" is not the same as "nobody has spoken".
	it("does not reset when a full window of the agent's own entries hides who spoke last", () => {
		assert.equal(may(...Array.from({ length: 50 }, () => "pi.assistant")), false);
	});
});

describe("loopHandoff", () => {
	const loop = baseLoop({ goal: "Improve the thing", note: "Opened #56; waiting on CI." });

	it("says the history was cleared and where durable state lives", () => {
		const text = ext.loopHandoff(loop, []);
		assert.match(text, /^Fresh context for loop L1; earlier iterations' history was cleared to save cost\./);
		assert.match(text, /project memory \(memory_search\), git, and GitHub/);
	});

	it("carries the goal, the last note and the open PRs", () => {
		const text = ext.loopHandoff(loop, [3, 5]);
		assert.match(text, /^Goal: Improve the thing$/m);
		assert.match(text, /^Last iteration's note: Opened #56; waiting on CI\.$/m);
		assert.match(text, /^Your open PRs: #3, #5$/m);
	});

	it("says so when there are no open PRs, and leaves out an empty note", () => {
		const text = ext.loopHandoff(baseLoop({ note: "" }), []);
		assert.match(text, /^You have no open PRs\.$/m);
		assert.doesNotMatch(text, /Last iteration's note/);
	});

	it("caps a long goal at 600 characters", () => {
		const text = ext.loopHandoff(baseLoop({ goal: "g".repeat(2_000) }), []);
		const goal = text.split("\n").find((line) => line.startsWith("Goal: "))!;
		assert.equal(goal.length, "Goal: ".length + 600 + 1);
		assert.ok(goal.endsWith("\u2026"));
		assert.equal(ext.loopHandoff(baseLoop({ goal: "g".repeat(600) }), []).includes("\u2026"), false, "exactly 600 is kept whole");
	});

	it("is short: it exists to save tokens", () => {
		assert.ok(ext.loopHandoff(baseLoop({ goal: "g".repeat(5_000), note: "n".repeat(300) }), [1, 2, 3, 4, 5]).length < 1_300);
	});
});

describe("fresh context per iteration", () => {
	const run = (checkpoint: Record<string, unknown> = { phase: "run", iteration: 0 }) => phases.run(task(checkpoint), runtime(), context);
	const iterationAudit = () => events().filter((event) => event.event === "loop_fresh_context");

	it("resets a quiet loop's conversation with the handoff, before the prompt is sent", async () => {
		setup({ loop: { note: "Opened #56." }, remote: null });
		await run();
		assert.equal(resets.length, 1);
		assert.deepEqual(order, ["reset", "submit"]);
		assert.match(resets[0]!, /^Fresh context for loop L1/);
		assert.match(resets[0]!, /Goal: Improve the thing/);
		assert.match(resets[0]!, /Last iteration's note: Opened #56\./);
		assert.deepEqual(iterationAudit().map((event) => [event.loop, event.iteration]), [["L1", 0]]);
	});

	it("includes the PRs the gate found open", async () => {
		setup({ remote: REMOTE });
		gate({ prs: [{ number: 3, sha: "c".repeat(40), check: "failure" }, { number: 5, sha: "d".repeat(40), check: "success" }] });
		await run();
		assert.match(resets[0]!, /Your open PRs: #3, #5/);
	});

	it("says there are none when the session has no GitHub repo to ask", async () => {
		setup({ remote: null });
		await run();
		assert.match(resets[0]!, /You have no open PRs\./);
	});

	it("resets when the newest input is the loop's own previous tick", async () => {
		setup({ remote: null });
		recentEntries = [entry("pi.assistant"), entry("pi.tool-result"), entry("pdl.loop-tick"), entry("pi.user")];
		await run();
		assert.equal(resets.length, 1);
	});

	it("does not reset after a person has written since the last tick, and still runs the iteration", async () => {
		setup({ remote: null });
		recentEntries = [entry("pi.assistant"), entry("pi.user"), entry("pi.assistant"), entry("pdl.loop-tick")];
		await run();
		assert.equal(resets.length, 0);
		assert.deepEqual(order, ["submit"]);
		assert.equal(iterationAudit().length, 0);
	});

	it("resets after another session has written since the last tick, carrying its note", async () => {
		setup({ remote: null });
		recentEntries = [{ kind: "pdl.peer", data: { from: "assistant", text: "please nudge" } } as never, entry("pdl.loop-tick")];
		await run();
		assert.equal(resets.length, 1);
		assert.match(String(resets[0]), /assistant: please nudge/);
		assert.equal(submits.length, 1);
	});

	it("defers a busy session without queuing or counting another paid iteration", async () => {
		setup({ remote: null });
		busyTasks = [{ record: { background: false, conversationId: 1 } }];
		await run();
		assert.equal(resets.length, 0);
		assert.equal(submits.length, 0);
		assert.equal(loopDoc()!.iteration, 0);
		assert.equal(loopDoc()!.note, "waiting: session already busy");
	});

	it("is not stopped by background tasks, such as the loop's own, or by another session's run", async () => {
		setup({ remote: null });
		busyTasks = [{ record: { background: true, conversationId: 1 } }, { record: { background: false, conversationId: 2 } }];
		await run();
		assert.equal(resets.length, 1);
	});

	it("does not reset when freshContext is turned off", async () => {
		setPolicy({ freshContext: false });
		setup({ remote: null });
		await run();
		assert.equal(resets.length, 0);
		assert.equal(entriesCalls, 0, "it does not even look");
		assert.equal(submits.length, 1);
	});

	it("resets by default, without any policy setting", async () => {
		writeFileSync(join(process.env.PD_CONFIG_DIR!, "policy.json"), "{}");
		setup({ remote: null });
		await run();
		assert.equal(resets.length, 1);
	});

	it("never resets for an iteration that was already submitted", async () => {
		setup({ remote: null });
		submissions.set("1:loop:L1:0", { id: 7 });
		await run();
		assert.equal(resets.length, 0);
		assert.equal(entriesCalls, 0);
		assert.equal(submits.length, 0);
		assert.deepEqual(directives, [{ status: "running", checkpoint: { phase: "await", iteration: 0 } }]);
	});

	it("does not reset a second time when a crash makes the phase run again", async () => {
		setup({ remote: null });
		failNextCommit = true;
		await assert.rejects(run(), /process died/);
		assert.equal(resets.length, 1);
		await run();
		assert.equal(resets.length, 1, "the iteration was already submitted, so the rerun reattaches");
		assert.equal(submits.length, 1);
	});

	it("does not reset for an iteration the gate skips", async () => {
		setup({ remote: REMOTE });
		gate({ prs: [{ number: 3, sha: "c".repeat(40), check: "in_progress" }] });
		await run();
		assert.equal(resets.length, 0);
		assert.equal(submits.length, 0);
	});

	it("does not reset a loop that is out of budget, over its cap, or has no session or conversation", async () => {
		setup({ loop: { spent: 9 }, remote: null });
		await run();
		store = makeStore();
		setup({ loop: { iteration: 5, maxIterations: 5 }, remote: null });
		await run({ phase: "run", iteration: 5 });
		store = makeStore();
		setup({ session: false });
		await run();
		store = makeStore();
		setup({ remote: null });
		conversationExists = false;
		await run();
		assert.equal(resets.length, 0);
	});

	it("measures the iteration's starting cost after the reset, so the reset itself is not charged to the loop", async () => {
		setup({ remote: null });
		usage[1] = cost(5);
		resetAddsCost = 0.7;
		await run();
		assert.equal((directives[0]!.checkpoint as { costBefore: number }).costBefore, 5.7);
	});

	it("resets again at the next iteration, each time from the loop's own latest note", async () => {
		setup({ loop: { note: "first note" }, remote: null });
		await run();
		await phases.await(task({ phase: "await", iteration: 0, costBefore: 0 }), runtime(), context);
		loopDoc()!.note = "second note";
		recentEntries = [entry("pi.assistant"), entry("pdl.loop-tick")];
		await run({ phase: "run", iteration: 1 });
		assert.equal(resets.length, 2);
		assert.match(resets[0]!, /first note/);
		assert.match(resets[1]!, /second note/);
		assert.deepEqual(order, ["reset", "submit", "reset", "submit"]);
	});
});

describe("two loops on one session", () => {
	const seedTwo = (change: Partial<Loop> = {}) => {
		setPolicy({ dailyBudgetUsd: 0 }); // This suite isolates per-loop accounting from the shared cap.
		store.seed(Loops, { byId: { L1: baseLoop(), L2: baseLoop({ id: "L2", goal: "A different goal", ...change }) }, nextId: 3 });
		setup({ loop: null, remote: null });
	};
	const iterate = async (id: string, iteration: number, totalCostAfter: number) => {
		await phases.run(task({ phase: "run", iteration }, id), runtime(), context);
		const costBefore = (directives.at(-1)!.checkpoint as { costBefore: number }).costBefore;
		usage[1] = cost(totalCostAfter);
		await phases.await(task({ phase: "await", iteration, costBefore }, id), runtime(), context);
	};

	it("do not charge each other for their spend", async () => {
		seedTwo();
		await iterate("L1", 0, 2.5);
		near(loopDoc("L1")!.spent!, 2.5, 1e-9);
		assert.equal(loopDoc("L2")!.spent, undefined, "L1's spend is not L2's");
		await iterate("L2", 0, 3.5);
		near(loopDoc("L2")!.spent!, 1, 1e-9);
		near(loopDoc("L1")!.spent!, 2.5, 1e-9);
	});

	it("keep running while the other has used its whole budget", async () => {
		seedTwo();
		await iterate("L1", 0, 3.2);
		await phases.run(task({ phase: "run", iteration: 1 }, "L1"), runtime(), context);
		assert.equal(loopDoc("L1")!.status, "paused", "L1 used its budget");
		submits.length = 0;
		await phases.run(task({ phase: "run", iteration: 0 }, "L2"), runtime(), context);
		assert.equal(loopDoc("L2")!.status, "active", "the session's total spend is not L2's budget");
		assert.deepEqual(submits.map((submit) => submit.requestId), ["loop:L2:0"]);
	});

	it("start the second one at zero even when the session has spent a lot", async () => {
		seedTwo();
		usage[1] = cost(40);
		await phases.run(task({ phase: "run", iteration: 0 }, "L2"), runtime(), context);
		assert.equal(loopDoc("L2")!.status, "active");
		assert.equal((directives.at(-1)!.checkpoint as { costBefore: number }).costBefore, 40);
		usage[1] = cost(40.25);
		await phases.await(task({ phase: "await", iteration: 0, costBefore: 40 }, "L2"), runtime(), context);
		near(loopDoc("L2")!.spent!, 0.25, 1e-9);
	});

	it("send each loop's own prompt under its own request id", async () => {
		seedTwo();
		await iterate("L1", 0, 0.1);
		await iterate("L2", 0, 0.2);
		assert.deepEqual(submits.map((submit) => submit.requestId), ["loop:L1:0", "loop:L2:0"]);
		assert.match(submits[0]!.content, /Improve the thing/);
		assert.match(submits[1]!.content, /A different goal/);
	});
});

describe("whole iterations", () => {
	/** Follow the task's own checkpoints, as the scheduler would, until it ends. */
	async function drive(maxSteps = 40): Promise<string[]> {
		const trace: string[] = [];
		let checkpoint: Record<string, unknown> = initial({ loopId: "L1" });
		for (let step = 0; step < maxSteps; step++) {
			const phase = checkpoint.phase as "wait" | "run" | "await";
			trace.push(phase);
			directives = [];
			sleeps = [];
			await phases[phase](task(checkpoint), runtime(), context);
			const directive = directives.at(-1);
			if (directive?.status === "terminal") return trace;
			if (directive?.status === "running") checkpoint = directive.checkpoint!;
			else if (sleeps.length > 0) checkpoint = sleeps[0]!.checkpoint;
			else throw new Error(`phase ${phase} neither checkpointed nor slept`);
			// Skip the real sleep: the next iteration is due.
			const loop = loopDoc();
			if (loop !== undefined) loop.nextRunAt = 0;
		}
		throw new Error("the loop did not end");
	}

	it("runs every iteration once and finishes at the cap", async () => {
		setup({ loop: { maxIterations: 3 }, remote: null });
		const trace = await drive();
		assert.deepEqual(submits.map((submit) => submit.requestId), ["loop:L1:0", "loop:L1:1", "loop:L1:2"]);
		assert.equal(loopDoc()!.iteration, 3);
		assert.equal(loopDoc()!.status, "done");
		assert.deepEqual(trace.slice(0, 4), ["run", "await", "wait", "run"]);
		assert.equal(trace.at(-1), "wait");
	});

	it("survives a crash between submitting and checkpointing without losing or repeating the iteration", async () => {
		setup({ loop: { maxIterations: 2 }, remote: null });
		failNextCommit = true;
		await assert.rejects(phases.run(task({ phase: "run", iteration: 0 }), runtime(), context), /process died/);
		await drive();
		assert.deepEqual(submits.map((submit) => submit.requestId), ["loop:L1:0", "loop:L1:1"], "iteration 0 was submitted once, and counted");
		assert.equal(loopDoc()!.iteration, 2);
	});

	it("does not lose the iteration when a skip-gated loop crashes mid-iteration", async () => {
		// A cleanup loop whose gate would now say "skip": the rerun must still reattach to the iteration already sent.
		setup({ loop: { kind: "cleanup", maxIterations: 5, iteration: 1, lastRunAt: Date.now() - 3 * 3_600_000, lastSeenBaseSha: "old" }, remote: REMOTE });
		gate({ baseSha: BASE_SHA });
		failNextCommit = true;
		await assert.rejects(phases.run(task({ phase: "run", iteration: 1 }), runtime(), context), /process died/);
		gate({ baseSha: "old" });
		directives = [];
		await phases.run(task({ phase: "run", iteration: 1 }), runtime(), context);
		assert.deepEqual(directives, [{ status: "running", checkpoint: { phase: "await", iteration: 1 } }]);
		await phases.await(task({ phase: "await", iteration: 1 }), runtime(), context);
		assert.equal(loopDoc()!.iteration, 2, "the crashed iteration was counted");
		assert.equal(submits.length, 1);
	});

	// pd loop resume starts a NEW task, and a new task begins at its initial checkpoint (iteration 0). The run phase
	// takes the iteration from that checkpoint, so a loop paused at iteration 3 would re-send iterations 0, 1 and 2:
	// their request ids already exist, so each is a no-op that lasts one interval, until the count catches up.
	it("a resumed loop carries on from its own iteration count, not from zero", async () => {
		setup({ loop: { iteration: 3 }, remote: null });
		for (const n of [0, 1, 2]) submissions.set(`1:loop:L1:${n}`, { id: n });
		await phases.run(task(initial({ loopId: "L1" })), runtime(), context);
		assert.deepEqual(submits.map((submit) => submit.requestId), ["loop:L1:3"], "a new iteration is sent, not an old one reattached");
		assert.match(submits[0]!.content, /iteration 4\/5/);
		assert.deepEqual(directives, [{ status: "running", checkpoint: { phase: "await", iteration: 3, costBefore: 0 } }]);
	});

	it("stops when the loop is paused between iterations", async () => {
		setup({ loop: { maxIterations: 5 }, remote: null });
		await phases.run(task({ phase: "run", iteration: 0 }), runtime(), context);
		await phases.await(task({ phase: "await", iteration: 0 }), runtime(), context);
		loopDoc()!.status = "paused";
		directives = [];
		await phases.wait(task({ phase: "wait" }), runtime(), context);
		assert.equal(directives[0]!.status, "terminal");
		assert.equal(submits.length, 1);
	});
});

describe("compact next-task handoffs", () => {
 it("carries the next slice into a fresh context without copying an unbounded task", () => {
  const nextTask = "Update arena renderer; preserve collision sizes. " + "x".repeat(3000);
  const handoff = ext.loopHandoff(baseLoop({ nextTask }), []);
  assert.ok(handoff.includes("Next work item: Update arena renderer"));
  assert.ok(handoff.length < 1800);
 });
});
describe("memory context cost", () => {
 it("excerpts long injected records without changing stored instructions", () => {
  const memory = { id: "1", topic: "Visual direction", text: "a".repeat(8000), tags: [], by: "owner", updatedAt: 1 };
  const line = ext.memoryPromptLine(memory);
  assert.ok(line.length < 1300);
  assert.match(line, /memory_search/);
  assert.equal(memory.text.length, 8000);
 });
});
describe("abort of a replaced task", () => {
	it("leaves the loop alone when a newer task now runs it", async () => {
		setup({ loop: { taskId: 7 } });
		await abort({ ...task({ phase: "wait" }), id: 3 }, runtime(), context);
		assert.equal(loopDoc()!.status, "active");
		assert.equal(directives[0]!.outcome!.status, "aborted");
	});

	it("still pauses the loop when the aborted task is its current one", async () => {
		setup({ loop: { taskId: 7 } });
		await abort({ ...task({ phase: "wait" }), id: 7 }, runtime(), context);
		assert.equal(loopDoc()!.status, "paused");
	});
});

describe("loop_report", () => {
	const report = ext.Loops_.tools!.find((tool) => tool.name === "loop_report")!.execute as (args: unknown, api: unknown, context: unknown) => Promise<{ isError?: boolean; output: { text: string }[] }>;
	let created: { input: unknown; options: unknown }[];
	let aborted: number[];
	const api = () => ({
		conversationId: 1,
		snapshot: store.snapshot.bind(store),
		commit: (callback: (tx: unknown) => unknown) =>
			store.commit((tx) =>
				callback({
					...tx,
					createTask: async (_definition: unknown, input: unknown, options: unknown) => {
						created.push({ input, options });
						return 50 + created.length;
					},
				}),
			),
	});
	beforeEach(() => {
		created = [];
		aborted = [];
		ext.setHarness({ abortTask: async (id: number) => void aborted.push(id) } as never);
	});

	it("wakes a dormant loop that reports continue: a fresh task now, the sleeping one ended", async () => {
		setup({ loop: { taskId: 7, dormant: { fingerprint: "f", since: 0 }, noopStreak: 2, idleReported: true, nextRunAt: Date.now() + 6 * 3_600_000 } });
		const result = await report({ loopId: "L1", status: "continue", note: "roadmap merged", nextTask: "item 1" }, api(), context);
		assert.equal(result.isError, undefined);
		const loop = loopDoc()!;
		assert.equal(loop.dormant, undefined);
		assert.equal(loop.idleReported, undefined);
		assert.equal(loop.noopStreak, 0);
		near(loop.nextRunAt!, Date.now());
		assert.equal(loop.taskId, 51);
		assert.deepEqual(created, [{ input: { loopId: "L1" }, options: { ownership: { kind: "conversation" }, background: true } }]);
		assert.deepEqual(aborted, [7]);
		assert.ok(events().some((entry) => entry.event === "loop_wake" && entry.loop === "L1"));
	});

	it("does not touch the task of an awake loop, or of a dormant loop that reports idle", async () => {
		setup({ loop: { taskId: 7 } });
		await report({ loopId: "L1", status: "continue", note: "more" }, api(), context);
		setup({ loop: { taskId: 7, dormant: { fingerprint: "f", since: 0 } } });
		await report({ loopId: "L1", status: "idle", note: "nothing" }, api(), context);
		assert.ok(loopDoc()!.dormant !== undefined);
		assert.equal(loopDoc()!.taskId, 7);
		assert.deepEqual(created, []);
		assert.deepEqual(aborted, []);
	});

	it("refuses a loop of another session", async () => {
		setup({ loop: { session: "other", dormant: { fingerprint: "f", since: 0 } } });
		const result = await report({ loopId: "L1", status: "continue", note: "x" }, api(), context);
		assert.equal(result.isError, true);
		assert.deepEqual(created, []);
	});
});

describe("the daily cap counts spend outside loops", () => {
	it("waits when sessions spent the day's budget through direct sends, with no loop charges at all", async () => {
		setPolicy({ dailyBudgetUsd: 10 });
		const now = Date.now();
		store.seed(Loops, { byId: { L1: baseLoop() }, nextId: 2, factorySpend: [{ at: now - 23 * 60 * 60_000, total: 5 }, { at: now - 60_000, total: 16 }] });
		setup({ loop: null, remote: null });
		await phases.run(task({ phase: "run", iteration: 0 }), runtime(), context);
		assert.equal(submits.length, 0, "no model call over the cap");
		assert.equal(loopDoc()!.note, "waiting: factory daily budget reached");
	});

	it("runs when the day's change in session totals is under the cap", async () => {
		setPolicy({ dailyBudgetUsd: 10 });
		const now = Date.now();
		store.seed(Loops, { byId: { L1: baseLoop() }, nextId: 2, factorySpend: [{ at: now - 25 * 60 * 60_000, total: 5 }, { at: now - 60_000, total: 14 }] });
		setup({ loop: null, remote: null });
		await phases.run(task({ phase: "run", iteration: 0 }), runtime(), context);
		assert.deepEqual(submits.map((submit) => submit.requestId), ["loop:L1:0"]);
	});
});

describe("maintenance loops on the cheaper model", () => {
	it("switches a ci-health iteration to the maintenance model and restores the session's model after", async () => {
		writeFileSync(join(process.env.PD_CONFIG_DIR!, "policy.json"), JSON.stringify({ loops: { dailyBudgetUsd: 0, maintenanceModel: "anthropic/claude-haiku-5-5" } }));
		store.seed(Loops, { byId: { L1: baseLoop({ kind: "ci-health" }) }, nextId: 2 });
		setup({ loop: null, remote: null });
		await phases.run(task({ phase: "run", iteration: 0 }), runtime(), context);
		assert.equal(currentModel, "anthropic/claude-haiku-5-5", "runs on the cheap model");
		const checkpoint = directives.at(-1)!.checkpoint as { restoreModel?: string; costBefore: number };
		assert.equal(checkpoint.restoreModel, "anthropic/claude-sonnet-5-5");
		await phases.await(task({ phase: "await", iteration: 0, costBefore: checkpoint.costBefore, restoreModel: checkpoint.restoreModel }), runtime(), context);
		assert.equal(currentModel, "anthropic/claude-sonnet-5-5", "the session gets its model back");
	});

	it("leaves goal loops on the session's model", async () => {
		writeFileSync(join(process.env.PD_CONFIG_DIR!, "policy.json"), JSON.stringify({ loops: { dailyBudgetUsd: 0, maintenanceModel: "anthropic/claude-haiku-5-5" } }));
		store.seed(Loops, { byId: { L1: baseLoop() }, nextId: 2 });
		setup({ loop: null, remote: null });
		await phases.run(task({ phase: "run", iteration: 0 }), runtime(), context);
		assert.equal(currentModel, "anthropic/claude-sonnet-5-5");
		assert.equal((directives.at(-1)!.checkpoint as { restoreModel?: string }).restoreModel, undefined);
	});
});

describe("loops take turns", () => {
	it("waits for a slot without a model call, and marks itself waiting", async () => {
		writeFileSync(join(process.env.PD_CONFIG_DIR!, "policy.json"), JSON.stringify({ loops: { dailyBudgetUsd: 0, maxConcurrent: 1 } }));
		store.seed(Loops, { byId: { L1: baseLoop(), L2: baseLoop({ id: "L2", session: "other", inFlightSince: Date.now() - 60_000 }) }, nextId: 3 });
		setup({ loop: null, remote: null });
		await phases.run(task({ phase: "run", iteration: 0 }), runtime(), context);
		assert.equal(submits.length, 0);
		assert.match(loopDoc()!.note, /queued: 1 of 1 slots busy \(L2\)/);
		assert.ok(loopDoc()!.waitingSince !== undefined);
	});

	it("holds a slot from submit until the iteration settles", async () => {
		writeFileSync(join(process.env.PD_CONFIG_DIR!, "policy.json"), JSON.stringify({ loops: { dailyBudgetUsd: 0, maxConcurrent: 1 } }));
		store.seed(Loops, { byId: { L1: baseLoop({ waitingSince: Date.now() - 60_000 }) }, nextId: 2 });
		setup({ loop: null, remote: null });
		await phases.run(task({ phase: "run", iteration: 0 }), runtime(), context);
		assert.deepEqual(submits.map((submit) => submit.requestId), ["loop:L1:0"]);
		assert.ok(loopDoc()!.inFlightSince !== undefined, "running");
		assert.equal(loopDoc()!.waitingSince, undefined, "no longer waiting");
		await phases.await(task({ phase: "await", iteration: 0, costBefore: 0 }), runtime(), context);
		assert.equal(loopDoc()!.inFlightSince, undefined, "slot freed");
	});

	it("waits while pacing says the hour's allowance is used", async () => {
		writeFileSync(join(process.env.PD_CONFIG_DIR!, "policy.json"), JSON.stringify({ loops: { dailyBudgetUsd: 24, pace: true, paceBurst: 1, paceWindowHours: 1 } }));
		store.seed(Loops, { byId: { L1: baseLoop({ spendLog: [{ at: Date.now() - 10 * 60_000, usd: 1.5 }] }) }, nextId: 2 });
		setup({ loop: null, remote: null });
		await phases.run(task({ phase: "run", iteration: 0 }), runtime(), context);
		assert.equal(submits.length, 0);
		assert.match(loopDoc()!.note, /pacing, \$1\.50 spent in the last hour \(allowance \$1\.00\)/);
	});
});

describe("pacing over a 3-hour window", () => {
	it("lets one big iteration through without blocking the next hour, and waits once the window is used", async () => {
		writeFileSync(join(process.env.PD_CONFIG_DIR!, "policy.json"), JSON.stringify({ loops: { dailyBudgetUsd: 24, pace: true, paceBurst: 1 } }));
		store.seed(Loops, { byId: { L1: baseLoop({ spendLog: [{ at: Date.now() - 10 * 60_000, usd: 1.5 }] }) }, nextId: 2 });
		setup({ loop: null, remote: null });
		await phases.run(task({ phase: "run", iteration: 0 }), runtime(), context);
		assert.deepEqual(submits.map((submit) => submit.requestId), ["loop:L1:0"], "$1.50 of a $3 3h allowance");
	});
	it("waits when the 3h window is spent", async () => {
		writeFileSync(join(process.env.PD_CONFIG_DIR!, "policy.json"), JSON.stringify({ loops: { dailyBudgetUsd: 24, pace: true, paceBurst: 1 } }));
		store.seed(Loops, { byId: { L1: baseLoop({ spendLog: [{ at: Date.now() - 150 * 60_000, usd: 2 }, { at: Date.now() - 10 * 60_000, usd: 1.2 }] }) }, nextId: 2 });
		setup({ loop: null, remote: null });
		await phases.run(task({ phase: "run", iteration: 0 }), runtime(), context);
		assert.equal(submits.length, 0);
		assert.match(loopDoc()!.note, /pacing, \$3\.20 spent in the last 3h \(allowance \$3\.00\)/);
	});
});

describe("waiting on the daily cap", () => {
	it("looks again within the hour, not when the oldest charge ages out", async () => {
		writeFileSync(join(process.env.PD_CONFIG_DIR!, "policy.json"), JSON.stringify({ loops: { dailyBudgetUsd: 1 } }));
		store.seed(Loops, { byId: { L1: baseLoop({ spendLog: [{ at: Date.now() - 60 * 60_000, usd: 5 }] }) }, nextId: 2 });
		setup({ loop: null, remote: null });
		await phases.run(task({ phase: "run", iteration: 0 }), runtime(), context);
		assert.equal(submits.length, 0);
		const wait = loopDoc()!.nextRunAt! - Date.now();
		assert.ok(wait <= 60 * 60_000 + 1000 && wait > 50 * 60_000, `rechecks in about an hour, not 23h (got ${Math.round(wait / 60_000)}m)`);
	});
});

describe("the personal assistant", () => {
	it("skips without a model call when nothing that could need Tony changed", async () => {
		writeFileSync(join(process.env.PD_CONFIG_DIR!, "policy.json"), JSON.stringify({ loops: { dailyBudgetUsd: 0 } }));
		store.seed(Loops, { byId: { L1: baseLoop({ kind: "assistant", lastAttentionKey: "|0|", lastRunAt: Date.now() - 30 * 60_000 }) }, nextId: 2 });
		setup({ loop: null, remote: null });
		await phases.run(task({ phase: "run", iteration: 1 }), runtime(), context);
		assert.equal(submits.length, 0);
		assert.equal(loopDoc()!.note, "skipped: nothing new for Tony");
	});

	it("runs when something changed, and remembers what it saw", async () => {
		writeFileSync(join(process.env.PD_CONFIG_DIR!, "policy.json"), JSON.stringify({ loops: { dailyBudgetUsd: 0 } }));
		writeFileSync(AUDIT, `${JSON.stringify({ at: new Date().toISOString(), event: "parked", repo: "o/r", pr: 2 })}\n`);
		store.seed(Loops, { byId: { L1: baseLoop({ kind: "assistant", lastAttentionKey: "|0|", lastRunAt: Date.now() - 30 * 60_000 }) }, nextId: 2 });
		setup({ loop: null, remote: null });
		writeFileSync(AUDIT, `${JSON.stringify({ at: new Date().toISOString(), event: "parked", repo: "o/r", pr: 2 })}\n`);
		await phases.run(task({ phase: "run", iteration: 1 }), runtime(), context);
		assert.equal(submits.length, 1);
		assert.notEqual(loopDoc()!.lastAttentionKey, "|0|");
	});
});

describe("resetDecision", () => {
	const e = (kind: string, data?: unknown) => ({ kind, data });
	it("resets after a peer note and carries it into the handoff", () => {
		const d = ext.resetDecision([e("pi.assistant"), e("pdl.peer", { from: "budget-review", text: "be cheaper" }), e("pi.assistant"), e("pdl.loop-tick")], true);
		assert.equal(d.reset, true);
		assert.deepEqual(d.carried, ["budget-review: be cheaper"]);
		assert.match(ext.loopHandoff({ id: "L1", goal: "g" } as never, [], d.carried), /budget-review: be cheaper/);
	});
	it("keeps the context when a person wrote, even behind a peer note", () => {
		assert.equal(ext.resetDecision([e("pdl.peer", { from: "x", text: "y" }), e("pi.user"), e("pdl.loop-tick")], true).reset, false);
	});
	it("keeps the context when the scan was unsettled, and says why", () => {
		const d = ext.resetDecision([e("pi.assistant")], false);
		assert.equal(d.reset, false);
		assert.match(d.reason, /unsettled/);
	});
	it("resets a conversation nobody spoke in, and one whose newest input is the tick", () => {
		assert.equal(ext.resetDecision([], true).reset, true);
		assert.equal(ext.resetDecision([e("pi.assistant"), e("pdl.loop-tick")], true).reset, true);
	});
});
