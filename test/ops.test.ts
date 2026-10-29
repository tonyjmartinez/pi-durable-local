// The daemon's request handling, tested without the daemon: validation, defaults, edits, and the task-ending guard.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { CLEANUP_PROMPTS, CLEANUP_SCHEDULE } from "../src/loopgate.ts";
import {
	applyLoopSettings, applyResume, assertApprovedHead, assertResumable, auditTail, cloneArgs, cloneEnv, editProjectPolicy, endLiveTask,
	HttpError, LOOP_LIMITS, newLoop, newMemory, parseApproval, parseRepo, projectDir, projectSessionName, resolveLoopSpec, sendMode,
	stopPatch, updateProjectPolicy, validateSessionName,
} from "../src/ops.ts";
import type { TaskControl } from "../src/ops.ts";
import type { Loop } from "../src/state.ts";

const dir = mkdtempSync(join(tmpdir(), "pd-ops-"));
const status = (fn: () => unknown) => {
	try {
		fn();
	} catch (error) {
		return error instanceof HttpError ? error.status : `not an HttpError: ${String(error)}`;
	}
	return "no error";
};

describe("HttpError", () => {
	it("carries a status and a message", () => {
		const error = new HttpError(409, "nope");
		assert.equal(error.status, 409);
		assert.equal(error.message, "nope");
		assert.ok(error instanceof Error);
	});
});

describe("validateSessionName", () => {
	it("accepts letters, digits, dots, underscores and hyphens, trimmed", () => {
		for (const name of ["a", "A1", "my-session", "my_session", "my.session", "x".repeat(41), "0start"]) assert.equal(validateSessionName(name), name);
		assert.equal(validateSessionName("  padded  "), "padded");
	});

	it("refuses anything else with a 400", () => {
		for (const name of ["", "   ", ".hidden", "-x", "_x", "x".repeat(42), "a b", "a/b", "a\nb", "é", "a;b", undefined, null]) {
			assert.equal(status(() => validateSessionName(name)), 400, JSON.stringify(name));
		}
	});
});

describe("sendMode", () => {
	it("is steer only when asked", () => {
		assert.equal(sendMode({ mode: "steer" }), "steer");
		for (const body of [{}, { mode: "followUp" }, { mode: "STEER" }, { mode: 1 }]) assert.equal(sendMode(body), "followUp");
	});
});

describe("newMemory", () => {
	it("fills in defaults and is written by the human", () => {
		assert.deepEqual(newMemory({}, "7", 100), { id: "7", topic: "note", text: "", tags: [], by: "tony", updatedAt: 100 });
		assert.deepEqual(newMemory({ topic: "t", text: "x" }, "8", 5), { id: "8", topic: "t", text: "x", tags: [], by: "tony", updatedAt: 5 });
	});

	it("makes the project an absolute path, and ignores one that is not a string", () => {
		assert.equal(newMemory({ project: "relative/dir" }, "1", 0).project, resolve("relative/dir"));
		assert.equal(newMemory({ project: "/abs/dir" }, "1", 0).project, "/abs/dir");
		assert.equal("project" in newMemory({ project: 5 }, "1", 0), false);
	});

	it("coerces odd values to text", () => {
		assert.equal(newMemory({ text: 42 }, "1", 0).text, "42");
		assert.equal(newMemory({ topic: 5 }, "1", 0).topic, "5");
		assert.equal(newMemory({ topic: null, text: null }, "1", 0).topic, "note", "null falls back like a missing value");
		assert.equal(newMemory({ topic: null, text: null }, "1", 0).text, "");
	});
});

