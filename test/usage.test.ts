// Spend that used to go unrecorded now rides on tool results: the independent review (through pr_tick and pr_merge)
// and web_search, so loop budgets and `pd status` count it. The Anthropic API is a local server; GitHub is fake.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { makeFakeGh, makeStore } from "./fakegh.helper.ts";
import { APPROVE, fakeModels, REJECT, run, shipScript, usageOf } from "./shipfixtures.helper.ts";

const root = mkdtempSync(join(tmpdir(), "pd-usage-"));
process.env.PD_DATA_DIR = join(root, "data");
process.env.PD_CONFIG_DIR = join(root, "cfg");
delete process.env.PD_NOTIFY_URL;
mkdirSync(process.env.PD_DATA_DIR, { recursive: true });
mkdirSync(process.env.PD_CONFIG_DIR, { recursive: true });
writeFileSync(join(process.env.PD_CONFIG_DIR, "policy.json"), JSON.stringify({ automerge: { repos: ["o/r"] } }));
const gh = makeFakeGh(join(root, "fake"));
const ext = await import("../src/extensions.ts");
const { Sessions } = await import("../src/state.ts");

const context = {} as never;
type Result = { output: { text: string }[]; isError?: boolean; usage?: ReturnType<typeof usageOf> };
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

describe("addUsage", () => {
	const a = usageOf(1_000, 200, 0.05);
	const b = { ...usageOf(500, 100, 0.02), cacheRead: 300, cacheWrite: 50 };

	it("passes a lone value through, and nothing for nothing", () => {
		assert.equal(ext.addUsage(undefined, undefined), undefined);
		assert.equal(ext.addUsage(a, undefined), a);
		assert.equal(ext.addUsage(undefined, b), b);
	});

	it("adds every counter and every cost", () => {
		const sum = ext.addUsage(a, b)!;
		assert.deepEqual([sum.input, sum.output, sum.cacheRead, sum.cacheWrite, sum.totalTokens], [1_500, 300, 300, 50, 1_800]);
		close(sum.cost.input, a.cost.input + b.cost.input);
		close(sum.cost.output, a.cost.output + b.cost.output);
		close(sum.cost.total, 0.07);
	});

	it("does not change what it was given, and chains", () => {
		const snapshot = JSON.stringify([a, b]);
		const three = ext.addUsage(ext.addUsage(a, b), usageOf(1, 1, 0.01))!;
		assert.equal(JSON.stringify([a, b]), snapshot);
		close(three.cost.total, 0.08);
	});
});

describe("reviewWith", () => {
	const policy = { reviewModel: "anthropic/claude-opus-5-5" } as never;
	const subject = { title: "Fix", body: "body" } as never;
	const review = (models: ReturnType<typeof fakeModels>) => ext.reviewWith(models as never, policy, context);

	it("returns the verdict together with what the review cost", async () => {
		const usage = usageOf(2_000, 300, 0.11);
		const models = fakeModels([APPROVE], usage);
		const verdict = await review(models)(subject, "a small diff");
		assert.equal(verdict.approve, true);
		assert.deepEqual(verdict.usage, usage);
	});

	it("reports the cost of a rejection as well", async () => {
		const verdict = await review(fakeModels([REJECT], usageOf(100, 20, 0.01)))(subject, "diff");
		assert.equal(verdict.approve, false);
		close(verdict.usage!.cost.total, 0.01);
	});

	it("reports the cost when the reply is rejected for conflicting verdicts", async () => {
		const verdict = await review(fakeModels([`quoted {"approve": true} then ${REJECT}`]))(subject, "diff");
		assert.equal(verdict.approve, false);
		assert.equal(verdict.usage?.totalTokens, 1_200);
	});

	it("reports nothing when the model gave no usage", async () => {
		const verdict = await review(fakeModels([APPROVE], null))(subject, "diff");
		assert.equal(verdict.usage, undefined);
	});

	it("spends nothing, and reports nothing, on a diff too large to read", async () => {
		const models = fakeModels([APPROVE]);
		const verdict = await review(models)(subject, "x".repeat(200_001));
		assert.equal(models.calls.length, 0);
		assert.equal(verdict.approve, false);
		assert.equal("usage" in verdict, false);
	});

	it("spends nothing when the review model is not in the catalog", async () => {
		const models = { ...fakeModels([APPROVE]), getModels: () => [] };
		const verdict = await ext.reviewWith(models as never, policy, context)(subject, "diff");
		assert.equal(verdict.approve, false);
		assert.match(verdict.reasons[0]!, /not found/);
		assert.equal("usage" in verdict, false);
	});

	it("throws for a reply with no verdict, so nothing is cached and the next tick retries", async () => {
		await assert.rejects(review(fakeModels(["no json here"]))(subject, "diff"), /review failed: unparseable review reply/);
	});
});

