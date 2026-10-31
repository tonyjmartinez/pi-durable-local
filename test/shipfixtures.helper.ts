// Fixtures for tests that drive tickPr and the pr tools against the fake gh: a PR, its checks, threads and diff, a
// scripted GitHub, and a fake model that reports token usage. Import-safe.
import type { Rule } from "./fakegh.helper.ts";

export const SHA = "a".repeat(40);
export const OTHER_SHA = "b".repeat(40);

export const BODY = `## Intent

Fix the parser.

Door: two-way

Cleanup: none

## Why

It dropped the last token.

## Testing

Ran npm test: 10 passing.

## System recap

Risk: low
Touches: parser (composes)
`;

export const DIFF = "diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n+export const x = 1;\n";

export const pr = (change: Record<string, unknown> = {}) => ({
	number: 7, title: "Fix the parser", body: BODY, state: "OPEN", isDraft: false, isCrossRepository: false,
	author: { login: "factorybot" }, baseRefName: "main", headRefName: "pd/x", headRefOid: SHA, additions: 10, deletions: 2,
	changedFiles: 1, mergeable: "MERGEABLE", reviewDecision: "", url: "https://github.com/o/r/pull/7", mergeStateStatus: "CLEAN", ...change,
});

export const run = (name = "ci", conclusion: string | null = "success", app = "github-actions", status = "completed") =>
	JSON.stringify({ name, status, conclusion, app: { slug: app } });
export const pending = (name = "e2e") => run(name, null, "github-actions", "in_progress");
export const threads = (nodes: unknown[], hasNextPage = false) =>
	JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage }, nodes } } } } });

export type Scenario = {
	pr?: Record<string, unknown>;
	files?: string[];
	/** One entry per call of the check-runs rule: a list of check-run JSON lines. The last entry repeats. */
	runs?: string[][];
	statuses?: unknown[];
	diff?: string;
	graphql?: Rule["responses"];
	/** Answers of the full `pr view` read, one per gather; the last repeats. Default: the PR, every time. */
	prViews?: Rule["responses"];
};

type Gh = { script(rules: Rule[]): void };

/** Script the GitHub reads a tick makes for PR 7 of o/r. */
export function shipScript(gh: Gh, scenario: Scenario = {}): void {
	const view = pr(scenario.pr);
	const runs = scenario.runs ?? [[run()]];
	gh.script([
		{ match: "^pr view 7 --repo o/r --json headRefOid,title,body$", responses: [JSON.stringify({ headRefOid: view.headRefOid, title: view.title, body: view.body })] },
		{ match: "^pr view 7 --repo o/r --json number,", responses: scenario.prViews ?? [JSON.stringify(view)] },
		{ match: "^repo view o/r --json defaultBranchRef", responses: ["main\n"] },
		{ match: "^api --paginate repos/o/r/pulls/7/files", responses: [`${JSON.stringify((scenario.files ?? ["src/a.ts"]).map((filename) => ({ filename, previous_filename: null })))}\n`] },
		{ match: "^api user --jq \\.login$", responses: ["factorybot\n"] },
		{ match: "^api graphql", responses: scenario.graphql ?? [threads([])] },
		{ match: "check-runs\\?per_page=100", responses: runs.map((lines) => `${lines.join("\n")}\n`) },
		{ match: "/status\\?per_page=100$", responses: [JSON.stringify({ statuses: scenario.statuses ?? [] })] },
		{ match: "^api repos/o/r/compare/main\\.\\.\\.[0-9a-f]+ -H", responses: [scenario.diff ?? DIFF] },
		{ match: "^pr merge 7 ", responses: [""] },
		{ match: "^pr comment", responses: [""] },
	]);
}

export type FakeUsage = {
	input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};

/** A usage record with round numbers, so sums are easy to check by eye. */
export const usageOf = (input: number, output: number, cost: number): FakeUsage => ({
	input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
	cost: { input: cost * 0.8, output: cost * 0.2, cacheRead: 0, cacheWrite: 0, total: cost },
});

export const APPROVE = '{"approve": true, "reasons": ["small and tested"]}';
export const REJECT = '{"approve": false, "reasons": ["no test for the edge case"]}';

/** A fake model catalog and completion API. Each call reports `usage` (default: 1,000 in, 200 out, $0.05); null reports none. */
export function fakeModels(replies: string[], usage: FakeUsage | null = usageOf(1_000, 200, 0.05)) {
	const calls: { system: string; user: string }[] = [];
	return {
		calls,
		getModels: () => ["claude-opus-5-5", "claude-haiku-5-5"].map((id) => ({ provider: "anthropic", id, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } })),
		completeSimple: async (_model: unknown, request: { systemPrompt: string; messages: { content: string }[] }) => {
			calls.push({ system: request.systemPrompt, user: request.messages[0]!.content });
			const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!;
			return { content: [{ type: "text", text: reply }], ...(usage === null ? {} : { usage }) };
		},
	};
}