describe("auditTail", () => {
	const write = (name: string, content: string) => {
		const file = join(dir, name);
		writeFileSync(file, content);
		return file;
	};
	const lines = (n: number) => Array.from({ length: n }, (_, i) => JSON.stringify({ n: i }));

	it("returns the last entries, oldest first", () => {
		const file = write("a.jsonl", `${lines(10).join("\n")}\n`);
		assert.deepEqual(auditTail(file, 3), [{ n: 7 }, { n: 8 }, { n: 9 }]);
		assert.equal(auditTail(file, 100).length, 10);
		assert.deepEqual(auditTail(file, 0), [], "zero entries means none, not all");
		assert.deepEqual(auditTail(file, -3), []);
		assert.deepEqual(auditTail(file, Number.NaN), []);
	});

	it("handles an empty file, blank lines, and no trailing newline", () => {
		assert.deepEqual(auditTail(write("empty.jsonl", ""), 5), []);
		assert.deepEqual(auditTail(write("blank.jsonl", `\n\n${lines(2).join("\n\n")}\n\n`), 5), [{ n: 0 }, { n: 1 }]);
		assert.deepEqual(auditTail(write("nonl.jsonl", lines(2).join("\n")), 5), [{ n: 0 }, { n: 1 }]);
	});

	it("skips torn and garbled lines instead of failing", () => {
		const file = write("torn.jsonl", `${JSON.stringify({ n: 1 })}\n{"n": 2, "tor\n${JSON.stringify({ n: 3 })}\nnot json\n${JSON.stringify({ n: 4 })}\n{"n":5`);
		assert.deepEqual(auditTail(file, 10), [{ n: 1 }, { n: 3 }, { n: 4 }]);
	});

	it("reads only the end of a big file and drops the line it cut in half", () => {
		const all = lines(500);
		const file = write("big.jsonl", `${all.join("\n")}\n`);
		const tail = auditTail(file, 1000, 300) as { n: number }[];
		assert.ok(tail.length > 5 && tail.length < 30, String(tail.length));
		assert.equal(tail.at(-1)!.n, 499);
		assert.deepEqual(tail.map((entry) => entry.n), tail.map((_, i) => tail[0]!.n + i), "a contiguous run of whole entries");
		assert.ok(tail[0]!.n > 400);
	});

	it("does not choke on a multi-byte character cut by the window", () => {
		const file = write("utf8.jsonl", `${Array.from({ length: 50 }, (_, i) => JSON.stringify({ n: i, text: "héllo wörld ✓" })).join("\n")}\n`);
		const tail = auditTail(file, 100, 200) as { n: number }[];
		assert.ok(tail.length > 0);
		assert.equal(tail.at(-1)!.n, 49);
	});

	it("keeps the whole file when it is smaller than the window", () => {
		assert.equal(auditTail(write("small.jsonl", `${lines(3).join("\n")}\n`), 10, 10_000).length, 3);
	});

	it("throws for a missing file (the daemon checks first)", () => {
		assert.throws(() => auditTail(join(dir, "missing.jsonl"), 5), /ENOENT/);
	});
});

describe("approving a parked PR", () => {
	it("needs the commit that was reviewed", () => {
		assert.deepEqual(parseApproval({ repo: "o/r", number: "12", sha: "ABCDEF1" }), { repo: "o/r", number: 12, expected: "abcdef1" });
		assert.equal(parseApproval({ repo: "o/r", number: 3, sha: "a".repeat(40) }).expected, "a".repeat(40));
	});

	it("refuses a missing, short, long or non-hex commit with a 400 that says how", () => {
		for (const sha of [undefined, "", "abc123", "a".repeat(41), "ghijklm", "abc 123", "abcdef1;rm", 123456]) {
			assert.equal(status(() => parseApproval({ repo: "o/r", number: 1, sha })), 400, JSON.stringify(sha));
		}
		assert.throws(() => parseApproval({ repo: "o/r", number: 1 }), /pd approve <repo> <pr> <sha7>/);
	});

	it("accepts a head that starts with the commit that was seen", () => {
		const head = "abcdef1234567890abcdef1234567890abcdef12";
		assert.doesNotThrow(() => assertApprovedHead(head, "abcdef1"));
		assert.doesNotThrow(() => assertApprovedHead(head, head));
	});

	it("refuses with a 409 when the head moved, and says what it is now", () => {
		const head = "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		assert.equal(status(() => assertApprovedHead(head, "abcdef1")), 409);
		assert.throws(() => assertApprovedHead(head, "abcdef1"), /PR head is now 1111111, not abcdef1; review the new commit first/);
		assert.equal(status(() => assertApprovedHead("", "abcdef1")), 409, "no head at all is not an approval");
		assert.equal(status(() => assertApprovedHead("abc", "abcdef1")), 409, "a head shorter than the claim cannot match");
	});
});

