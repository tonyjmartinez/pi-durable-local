import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeTranscript, contextTokens, findings, formatCostReport } from "../src/costreport.ts";
import type { TranscriptEntry, UsageLike } from "../src/costreport.ts";

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

/** An assistant turn with the given usage; `calls` are [id, tool name] pairs. */
const usage = (input: number, cacheRead: number, cacheWrite: number, output: number, cost: [number, number, number, number]): UsageLike => ({
	input, output, cacheRead, cacheWrite,
	cost: { input: cost[0], cacheRead: cost[1], cacheWrite: cost[2], output: cost[3], total: cost[0] + cost[1] + cost[2] + cost[3] },
});
const assistant = (u: UsageLike | undefined, calls: [string, string][] = [], model = "claude-sonnet-5-5"): TranscriptEntry => ({
	kind: "pi.assistant",
	model: [{ model, ...(u ? { usage: u } : {}), content: [{ type: "text", text: "ok" }, ...calls.map(([id, name]) => ({ type: "toolCall", id, name })) ] }],
});
const result = (id: string, text: string): TranscriptEntry => ({ kind: "pi.tool-result", model: [{ toolCallId: id, content: [{ type: "text", text }] }] });
const tick = (loopId: string, iteration: number): TranscriptEntry => ({ kind: "pdl.loop-tick", data: { loopId, iteration } });

describe("contextTokens", () => {
	it("is fresh input plus cache read plus cache write", () => {
		assert.equal(contextTokens(usage(10, 200, 30, 5, [0, 0, 0, 0])), 240);
	});
	it("copes with missing and odd values", () => {
		assert.equal(contextTokens(undefined), 0);
		assert.equal(contextTokens({}), 0);
		assert.equal(contextTokens({ input: Number.NaN, cacheRead: 5, cacheWrite: "x" as never }), 5);
	});
});