describe("tickPr and the pr tools report the review's cost", () => {
	let store: ReturnType<typeof makeStore>;
	const REVIEW_COST = usageOf(1_000, 200, 0.05);
	const tool = (name: string) => ext.Git_.tools!.find((entry) => entry.name === name)!.execute as (args: unknown, api: unknown, context: unknown) => Promise<Result>;
	const call = (name: string, args: unknown, models: ReturnType<typeof fakeModels>) =>
		tool(name)(args, { conversationId: 1, snapshot: store.snapshot.bind(store), commit: store.commit.bind(store), models }, context);
	const tick = (models: ReturnType<typeof fakeModels>, allowMerge = true) =>
		ext.tickPr("o/r", 7, models as never, store as never, context, { allowMerge, session: "s1" });
	const text = (result: Result) => result.output.map((part) => part.text).join("\n");

	beforeEach(() => {
		store = makeStore();
		store.seed(Sessions, { byName: { s1: { conversationId: 1, cwd: "/work/r", purpose: "", createdAt: 0, remote: "git@github.com:o/r.git" } } });
		ext.setHarness(store as never);
		shipScript(gh);
	});

	describe("tickPr", () => {
		it("carries the cost of the review it ran, on a merge", async () => {
			const outcome = await tick(fakeModels([APPROVE]));
			assert.equal(outcome.merged, true);
			assert.deepEqual(outcome.usage, REVIEW_COST);
		});

		it("carries it when the review rejects, and when the PR then parks", async () => {
			const rejected = await tick(fakeModels([REJECT]));
			assert.equal(rejected.decision.action, "address-review");
			assert.deepEqual(rejected.usage, REVIEW_COST);
			store = makeStore();
			shipScript(gh, { files: [".github/workflows/ci.yml"] });
			const parked = await tick(fakeModels([APPROVE]));
			assert.equal(parked.decision.action, "park-human");
			assert.deepEqual(parked.usage, REVIEW_COST);
		});

		it("carries it on a dry run, which also spends the review", async () => {
			assert.deepEqual((await tick(fakeModels([APPROVE]), false)).usage, REVIEW_COST);
		});

		it("reports no usage when the verdict was already cached", async () => {
			const models = fakeModels([REJECT]);
			await tick(models);
			const again = await tick(models);
			assert.equal(models.calls.length, 1);
			assert.equal(again.usage, undefined);
		});

		it("reports no usage when no review was needed", async () => {
			shipScript(gh, { runs: [[run("ci", "success"), run("e2e", null, "github-actions", "in_progress")]] });
			const models = fakeModels([APPROVE]);
			const outcome = await tick(models);
			assert.equal(outcome.decision.action, "wait-ci");
			assert.equal(models.calls.length, 0);
			assert.equal(outcome.usage, undefined);
		});

		it("reports no usage for a PR the factory does not own", async () => {
			shipScript(gh, { pr: { isCrossRepository: true } });
			const models = fakeModels([APPROVE]);
			const outcome = await tick(models);
			assert.equal(models.calls.length, 0);
			assert.equal(outcome.usage, undefined);
		});

		it("reports no usage when the model gave none", async () => {
			assert.equal((await tick(fakeModels([APPROVE], null))).usage, undefined);
		});
	});

	describe("pr_tick", () => {
		it("puts the review's cost on the tool result", async () => {
			const result = await call("pr_tick", { number: 7 }, fakeModels([APPROVE]));
			assert.match(text(result), /^MERGED #7/);
			assert.equal(result.isError, undefined);
			assert.deepEqual(result.usage, REVIEW_COST);
		});

		it("does so for a result that is an error to the agent, too", async () => {
			const result = await call("pr_tick", { number: 7 }, fakeModels([REJECT]));
			assert.equal(result.isError, true);
			assert.match(text(result), /^Next action: address-review/);
			assert.deepEqual(result.usage, REVIEW_COST);
		});

		it("does so for a PR that parks", async () => {
			shipScript(gh, { files: [".github/workflows/ci.yml"] });
			const result = await call("pr_tick", { number: 7 }, fakeModels([REJECT]));
			assert.match(text(result), /^Next action: park-human/);
			assert.deepEqual(result.usage, REVIEW_COST);
		});

		it("has no usage key at all when nothing was spent", async () => {
			const models = fakeModels([APPROVE]);
			await call("pr_tick", { number: 7 }, models);
			store = makeStore();
			store.seed(Sessions, { byName: { s1: { conversationId: 1, cwd: "/work/r", purpose: "", createdAt: 0, remote: "git@github.com:o/r.git" } } });
			ext.setHarness(store as never);
			shipScript(gh, { pr: { mergeStateStatus: "BEHIND" } });
			const result = await call("pr_tick", { number: 7 }, fakeModels([APPROVE]));
			assert.match(text(result), /update-branch/);
			assert.equal("usage" in result, false);
		});

		it("reports nothing when the tick itself fails", async () => {
			gh.script([{ match: ".", responses: [{ code: 1, stderr: "HTTP 502" }] }]);
			const result = await call("pr_tick", { number: 7 }, fakeModels([APPROVE]));
			assert.equal(result.isError, true);
			assert.match(text(result), /^pr_tick failed/);
			assert.equal("usage" in result, false);
		});

		it("is refused for a conversation that is not a session", async () => {
			const result = await tool("pr_tick")({ number: 7 }, { conversationId: 99, snapshot: store.snapshot.bind(store), commit: store.commit.bind(store), models: fakeModels([APPROVE]) }, context);
			assert.equal(result.isError, true);
			assert.equal("usage" in result, false);
		});
	});

	describe("pr_merge", () => {
		it("reports the review's cost when it merges", async () => {
			const result = await call("pr_merge", { number: 7 }, fakeModels([APPROVE]));
			assert.equal(result.isError, undefined);
			assert.deepEqual(result.usage, REVIEW_COST);
		});

		it("reports it when it does not merge, which pr_merge shows as an error", async () => {
			const result = await call("pr_merge", { number: 7 }, fakeModels([REJECT]));
			assert.equal(result.isError, true);
			assert.deepEqual(result.usage, REVIEW_COST);
		});

		it("refuses another repo's PR before spending anything", async () => {
			const models = fakeModels([APPROVE]);
			const result = await call("pr_merge", { repo: "other/repo", number: 7 }, models);
			assert.equal(result.isError, true);
			assert.match(text(result), /only merge PRs in your own repo \(o\/r\)/);
			assert.equal(models.calls.length, 0);
			assert.equal("usage" in result, false);
		});
	});
});

describe("web_search reports what the search cost", () => {
	type Reply = { status?: number; headers?: Record<string, string>; body: unknown };
	let server: Server;
	let replies: Reply[];
	let requests: { headers: IncomingMessage["headers"]; body: any }[];
	const search = ext.Web_.tools!.find((entry) => entry.name === "web_search")!;
	const execute = search.execute as (args: { query: string; allowedDomains?: string[] }, api: unknown, context: unknown) => Promise<Result>;
	const withModels = (models: unknown) => ({ models });
	const catalog = fakeModels([]);

	const message = (options: { text?: string; citations?: { url: string; title: string }[]; results?: { url: string; title: string }[]; stop?: string; usage?: Record<string, unknown> } = {}) => ({
		id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", stop_sequence: null,
		content: [
			...(options.results ? [{ type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: options.results.map((r) => ({ type: "web_search_result", url: r.url, title: r.title, encrypted_content: "x", page_age: null })) }] : []),
			{ type: "text", text: options.text ?? "The answer.", citations: (options.citations ?? []).map((c) => ({ type: "web_search_result_location", url: c.url, title: c.title, cited_text: "x", encrypted_index: "i" })) },
		],
		stop_reason: options.stop ?? "end_turn",
		usage: { input_tokens: 10_000, output_tokens: 1_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: 1 }, ...options.usage },
	});

	before(async () => {
		server = createServer((request: IncomingMessage, response: ServerResponse) => {
			let raw = "";
			request.on("data", (chunk: Buffer) => (raw += chunk));
			request.on("end", () => {
				requests.push({ headers: request.headers, body: raw === "" ? undefined : JSON.parse(raw) });
				const reply = replies[Math.min(requests.length - 1, replies.length - 1)]!;
				// The SDK would retry a 429 or a 5xx with a pause; this header says not to.
				response.writeHead(reply.status ?? 200, { "content-type": "application/json", "x-should-retry": "false", ...reply.headers });
				response.end(JSON.stringify(reply.body));
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
		process.env.ANTHROPIC_API_KEY = "test-key";
	});
	after(() => {
		server.closeAllConnections();
		server.close();
	});
	beforeEach(() => {
		requests = [];
		replies = [{ body: message() }];
	});

	it("is safe to replay", () => {
		assert.equal((search as unknown as { replay?: string }).replay, "safe");
	});

	it("asks the configured model for a search and returns the answer with its sources", async () => {
		replies = [{ body: message({ text: "Ponytail palms reach 30 ft.", citations: [{ url: "https://a.example/x", title: "A" }], results: [{ url: "https://b.example/y", title: "B" }] }) }];
		const result = await execute({ query: "ponytail palm height" }, withModels(catalog), context);
		assert.equal(result.isError, undefined);
		assert.match(result.output[0]!.text, /^Ponytail palms reach 30 ft\.\n\nSources:\n1\. B\n {3}https:\/\/b\.example\/y\n2\. A\n {3}https:\/\/a\.example\/x$/);
		assert.equal(requests.length, 1);
		const { headers, body } = requests[0]!;
		// Newer SDKs send the key as a bearer token, older ones as x-api-key; either way it is the configured key.
		assert.ok(headers.authorization === "Bearer test-key" || headers["x-api-key"] === "test-key", JSON.stringify(Object.keys(headers)));
		assert.equal(body.model, "claude-opus-5-5");
		assert.equal(body.tools[0].type, "web_search_20260209");
		assert.equal(body.tools[0].max_uses, 5);
		assert.match(body.messages[0].content, /ponytail palm height/);
	});

	it("lists a source once, however many times it is cited", async () => {
		replies = [{ body: message({ citations: [{ url: "https://a.example/x", title: "A" }, { url: "https://a.example/x", title: "A again" }], results: [{ url: "https://a.example/x", title: "A" }] }) }];
		const text = (await execute({ query: "q" }, withModels(catalog), context)).output[0]!.text;
		assert.equal((text.match(/https:\/\/a\.example\/x/g) ?? []).length, 1);
	});

	it("says so when there are no sources", async () => {
		assert.match((await execute({ query: "q" }, withModels(catalog), context)).output[0]!.text, /Sources:\n\(none\)$/);
	});

	it("passes the allowed domains on, only when there are some", async () => {
		await execute({ query: "q", allowedDomains: ["docs.python.org"] }, withModels(catalog), context);
		assert.deepEqual(requests[0]!.body.tools[0].allowed_domains, ["docs.python.org"]);
		for (const allowedDomains of [undefined, []]) {
			requests = [];
			await execute({ query: "q", allowedDomains }, withModels(catalog), context);
			assert.equal("allowed_domains" in requests[0]!.body.tools[0], false);
		}
	});

	describe("the usage on the result", () => {
		it("prices the tokens at the model's rates and adds the search fee", async () => {
			replies = [{ body: message({ usage: { input_tokens: 10_000, output_tokens: 1_000, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 8_000, server_tool_use: { web_search_requests: 3 } } }) }];
			const { usage } = await execute({ query: "q" }, withModels(catalog), context);
			assert.deepEqual([usage!.input, usage!.output, usage!.cacheRead, usage!.cacheWrite], [10_000, 1_000, 20_000, 8_000]);
			// $5/M in, $25/M out, $0.50/M cache read, $6.25/M cache write, and $0.01 for each of 3 searches.
			close(usage!.cost.input, 0.05);
			close(usage!.cost.output, 0.025);
			close(usage!.cost.cacheRead, 0.01);
			close(usage!.cost.cacheWrite, 0.05);
			close(usage!.cost.total, 0.05 + 0.025 + 0.01 + 0.05 + 0.03);
		});

		it("charges the search fee even when the model's prices are unknown", async () => {
			replies = [{ body: message({ usage: { server_tool_use: { web_search_requests: 4 } } }) }];
			const unknown = { getModels: () => [] };
			const { usage } = await execute({ query: "q" }, withModels(unknown), context);
			close(usage!.cost.total, 0.04);
			assert.equal(usage!.input, 10_000);
		});

		it("works when the tool is given no model catalog at all", async () => {
			const { usage } = await execute({ query: "q" }, {}, context);
			close(usage!.cost.total, 0.01);
		});

		it("charges nothing for a search the server did not run", async () => {
			replies = [{ body: message({ usage: { server_tool_use: { web_search_requests: 0 } } }) }];
			close((await execute({ query: "q" }, withModels(catalog), context)).usage!.cost.total, 0.05 + 0.025);
			replies = [{ body: message({ usage: { server_tool_use: undefined } }) }];
			close((await execute({ query: "q" }, withModels(catalog), context)).usage!.cost.total, 0.05 + 0.025);
		});

		it("adds up the turns of a search that paused and was continued", async () => {
			replies = [
				{ body: message({ text: "First part. ", stop: "pause_turn", usage: { input_tokens: 1_000, output_tokens: 100, server_tool_use: { web_search_requests: 2 } } }) },
				{ body: message({ text: "Second part.", usage: { input_tokens: 2_000, output_tokens: 300, server_tool_use: { web_search_requests: 1 } } }) },
			];
			const result = await execute({ query: "q" }, withModels(catalog), context);
			assert.equal(requests.length, 2);
			assert.deepEqual(requests[1]!.body.messages.map((m: { role: string }) => m.role), ["user", "assistant"]);
			assert.match(result.output[0]!.text, /^First part\. Second part\./);
			assert.deepEqual([result.usage!.input, result.usage!.output], [3_000, 400]);
			close(result.usage!.cost.total, (5 / 1e6) * 3_000 + (25 / 1e6) * 400 + 3 * 0.01);
		});

		it("gives up on a search that never stops pausing, after three requests", async () => {
			replies = [{ body: message({ stop: "pause_turn" }) }];
			const result = await execute({ query: "q" }, withModels(catalog), context);
			assert.equal(requests.length, 3);
			assert.equal(result.usage!.input, 30_000, "all three turns were paid for");
		});
	});

	describe("when the API refuses", () => {
		const failing = async (status: number) => {
			replies = [{ status, body: { type: "error", error: { type: "api_error", message: "nope" } } }];
			return execute({ query: "q" }, withModels(catalog), context);
		};

		it("explains a bad key", async () => {
			const result = await failing(401);
			assert.equal(result.isError, true);
			assert.match(result.output[0]!.text, /ANTHROPIC_API_KEY is missing or invalid/);
			assert.equal("usage" in result, false);
		});

		it("explains rate limiting", async () => {
			const result = await failing(429);
			assert.equal(result.isError, true);
			assert.match(result.output[0]!.text, /rate limited/);
		});

		it("reports any other API failure with its status", async () => {
			const result = await failing(500);
			assert.equal(result.isError, true);
			assert.match(result.output[0]!.text, /^Web search failed: 500/);
			assert.equal("usage" in result, false);
		});
	});
});