describe("resolveLoopSpec", () => {
	it("needs a goal, or a preset", () => {
		assert.equal(status(() => resolveLoopSpec({})), 400);
		assert.equal(status(() => resolveLoopSpec({ goal: "" })), 400);
		assert.throws(() => resolveLoopSpec({}), /goal is required/);
		assert.equal(resolveLoopSpec({ goal: "ship it" }).goal, "ship it");
	});

	it("a preset supplies the brief and the interval, and wins over a given goal", () => {
		const spec = resolveLoopSpec({ preset: "keep-tests-tight", goal: "ignored" });
		assert.equal(spec.goal, CLEANUP_PROMPTS["keep-tests-tight"]);
		assert.equal(spec.preset, "keep-tests-tight");
		assert.equal(spec.intervalMinutes, 1440);
		assert.equal(resolveLoopSpec({ preset: "legacy-reaper" }).intervalMinutes, 10080);
		assert.equal(resolveLoopSpec({ preset: "friction-sweep" }).intervalMinutes, 1440);
	});

	it("an interval given with a preset is kept", () => {
		assert.equal(resolveLoopSpec({ preset: "docs-freshness", intervalMinutes: 90 }).intervalMinutes, 90);
	});

	it("refuses an unknown preset and lists the real ones", () => {
		for (const preset of ["nope", "", "KEEP-TESTS-TIGHT"]) assert.equal(status(() => resolveLoopSpec({ preset })), 400, preset);
		assert.throws(() => resolveLoopSpec({ preset: "nope" }), /keep-tests-tight, docs-freshness, legacy-reaper, friction-sweep/);
	});

	it("refuses names that only exist on every object", () => {
		for (const preset of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
			assert.equal(status(() => resolveLoopSpec({ preset, goal: "g" })), 400, preset);
		}
		assert.equal(status(() => resolveLoopSpec({ preset: 5 as never, goal: "g" })), 400);
		assert.equal(status(() => resolveLoopSpec({ preset: null as never, goal: "g" })), 400);
	});

	it("clamps the numbers into their limits", () => {
		const [minInterval, maxInterval] = LOOP_LIMITS.intervalMinutes;
		assert.equal(resolveLoopSpec({ goal: "g", intervalMinutes: 1 }).intervalMinutes, minInterval);
		assert.equal(resolveLoopSpec({ goal: "g", intervalMinutes: 0 }).intervalMinutes, minInterval);
		assert.equal(resolveLoopSpec({ goal: "g", intervalMinutes: -10 }).intervalMinutes, minInterval);
		assert.equal(resolveLoopSpec({ goal: "g", intervalMinutes: 10_000_000 }).intervalMinutes, maxInterval);
		assert.equal(resolveLoopSpec({ goal: "g", intervalMinutes: 30 }).intervalMinutes, 30);
		assert.equal(resolveLoopSpec({ goal: "g", maxIterations: 0 }).maxIterations, 1);
		assert.equal(resolveLoopSpec({ goal: "g", maxIterations: 5000 }).maxIterations, 1000);
		assert.equal(resolveLoopSpec({ goal: "g", maxIterations: 24 }).maxIterations, 24);
		assert.equal(resolveLoopSpec({ goal: "g", budgetUsd: 0 }).budgetUsd, 0.01);
		assert.equal(resolveLoopSpec({ goal: "g", budgetUsd: -5 }).budgetUsd, 0.01);
		assert.equal(resolveLoopSpec({ goal: "g", budgetUsd: 1e9 }).budgetUsd, 1000);
		assert.equal(resolveLoopSpec({ goal: "g", budgetUsd: 2.5 }).budgetUsd, 2.5);
	});

	it("leaves a missing or non-numeric value undefined, so the policy default applies", () => {
		const spec = resolveLoopSpec({ goal: "g" });
		assert.deepEqual([spec.intervalMinutes, spec.maxIterations, spec.budgetUsd], [undefined, undefined, undefined]);
		for (const bad of [Number.NaN, Infinity, -Infinity, "30" as never, null as never, {} as never]) {
			const out = resolveLoopSpec({ goal: "g", intervalMinutes: bad, maxIterations: bad, budgetUsd: bad });
			assert.deepEqual([out.intervalMinutes, out.maxIterations, out.budgetUsd], [undefined, undefined, undefined], String(bad));
		}
	});

	it("does not change the request it was given", () => {
		const body = { goal: "g", intervalMinutes: 1, preset: undefined };
		resolveLoopSpec(body);
		assert.deepEqual(body, { goal: "g", intervalMinutes: 1, preset: undefined });
	});
});