describe("analyzeTranscript", () => {
	it("is empty for an empty transcript, or one with no assistant turns", () => {
		for (const entries of [[], [{ kind: "pi.user", model: [{ content: "hi" }] }, tick("L1", 0), { kind: "pi.system" }] as TranscriptEntry[]]) {
			const report = analyzeTranscript(entries);
			assert.deepEqual(report.segments, []);
			assert.equal(report.totals.turns, 0);
			assert.equal(report.totals.cost.total, 0);
			assert.equal(report.prefixTokens, undefined);
			assert.deepEqual(report.findings, []);
		}
	});

	it("reads one conversation with no loop as one segment", () => {
		const report = analyzeTranscript([
			assistant(usage(5, 0, 1_000, 100, [0.01, 0, 0.0025, 0.001]), [["a", "bash"]]),
			result("a", "x".repeat(300)),
			assistant(usage(5, 1_000, 200, 50, [0.01, 0.0001, 0.0005, 0.0005])),
		]);
		assert.equal(report.segments.length, 1);
		const [segment] = report.segments;
		assert.equal(segment!.loopId, undefined);
		assert.equal(segment!.iteration, undefined);
		assert.equal(segment!.turns, 2);
		assert.equal(segment!.toolCalls, 1);
		assert.equal(segment!.startContext, 1_005);
		assert.equal(segment!.endContext, 1_205);
		assert.deepEqual(segment!.tokens, { input: 10, output: 150, cacheRead: 1_000, cacheWrite: 1_200 });
		assert.equal(report.prefixTokens, 1_005);
		assert.equal(report.startGrowth, undefined);
	});

	it("adds up cost by type and in total, across segments", () => {
		const report = analyzeTranscript([
			tick("L1", 0), assistant(usage(10, 0, 0, 10, [0.1, 0, 0, 0.05])),
			tick("L1", 1), assistant(usage(10, 0, 0, 10, [0.2, 0.01, 0.3, 0.05])),
		]);
		close(report.totals.cost.input, 0.3);
		close(report.totals.cost.cacheRead, 0.01);
		close(report.totals.cost.cacheWrite, 0.3);
		close(report.totals.cost.output, 0.1);
		close(report.totals.cost.total, 0.71);
		assert.equal(report.totals.turns, 2);
		assert.equal(report.totals.tokens.input, 20);
	});

	it("splits at each loop tick and labels the segments", () => {
		const report = analyzeTranscript([
			assistant(usage(1, 0, 100, 1, [0, 0, 0, 0])),
			tick("L2", 0), assistant(usage(1, 0, 200, 1, [0, 0, 0, 0])), assistant(usage(1, 200, 20, 1, [0, 0, 0, 0])),
			tick("L2", 1), assistant(usage(1, 0, 300, 1, [0, 0, 0, 0])),
		]);
		assert.deepEqual(report.segments.map((s) => [s.loopId, s.iteration, s.turns]), [[undefined, undefined, 1], ["L2", 0, 2], ["L2", 1, 1]]);
		assert.deepEqual(report.segments.map((s) => s.startContext), [101, 201, 301]);
		assert.equal(report.segments[1]!.endContext, 221);
	});

	it("leaves out a tick that no assistant turn followed", () => {
		const report = analyzeTranscript([tick("L1", 0), tick("L1", 1), assistant(usage(1, 0, 10, 1, [0, 0, 0, 0]))]);
		assert.deepEqual(report.segments.map((s) => s.iteration), [1]);
	});

	it("prices the re-read as the first two turns' input and cache-write cost", () => {
		const report = analyzeTranscript([
			tick("L1", 0),
			assistant(usage(85_000, 0, 3_000, 50, [0.17, 0, 0.0075, 0.001])),
			assistant(usage(2, 3_000, 86_000, 300, [0.00001, 0.0003, 0.215, 0.003])),
			assistant(usage(2, 89_000, 2_000, 400, [0.00001, 0.0089, 0.005, 0.004])),
		]);
		close(report.segments[0]!.reingestCost, 0.17 + 0.0075 + 0.00001 + 0.215);
	});

	it("counts a one-turn segment's re-read from that one turn", () => {
		const report = analyzeTranscript([tick("L1", 0), assistant(usage(100, 0, 100, 1, [0.4, 0, 0.1, 0]))]);
		close(report.segments[0]!.reingestCost, 0.5);
	});

	it("counts turns per model", () => {
		const report = analyzeTranscript([
			assistant(usage(1, 0, 1, 1, [0, 0, 0, 0]), [], "claude-opus-5-5"),
			assistant(usage(1, 0, 1, 1, [0, 0, 0, 0]), [], "claude-sonnet-5-5"),
			assistant(usage(1, 0, 1, 1, [0, 0, 0, 0]), [], "claude-sonnet-5-5"),
		]);
		assert.deepEqual(report.segments[0]!.models, { "claude-opus-5-5": 1, "claude-sonnet-5-5": 2 });
	});

	it("treats a turn with no usage as zero rather than failing", () => {
		const report = analyzeTranscript([assistant(undefined), assistant(usage(1, 0, 5, 1, [0, 0, 0, 0]))]);
		assert.equal(report.segments[0]!.turns, 2);
		assert.equal(report.segments[0]!.startContext, 0);
		assert.equal(report.segments[0]!.endContext, 6);
	});

	it("attributes tool results to the tool that was called, by call id", () => {
		const report = analyzeTranscript([
			assistant(usage(1, 0, 1, 1, [0, 0, 0, 0]), [["c1", "bash"], ["c2", "web_fetch"]]),
			result("c1", "a".repeat(100)),
			result("c2", "b".repeat(2_000)),
			assistant(usage(1, 1, 1, 1, [0, 0, 0, 0]), [["c3", "bash"]]),
			result("c3", "c".repeat(50)),
			result("unknown", "z".repeat(7)),
		]);
		const { tools } = report.segments[0]!;
		assert.deepEqual(tools.bash, { calls: 2, resultChars: 150 });
		assert.deepEqual(tools.web_fetch, { calls: 1, resultChars: 2_000 });
		assert.deepEqual(tools["(unknown)"], { calls: 0, resultChars: 7 });
		assert.equal(report.segments[0]!.toolCalls, 3);
	});

	it("counts only the text of a tool result, and accepts plain strings", () => {
		const report = analyzeTranscript([
			assistant(usage(1, 0, 1, 1, [0, 0, 0, 0]), [["c1", "read"], ["c2", "bash"]]),
			{ kind: "pi.tool-result", model: [{ toolCallId: "c1", content: [{ type: "image" }, { type: "text", text: "abc" }] }] },
			{ kind: "pi.tool-result", model: [{ toolCallId: "c2", content: "plain text" }] },
		]);
		assert.equal(report.segments[0]!.tools.read!.resultChars, 3);
		assert.equal(report.segments[0]!.tools.bash!.resultChars, 10);
	});

	it("measures how fast the starting context grows across iterations", () => {
		const turn = (ctx: number) => assistant(usage(ctx, 0, 0, 1, [0, 0, 0, 0]));
		const report = analyzeTranscript([tick("L1", 0), turn(10_000), tick("L1", 1), turn(30_000), tick("L1", 2), turn(70_000)]);
		assert.equal(report.startGrowth, 30_000);
		assert.equal(analyzeTranscript([tick("L1", 0), turn(10_000)]).startGrowth, undefined, "needs two iterations");
	});

	it("does not change the entries it was given", () => {
		const entries = [tick("L1", 0), assistant(usage(1, 2, 3, 4, [0.1, 0.1, 0.1, 0.1]), [["a", "bash"]]), result("a", "x")];
		const snapshot = JSON.stringify(entries);
		analyzeTranscript(entries);
		assert.equal(JSON.stringify(entries), snapshot);
	});

	it("survives malformed entries", () => {
		const odd = [{ kind: "pi.assistant" }, { kind: "pi.assistant", model: [{}] }, { kind: "pi.assistant", model: [{ content: "text", usage: {} }] }, { kind: "pi.tool-result" }, { kind: "pdl.loop-tick" }] as TranscriptEntry[];
		assert.doesNotThrow(() => formatCostReport(analyzeTranscript(odd)));
	});
});

