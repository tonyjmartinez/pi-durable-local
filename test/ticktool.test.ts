// pr_tick with `wait: true`: the daemon polls CI itself instead of the agent sleeping and ticking. The 20-second
// polls run on mock timers, so five simulated minutes take milliseconds; GitHub is the fake gh.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { makeFakeGh, makeStore } from "./fakegh.helper.ts";
import { APPROVE, fakeModels, pending, pr, run, shipScript, usageOf } from "./shipfixtures.helper.ts";

const root = mkdtempSync(join(tmpdir(), "pd-wait-"));
process.env.PD_DATA_DIR = join(root, "data");
process.env.PD_CONFIG_DIR = join(root, "cfg");
delete process.env.PD_NOTIFY_URL;
mkdirSync(process.env.PD_DATA_DIR, { recursive: true });
mkdirSync(process.env.PD_CONFIG_DIR, { recursive: true });
writeFileSync(join(process.env.PD_CONFIG_DIR, "policy.json"), JSON.stringify({ automerge: { repos: ["o/r"] } }));
const gh = makeFakeGh(join(root, "fake"));
const ext = await import("../src/extensions.ts");
const { Sessions } = await import("../src/state.ts");

const POLL_MS = 20_000;
type Result = { output: { text: string }[]; isError?: boolean; usage?: ReturnType<typeof usageOf> };

let store: ReturnType<typeof makeStore>;
let scheduled: number;
let realSetTimeout: typeof setTimeout;
let mockedSetTimeout: typeof setTimeout;
const text = (result: Result) => result.output.map((part) => part.text).join("\n");
const gathers = () => gh.callsMatching(/^pr view 7 --repo o\/r --json number,/).length;
const mergeCalls = () => gh.callsMatching(/^pr merge /).length;

/** Start the tool, then advance the mock clock one poll at a time, only while the tool is actually waiting. */
async function pollingTick(args: { number: number; wait?: boolean }, models = fakeModels([APPROVE]), maxPolls = 40): Promise<Result> {
	const tool = ext.Git_.tools!.find((entry) => entry.name === "pr_tick")!.execute as (args: unknown, api: unknown, context: unknown) => Promise<Result>;
	const api = { conversationId: 1, snapshot: store.snapshot.bind(store), commit: store.commit.bind(store), models };
	let finished = false;
	const promise = tool(args, api, {}).finally(() => {
		finished = true;
	});
	for (let polls = 0; polls < maxPolls && !finished; polls++) {
		const started = performance.now();
		// Real time passes while gh runs; wait (without timers) until the tool either finishes or sleeps for a poll.
		while (!finished && scheduled <= polls && performance.now() - started < 20_000) await new Promise((resolve) => setImmediate(resolve));
		if (finished) break;
		assert.ok(scheduled > polls, "the tool neither finished nor waited for a poll");
		mock.timers.tick(POLL_MS);
	}
	return promise;
}

beforeEach(() => {
	store = makeStore();
	store.seed(Sessions, { byName: { s1: { conversationId: 1, cwd: "/work/r", purpose: "", createdAt: 0, remote: "git@github.com:o/r.git" } } });
	ext.setHarness(store as never);
	scheduled = 0;
	realSetTimeout = globalThis.setTimeout;
	mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
	mockedSetTimeout = globalThis.setTimeout;
	// Count the poll sleeps (other timers pass straight through to the mock).
	globalThis.setTimeout = ((handler: () => void, ms?: number, ...rest: unknown[]) => {
		if (ms === POLL_MS) scheduled++;
		return (mockedSetTimeout as unknown as (...a: unknown[]) => unknown)(handler, ms, ...rest);
	}) as typeof setTimeout;
});
afterEach(() => {
	globalThis.setTimeout = mockedSetTimeout;
	mock.timers.reset();
	assert.equal(globalThis.setTimeout, realSetTimeout, "the real timers are back");
});