describe("newLoop", () => {
	const defaults = { defaultBudgetUsd: 5, defaultIntervalMinutes: 60, defaultMaxIterations: 24 };
	const make = (spec: Parameters<typeof newLoop>[0]["spec"]) => newLoop({ id: "L3", session: "s1", spec, defaults, costAtStart: 1.25, now: 1_000 });

	it("fills what the request left out from the policy defaults", () => {
		assert.deepEqual(make({ goal: "g" }), {
			id: "L3", session: "s1", goal: "g", intervalMinutes: 60, maxIterations: 24, budgetUsd: 5, iteration: 0, status: "active",
			note: "", createdAt: 1_000, nextRunAt: 1_000, costAtStart: 1.25,
		});
	});

	it("uses what the request set", () => {
		const loop = make({ goal: "g", intervalMinutes: 15, maxIterations: 3, budgetUsd: 0.5 });
		assert.deepEqual([loop.intervalMinutes, loop.maxIterations, loop.budgetUsd], [15, 3, 0.5]);
	});

	it("starts due now, with the budget window starting at the session's spend", () => {
		const loop = make({ goal: "g" });
		assert.equal(loop.nextRunAt, loop.createdAt);
		assert.equal(loop.costAtStart, 1.25);
		assert.equal("taskId" in loop, false);
	});

	it("a goal loop has no kind", () => {
		assert.equal("kind" in make({ goal: "g" }), false);
	});

	it("a preset sets the kind and the idle window from its schedule", () => {
		const reaper = make({ goal: "g", preset: "legacy-reaper" });
		assert.equal(reaper.kind, "cleanup");
		assert.equal(reaper.skipIfIdleHours, 168);
		assert.equal(make({ goal: "g", preset: "keep-tests-tight" }).skipIfIdleHours, 24);
		const sweep = make({ goal: "g", preset: "friction-sweep" });
		assert.equal(sweep.kind, "friction-sweep");
		assert.equal("skipIfIdleHours" in sweep, false);
		for (const name of Object.keys(CLEANUP_SCHEDULE)) assert.equal(make({ goal: "g", preset: name as never }).kind, CLEANUP_SCHEDULE[name as keyof typeof CLEANUP_SCHEDULE].kind);
	});
});

const base = (): Loop => ({
	id: "L1", session: "s1", goal: "g", intervalMinutes: 60, maxIterations: 10, budgetUsd: 5, iteration: 3, status: "paused", note: "blocked",
	createdAt: 0, costAtStart: 2, lastSeenBaseSha: "abc",
});

describe("applyLoopSettings", () => {
	it("applies sane values", () => {
		const loop = base();
		applyLoopSettings(loop, { intervalMinutes: 30, maxIterations: 50, budgetUsd: 9 });
		assert.deepEqual([loop.intervalMinutes, loop.maxIterations, loop.budgetUsd], [30, 50, 9]);
	});

	it("ignores an interval under five minutes, a cap under one, and a non-positive budget", () => {
		const loop = base();
		applyLoopSettings(loop, { intervalMinutes: 4, maxIterations: 0, budgetUsd: 0 });
		assert.deepEqual([loop.intervalMinutes, loop.maxIterations, loop.budgetUsd], [60, 10, 5]);
		applyLoopSettings(loop, { intervalMinutes: -1, maxIterations: -3, budgetUsd: -1 });
		assert.deepEqual([loop.intervalMinutes, loop.maxIterations, loop.budgetUsd], [60, 10, 5]);
		applyLoopSettings(loop, { intervalMinutes: 5 });
		assert.equal(loop.intervalMinutes, 5, "five minutes is the floor, and allowed");
	});

	it("ignores values that are not numbers, and fields it does not know", () => {
		const loop = base();
		applyLoopSettings(loop, { intervalMinutes: "30", maxIterations: null, budgetUsd: {}, goal: "hijack", status: "done" });
		assert.deepEqual(loop, base());
	});

	it("changes only what was sent", () => {
		const loop = base();
		applyLoopSettings(loop, { budgetUsd: 7 });
		assert.deepEqual([loop.intervalMinutes, loop.maxIterations, loop.budgetUsd], [60, 10, 7]);
	});
});

