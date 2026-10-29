// Where a session's tokens went, from its transcript: per loop iteration, the context each one started and ended
// with, what it cost by type, how much of that was re-reading the old history, and which tools filled the context.
// Pure: the caller fetches the entries (for example from the daemon's event stream); `pd cost` can print the result.

export type UsageLike = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
};

type Block = { type?: string; name?: string; id?: string; text?: string };
type Message = { content?: unknown; usage?: UsageLike; model?: string; toolCallId?: string };
/** A transcript entry as the daemon streams it: a kind, the model messages, and for loop ticks some data. */
export type TranscriptEntry = { kind: string; model?: Message[]; data?: Record<string, unknown> };

export type Money = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };

export type Segment = {
	/** The loop and iteration, when the segment starts at a loop tick. */
	loopId?: string;
	iteration?: number;
	turns: number;
	toolCalls: number;
	/** Context tokens (fresh input + cache read + cache write) at the first and last turn. */
	startContext: number;
	endContext: number;
	tokens: Tokens;
	cost: Money;
	/** What the first two turns spent on input and cache writes: the price of re-reading the history. */
	reingestCost: number;
	models: Record<string, number>;
	tools: Record<string, { calls: number; resultChars: number }>;
};

export type CostReport = {
	segments: Segment[];
	totals: { turns: number; tokens: Tokens; cost: Money };
	/** Context of the very first turn: the system prompt, every tool, and the first message. */
	prefixTokens?: number;
	/** Average growth of the starting context from one loop iteration to the next. */
	startGrowth?: number;
	findings: string[];
};

const zeroMoney = (): Money => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
const zeroTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export const contextTokens = (usage: UsageLike | undefined) => num(usage?.input) + num(usage?.cacheRead) + num(usage?.cacheWrite);

function textLength(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	return content.reduce((sum: number, part: Block) => sum + (part?.type === "text" && typeof part.text === "string" ? part.text.length : 0), 0);
}

function addTo(target: Money, cost: UsageLike["cost"]): void {
	target.input += num(cost?.input);
	target.output += num(cost?.output);
	target.cacheRead += num(cost?.cacheRead);
	target.cacheWrite += num(cost?.cacheWrite);
	target.total += num(cost?.total);
}

/** Split at each loop tick; entries before the first tick form one segment of their own when the agent spoke in them. */
export function analyzeTranscript(entries: readonly TranscriptEntry[]): CostReport {
	const segments: Segment[] = [];
	const toolNames = new Map<string, string>();
	let current: Segment | undefined;
	let firstTwo: number[] = [];
	let prefixTokens: number | undefined;

	const open = (loopId?: string, iteration?: number): Segment => {
		current = { ...(loopId === undefined ? {} : { loopId }), ...(iteration === undefined ? {} : { iteration }), turns: 0, toolCalls: 0, startContext: 0, endContext: 0, tokens: zeroTokens(), cost: zeroMoney(), reingestCost: 0, models: {}, tools: {} };
		firstTwo = [];
		segments.push(current);
		return current;
	};

	for (const entry of entries) {
		if (entry.kind === "pdl.loop-tick") {
			open(typeof entry.data?.loopId === "string" ? entry.data.loopId : undefined, typeof entry.data?.iteration === "number" ? entry.data.iteration : undefined);
			continue;
		}
		const message = entry.model?.[0];
		if (entry.kind === "pi.assistant" && message !== undefined) {
			const segment = current ?? open();
			const usage = message.usage;
			const context = contextTokens(usage);
			if (prefixTokens === undefined) prefixTokens = context;
			if (segment.turns === 0) segment.startContext = context;
			segment.endContext = context;
			segment.turns++;
			segment.tokens.input += num(usage?.input);
			segment.tokens.output += num(usage?.output);
			segment.tokens.cacheRead += num(usage?.cacheRead);
			segment.tokens.cacheWrite += num(usage?.cacheWrite);
			addTo(segment.cost, usage?.cost);
			if (firstTwo.length < 2) {
				firstTwo.push(num(usage?.cost?.input) + num(usage?.cost?.cacheWrite));
				segment.reingestCost = firstTwo.reduce((a, b) => a + b, 0);
			}
			if (message.model !== undefined) segment.models[message.model] = (segment.models[message.model] ?? 0) + 1;
			for (const block of Array.isArray(message.content) ? (message.content as Block[]) : []) {
				if (block?.type !== "toolCall" || typeof block.name !== "string") continue;
				segment.toolCalls++;
				if (typeof block.id === "string") toolNames.set(block.id, block.name);
				const tool = (segment.tools[block.name] ??= { calls: 0, resultChars: 0 });
				tool.calls++;
			}
		} else if (entry.kind === "pi.tool-result" && message !== undefined && current !== undefined) {
			const name = toolNames.get(message.toolCallId ?? "") ?? "(unknown)";
			const tool = (current.tools[name] ??= { calls: 0, resultChars: 0 });
			tool.resultChars += textLength(message.content);
		}
	}

	const used = segments.filter((segment) => segment.turns > 0);
	const totals = { turns: 0, tokens: zeroTokens(), cost: zeroMoney() };
	for (const segment of used) {
		totals.turns += segment.turns;
		for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) totals.tokens[key] += segment.tokens[key];
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) totals.cost[key] += segment.cost[key];
	}
	const loopSegments = used.filter((segment) => segment.iteration !== undefined);
	const startGrowth =
		loopSegments.length >= 2 ? (loopSegments.at(-1)!.startContext - loopSegments[0]!.startContext) / (loopSegments.length - 1) : undefined;
	const report: CostReport = { segments: used, totals, ...(prefixTokens === undefined ? {} : { prefixTokens }), ...(startGrowth === undefined ? {} : { startGrowth }), findings: [] };
	report.findings = findings(report);
	return report;
}