describe("pr_tick with wait: true", () => {
	const RUNNING = [run("ci"), pending("e2e")];
	const DONE = [run("ci"), run("e2e")];

	it("polls every 20 seconds while CI runs, then carries on to the merge", async () => {
		shipScript(gh, { runs: [RUNNING, RUNNING, DONE] });
		const before = Date.now();
		const result = await pollingTick({ number: 7, wait: true });
		assert.match(text(result), /^MERGED #7/);
		assert.equal(scheduled, 2, "two polls");
		assert.equal(Date.now() - before, 2 * POLL_MS, "the mock clock moved exactly two polls");
		assert.equal(mergeCalls(), 1);
		assert.equal(gh.callsMatching(/compare\/.* -H Accept/).length, 1, "reviewed once");
	});

	it("reports the review's cost once, however many polls came before it", async () => {
		shipScript(gh, { runs: [RUNNING, RUNNING, RUNNING, DONE] });
		const result = await pollingTick({ number: 7, wait: true });
		assert.equal(scheduled, 3);
		assert.deepEqual(result.usage, usageOf(1_000, 200, 0.05));
	});

	it("does not spend a review while checks are still running", async () => {
		shipScript(gh, { runs: [RUNNING] });
		const models = fakeModels([APPROVE]);
		await pollingTick({ number: 7, wait: true }, models);
		assert.equal(models.calls.length, 0);
	});

	it("gives up after five minutes and returns the wait-ci decision, not an error", async () => {
		shipScript(gh, { runs: [RUNNING] });
		const before = Date.now();
		const result = await pollingTick({ number: 7, wait: true });
		assert.equal(scheduled, 15, "15 polls of 20 seconds");
		assert.equal(Date.now() - before, 5 * 60_000);
		assert.equal(gathers(), 16, "the first tick plus one per poll");
		assert.match(text(result), /^Next action: wait-ci/);
		assert.ok(!result.isError, "waiting is not a failure");
		assert.equal(mergeCalls(), 0);
	});

	it("stops polling the moment the decision changes to something the agent must act on", async () => {
		shipScript(gh, { runs: [RUNNING, [run("ci", "failure"), run("e2e")]] });
		const result = await pollingTick({ number: 7, wait: true });
		assert.equal(scheduled, 1);
		assert.equal(result.isError, true);
		assert.match(text(result), /^Next action: fix-ci/);
	});

	it("stops polling when the PR parks", async () => {
		shipScript(gh, { files: [".github/workflows/ci.yml"], runs: [RUNNING, DONE] });
		const result = await pollingTick({ number: 7, wait: true });
		assert.equal(scheduled, 1);
		assert.match(text(result), /^Next action: park-human/);
	});

	it("does not poll when nothing is waiting", async () => {
		shipScript(gh, { runs: [DONE] });
		const result = await pollingTick({ number: 7, wait: true });
		assert.equal(scheduled, 0);
		assert.match(text(result), /^MERGED/);
	});

	it("reports a failure on a poll instead of hanging", async () => {
		shipScript(gh, { runs: [RUNNING], prViews: [JSON.stringify(pr()), { code: 1, stderr: "HTTP 502" }] });
		const result = await pollingTick({ number: 7, wait: true });
		assert.equal(scheduled, 1);
		assert.equal(result.isError, true);
		assert.match(text(result), /^pr_tick failed/);
	});
});

describe("pr_tick without wait", () => {
	it("returns the wait-ci decision at once and tells the agent to use wait: true", async () => {
		shipScript(gh, { runs: [[run("ci"), pending("e2e")]] });
		for (const args of [{ number: 7 }, { number: 7, wait: false }]) {
			scheduled = 0;
			const result = await pollingTick(args);
			assert.equal(scheduled, 0, JSON.stringify(args));
			assert.match(text(result), /^Next action: wait-ci/);
			assert.match(text(result), /wait: true/);
			assert.match(text(result), /don't sleep in bash/);
		}
	});

	it("accepts wait in the tool's parameters", () => {
		const parameters = ext.Git_.tools!.find((entry) => entry.name === "pr_tick")!.parameters as unknown as { properties: Record<string, { type: string }> };
		assert.equal(parameters.properties.wait?.type, "boolean");
		assert.equal(parameters.properties.number?.type, "number");
	});
});