describe("stopPatch, assertResumable and applyResume", () => {
	it("pause and stop record what happened", () => {
		assert.deepEqual(stopPatch("pause"), { status: "paused", note: "paused by user" });
		assert.deepEqual(stopPatch("stop"), { status: "done", note: "stopped by user" });
	});

	it("refuses to resume a loop that is already active, so only one task runs it", () => {
		assert.equal(status(() => assertResumable({ id: "L1", status: "active" })), 409);
		assert.throws(() => assertResumable({ id: "L1", status: "active" }), /loop L1 is already active/);
		for (const loopStatus of ["paused", "done", "failed"] as const) assert.doesNotThrow(() => assertResumable({ id: "L1", status: loopStatus }));
	});

	it("resuming activates the loop now with a fresh budget window, and keeps its history", () => {
		const loop = base();
		applyResume(loop, 9.5, 5_000);
		assert.equal(loop.status, "active");
		assert.equal(loop.note, "resumed");
		assert.equal(loop.nextRunAt, 5_000);
		assert.equal(loop.costAtStart, 9.5);
		assert.equal(loop.iteration, 3);
		assert.equal(loop.lastSeenBaseSha, "abc");
		assert.equal(loop.budgetUsd, 5);
	});
});

describe("endLiveTask", () => {
	type Call = string;
	const control = (task: { state: { status: string } } | undefined, options: { failAbort?: boolean } = {}) => {
		const calls: Call[] = [];
		const tasks: TaskControl = {
			getTask: async (id) => {
				calls.push(`get ${String(id)}`);
				return task;
			},
			abortTask: async (id) => {
				calls.push(`abort ${String(id)}`);
				if (options.failAbort) throw new Error("abort failed");
			},
			waitForTask: async (id) => {
				calls.push(`wait ${String(id)}`);
			},
		};
		return { tasks, calls };
	};

	it("does nothing for a loop with no task", async () => {
		const { tasks, calls } = control({ state: { status: "running" } });
		assert.equal(await endLiveTask(tasks, undefined, {}, { wait: true }), false);
		assert.deepEqual(calls, []);
	});

	it("does nothing when the task is gone or already finished", async () => {
		for (const task of [undefined, { state: { status: "terminal" } }]) {
			const { tasks, calls } = control(task);
			assert.equal(await endLiveTask(tasks, 7, {}, { wait: true }), false);
			assert.deepEqual(calls, ["get 7"]);
		}
	});

	it("pausing aborts a live task and does not wait for it", async () => {
		const { tasks, calls } = control({ state: { status: "sleeping" } });
		assert.equal(await endLiveTask(tasks, 7, {}, { wait: false }), true);
		assert.deepEqual(calls, ["get 7", "abort 7"]);
	});

	it("resuming aborts a live task, then waits for it to end before anything new starts", async () => {
		const { tasks, calls } = control({ state: { status: "running" } });
		assert.equal(await endLiveTask(tasks, 7, {}, { wait: true }), true);
		assert.deepEqual(calls, ["get 7", "abort 7", "wait 7"]);
	});

	it("treats any non-terminal status as live", async () => {
		for (const state of ["running", "sleeping", "waiting", "blocked", "pending"]) {
			const { tasks, calls } = control({ state: { status: state } });
			assert.equal(await endLiveTask(tasks, 1, {}, { wait: false }), true, state);
			assert.ok(calls.includes("abort 1"));
		}
	});

	it("does not wait when the abort fails, and lets the error through", async () => {
		const { tasks, calls } = control({ state: { status: "running" } }, { failAbort: true });
		await assert.rejects(endLiveTask(tasks, 7, {}, { wait: true }), /abort failed/);
		assert.deepEqual(calls, ["get 7", "abort 7"]);
	});
});