const usd = (value: number) => `$${value.toFixed(value >= 1 ? 2 : 3)}`;
const count = (value: number) => Math.round(value).toLocaleString("en-US");

/** What the numbers say, in plain sentences; empty when there is nothing worth saying. */
export function findings(report: Pick<CostReport, "segments" | "prefixTokens" | "startGrowth" | "totals">): string[] {
	const out: string[] = [];
	const loops = report.segments.filter((segment) => segment.iteration !== undefined);
	const last = loops.at(-1);
	if (last !== undefined && report.prefixTokens !== undefined && last.startContext > Math.max(20_000, report.prefixTokens * 4)) {
		out.push(
			`The latest iteration started with ${count(last.startContext)} tokens of history (the bare prefix is ${count(report.prefixTokens)}) and spent ${usd(last.reingestCost)} of its ${usd(last.cost.total)} re-reading it in its first two turns. A fresh context per iteration would start near the prefix.`,
		);
	}
	if (report.startGrowth !== undefined && report.startGrowth > 2_000 && last !== undefined && last.startContext > 0) {
		const perToken = last.reingestCost / last.startContext;
		out.push(`The starting context grows by about ${count(report.startGrowth)} tokens per iteration, so the next iteration's re-read will cost about ${usd(perToken * (last.startContext + report.startGrowth))}.`);
	}
	const cacheWrite = report.totals.cost.cacheWrite;
	if (report.totals.cost.total > 0 && cacheWrite / report.totals.cost.total > 0.3) {
		out.push(`Cache writes are ${Math.round((100 * cacheWrite) / report.totals.cost.total)}% of the cost (${usd(cacheWrite)}): the conversation keeps being re-cached as it grows.`);
	}
	const chars = new Map<string, number>();
	for (const segment of report.segments) for (const [name, tool] of Object.entries(segment.tools)) chars.set(name, (chars.get(name) ?? 0) + tool.resultChars);
	const [heaviest, heaviestChars] = [...chars.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
	if (heaviest !== undefined && heaviestChars !== undefined && heaviestChars > 40_000) {
		out.push(`${heaviest} results total ${count(heaviestChars)} characters (about ${count(heaviestChars / 4)} tokens), and every later turn re-reads them.`);
	}
	return out;
}

/** A plain-text table: one row per iteration, then totals, the heaviest tools, and the findings. */
export function formatCostReport(report: CostReport): string {
	const lines: string[] = [];
	if (report.segments.length === 0) return "No assistant turns in this transcript.";
	if (report.prefixTokens !== undefined) lines.push(`Fixed prefix (system prompt, tools, first message): ${count(report.prefixTokens)} tokens`);
	lines.push("", "iteration   turns  tools   start ctx     end ctx   re-read       cost");
	for (const segment of report.segments) {
		const label = segment.iteration === undefined ? "(no loop)" : `${segment.loopId ?? "?"}#${segment.iteration + 1}`;
		lines.push(`${label.padEnd(10)} ${String(segment.turns).padStart(6)} ${String(segment.toolCalls).padStart(6)} ${count(segment.startContext).padStart(11)} ${count(segment.endContext).padStart(11)} ${usd(segment.reingestCost).padStart(9)} ${usd(segment.cost.total).padStart(10)}`);
	}
	const { tokens, cost } = report.totals;
	lines.push(
		"",
		`Total ${usd(cost.total)} over ${report.totals.turns} turns: input ${usd(cost.input)}, output ${usd(cost.output)}, cache read ${usd(cost.cacheRead)}, cache write ${usd(cost.cacheWrite)}`,
		`Tokens: ${count(tokens.input)} fresh input, ${count(tokens.output)} output, ${count(tokens.cacheRead)} cache read, ${count(tokens.cacheWrite)} cache write`,
	);
	const tools = new Map<string, { calls: number; resultChars: number }>();
	for (const segment of report.segments) {
		for (const [name, tool] of Object.entries(segment.tools)) {
			const sum = tools.get(name) ?? { calls: 0, resultChars: 0 };
			sum.calls += tool.calls;
			sum.resultChars += tool.resultChars;
			tools.set(name, sum);
		}
	}
	const heaviest = [...tools.entries()].filter(([, tool]) => tool.resultChars > 0).sort((a, b) => b[1].resultChars - a[1].resultChars).slice(0, 5);
	if (heaviest.length > 0) {
		lines.push("", "Heaviest tool results (they ride along in every later turn):");
		for (const [name, tool] of heaviest) lines.push(`  ${name.padEnd(14)} ${count(tool.resultChars).padStart(9)} chars over ${tool.calls} calls`);
	}
	if (report.findings.length > 0) lines.push("", "What this says:", ...report.findings.map((finding) => `  - ${finding}`));
	return lines.join("\n");
}