describe("findings", () => {
	const turn = (ctx: number, cost: [number, number, number, number] = [0, 0, 0, 0.01]) => assistant(usage(ctx, 0, 0, 1, cost));

	it("flags a history that dwarfs the prefix, with what it cost to re-read", () => {
		const report = analyzeTranscript([assistant(usage(3_000, 0, 0, 1, [0, 0, 0, 0])), tick("L1", 0), turn(48_000, [0.2, 0, 0, 0.01]), turn(48_100)]);
		assert.match(report.findings[0] ?? "", /started with 48,000 tokens of history \(the bare prefix is 3,000\)/);
		assert.match(report.findings[0]!, /A fresh context per iteration would start near the prefix/);
	});

	it("projects the next iteration's re-read from the growth so far", () => {
		const report = analyzeTranscript([tick("L1", 0), turn(30_000, [0.1, 0, 0, 0]), tick("L1", 1), turn(50_000, [0.2, 0, 0, 0]), tick("L1", 2), turn(70_000, [0.3, 0, 0, 0])]);
		const growth = report.findings.find((line) => line.includes("grows by about"))!;
		assert.match(growth, /about 20,000 tokens per iteration/);
		// $0.3 for 70,000 tokens, scaled to 90,000 tokens.
		assert.match(growth, /about \$0\.386/);
	});

	it("flags cache writes that dominate the cost", () => {
		const report = analyzeTranscript([assistant(usage(1, 0, 1, 1, [0.1, 0, 0.9, 0]))]);
		assert.match(report.findings.join("\n"), /Cache writes are 90% of the cost \(\$0\.900\)/);
	});

	it("flags a tool whose results fill the context", () => {
		const report = analyzeTranscript([assistant(usage(1, 0, 1, 1, [0, 0, 0, 0]), [["c", "web_fetch"]]), result("c", "x".repeat(60_000))]);
		assert.match(report.findings.join("\n"), /web_fetch results total 60,000 characters \(about 15,000 tokens\)/);
	});

	it("has nothing to say about a small, cheap conversation", () => {
		const report = analyzeTranscript([tick("L1", 0), turn(4_000), turn(4_100), tick("L1", 1), turn(4_200), turn(4_300)]);
		assert.deepEqual(report.findings, []);
	});

	it("can be run on a report-shaped object directly", () => {
		assert.deepEqual(findings({ segments: [], totals: { turns: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }), []);
	});
});

describe("formatCostReport", () => {
	const report = () => analyzeTranscript([
		assistant(usage(2_000, 0, 1_615, 100, [0.004, 0, 0.004, 0.001]), [["a", "bash"]]), result("a", "x".repeat(1_000)),
		tick("L2", 0), assistant(usage(40_000, 0, 3_000, 100, [0.08, 0, 0.0075, 0.001])), assistant(usage(2, 3_000, 41_000, 200, [0, 0.0003, 0.1, 0.002])),
		tick("L2", 1), assistant(usage(60_000, 0, 3_000, 100, [0.12, 0, 0.0075, 0.001])), assistant(usage(2, 3_000, 61_000, 200, [0, 0.0003, 0.15, 0.002])),
	]);

	it("says so for an empty transcript", () => {
		assert.equal(formatCostReport(analyzeTranscript([])), "No assistant turns in this transcript.");
	});

	it("prints the prefix, one row per iteration, the totals and the heaviest tools", () => {
		const text = formatCostReport(report());
		assert.match(text, /^Fixed prefix \(system prompt, tools, first message\): 3,615 tokens/);
		assert.match(text, /iteration +turns +tools +start ctx +end ctx +re-read +cost/);
		assert.match(text, /\(no loop\) +1 +1 +3,615 +3,615/);
		assert.match(text, /L2#1 +2 +0 +43,000 +44,002/);
		assert.match(text, /L2#2 +2 +0 +63,000 +64,002/);
		assert.match(text, /Total \$\d\.\d{2,3} over 5 turns: input \$/);
		assert.match(text, /Tokens: [\d,]+ fresh input, [\d,]+ output, [\d,]+ cache read, [\d,]+ cache write/);
		assert.match(text, /Heaviest tool results[^\n]*\n {2}bash +1,000 chars over 1 calls/);
	});

	it("ends with what the numbers say, when there is something to say", () => {
		const text = formatCostReport(report());
		assert.match(text, /What this says:\n {2}- The latest iteration started with 63,000 tokens/);
	});

	it("is stable: the same transcript prints the same text", () => {
		assert.equal(formatCostReport(report()), formatCostReport(report()));
	});

	it("leaves out the tool section when no tool produced output", () => {
		const text = formatCostReport(analyzeTranscript([assistant(usage(1, 0, 1, 1, [0.1, 0, 0, 0]))]));
		assert.doesNotMatch(text, /Heaviest tool results/);
	});
});