describe("parseRepo", () => {
	it("accepts owner/name", () => {
		assert.deepEqual(parseRepo("o/r"), { repo: "o/r", owner: "o", name: "r" });
		assert.deepEqual(parseRepo("my-org/my.repo_2"), { repo: "my-org/my.repo_2", owner: "my-org", name: "my.repo_2" });
		assert.equal(parseRepo("a/b...c").name, "b...c");
	});

	it("refuses anything else, including parts that would escape the projects directory", () => {
		for (const repo of ["", "x", "a/b/c", "../x", "a/..", "./x", "a/.", "../..", " a/b", "a/b ", "a b/c", "a/b;rm", "a/b?x", "a/é", "/b", "a/", "--help", undefined, null]) {
			assert.equal(status(() => parseRepo(repo)), 400, JSON.stringify(repo));
		}
		assert.throws(() => parseRepo("a/.."), /repo must be owner\/name/);
	});
});

describe("projectSessionName", () => {
	it("defaults to the repo name, lowercased, without its extension", () => {
		assert.equal(projectSessionName("succulents.info", undefined), "succulents");
		assert.equal(projectSessionName("Pi-Durable-Local", null), "pi-durable-local");
		assert.equal(projectSessionName("plain", undefined), "plain");
	});

	it("uses a given name, lowercased", () => {
		assert.equal(projectSessionName("repo", "My-Project"), "my-project");
	});

	it("refuses an unsafe name with a 400", () => {
		for (const name of [".hidden", "-x", "a..b", "x".repeat(42), "a b", "a/b", "", "é"]) {
			assert.equal(status(() => projectSessionName("repo", name)), 400, JSON.stringify(name));
		}
		assert.equal(status(() => projectSessionName("..", undefined)), 400);
		assert.throws(() => projectSessionName("repo", ".x"), /invalid session name/);
	});
});

describe("projectDir", () => {
	it("is the repo name under the writable root, with ~ expanded", () => {
		assert.equal(projectDir("~/proj", "repo", "/home/u"), "/home/u/proj/repo");
		assert.equal(projectDir("~", "repo", "/home/u"), "/home/u/repo");
		assert.equal(projectDir("/work", "repo", "/home/u"), "/work/repo");
		assert.equal(projectDir(`${homedir()}/proj`, "x", homedir()), join(homedir(), "proj", "x"));
	});

	it("only expands a leading ~ by itself", () => {
		assert.equal(projectDir("~other/proj", "repo", "/home/u"), resolve("~other/proj", "repo"));
		assert.equal(projectDir("/a/~/b", "repo", "/home/u"), "/a/~/b/repo");
	});
});

describe("cloning", () => {
	it("runs git with hooks off, quietly, from the SSH URL, into the directory", () => {
		assert.deepEqual(cloneArgs("o/r", "/work/r"), ["-c", "core.hooksPath=/dev/null", "clone", "--quiet", "git@github.com:o/r.git", "/work/r"]);
	});

	it("uses no global or system git config and never prompts", () => {
		const env = cloneEnv({ PATH: "/bin", HOME: "/home/u", GIT_CONFIG_GLOBAL: "/evil", GIT_TERMINAL_PROMPT: "1" });
		assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
		assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
		assert.equal(env.GIT_TERMINAL_PROMPT, "0");
		assert.equal(env.PATH, "/bin");
		assert.equal(env.HOME, "/home/u");
	});

	it("does not change the environment it was given", () => {
		const input = { PATH: "/bin" };
		cloneEnv(input);
		assert.deepEqual(input, { PATH: "/bin" });
	});
});

describe("editProjectPolicy", () => {
	const policy = () => ({ model: "m", automerge: { repos: ["a/a"], baseBranches: { "a/a": "main" }, branchPrefix: "pd/" } });

	it("records the base branch for the repo, keeping the others", () => {
		const { policy: edited, mergeEnabled } = editProjectPolicy(policy(), { repo: "o/r", baseBranch: "develop" });
		assert.deepEqual(edited.automerge?.baseBranches, { "a/a": "main", "o/r": "develop" });
		assert.deepEqual(edited.automerge?.repos, ["a/a"]);
		assert.equal(mergeEnabled, false);
	});

	it("allowlists the repo for merging once, keeping the others", () => {
		const first = editProjectPolicy(policy(), { repo: "o/r", merge: true });
		assert.deepEqual(first.policy.automerge?.repos, ["a/a", "o/r"]);
		assert.equal(first.mergeEnabled, true);
		const again = editProjectPolicy(first.policy, { repo: "o/r", merge: true });
		assert.deepEqual(again.policy.automerge?.repos, ["a/a", "o/r"], "no duplicate");
	});

	it("does both at once, and leaves everything else alone", () => {
		const { policy: edited } = editProjectPolicy(policy(), { repo: "o/r", baseBranch: "develop", merge: true });
		assert.equal(edited.model, "m");
		assert.equal(edited.automerge?.branchPrefix, "pd/");
		assert.deepEqual(edited.automerge?.repos, ["a/a", "o/r"]);
		assert.equal(edited.automerge?.baseBranches?.["o/r"], "develop");
	});

	it("creates the automerge section when the policy has none", () => {
		const { policy: edited } = editProjectPolicy({ model: "m" }, { repo: "o/r", merge: true });
		assert.deepEqual(edited.automerge, { repos: ["o/r"] });
	});

	it("does not allowlist when merging was not asked for", () => {
		for (const merge of [undefined, false]) assert.deepEqual(editProjectPolicy(policy(), { repo: "o/r", baseBranch: "x", merge }).policy.automerge?.repos, ["a/a"]);
	});

	it("does not change the policy it was given", () => {
		const original = policy();
		editProjectPolicy(original, { repo: "o/r", baseBranch: "develop", merge: true });
		assert.deepEqual(original, policy());
	});
});

describe("updateProjectPolicy", () => {
	const fresh = (content: string) => {
		const file = join(dir, `policy-${Math.random().toString(36).slice(2)}.json`);
		writeFileSync(file, content);
		return file;
	};

	it("neither reads nor writes when there is nothing to change", () => {
		assert.equal(updateProjectPolicy(join(dir, "does-not-exist.json"), { repo: "o/r" }), undefined);
		assert.equal(updateProjectPolicy(join(dir, "does-not-exist.json"), { repo: "o/r", baseBranch: "", merge: false }), undefined);
		const file = fresh('{"keep":"as is"}');
		utimesSync(file, 1, 1);
		updateProjectPolicy(file, { repo: "o/r" });
		assert.equal(statSync(file).mtimeMs, 1000, "untouched");
	});

	it("rewrites the file with tab indentation and a trailing newline, and reports the merge", () => {
		const file = fresh(JSON.stringify({ model: "m", automerge: { repos: [] } }));
		assert.deepEqual(updateProjectPolicy(file, { repo: "o/r", merge: true }), { mergeEnabled: true });
		const text = readFileSync(file, "utf8");
		assert.ok(text.endsWith("}\n"));
		assert.match(text, /\n\t"model": "m"/);
		assert.deepEqual(JSON.parse(text), { model: "m", automerge: { repos: ["o/r"] } });
		assert.deepEqual(updateProjectPolicy(file, { repo: "o/x", baseBranch: "develop" }), { mergeEnabled: false });
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).automerge, { repos: ["o/r"], baseBranches: { "o/x": "develop" } });
	});

	it("throws on a policy file that is not JSON, and leaves it as it was", () => {
		const file = fresh("{ not json");
		assert.throws(() => updateProjectPolicy(file, { repo: "o/r", merge: true }));
		assert.equal(readFileSync(file, "utf8"), "{ not json");
	});
});
