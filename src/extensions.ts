// Every extension the daemon installs: coding context, shared memory, cross-session messaging, web access,
// the gated PR merge, project loops, and the safety guard.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import type { Context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTask,
	defineTool,
	type Harness,
	hook,
	section,
	ToolTask,
	UsageDoc,
} from "@earendil-works/pi-durable";
import { loadPolicy, type Policy, splitModel } from "./config.ts";
import { checkToolCall, protectedMatches } from "./guard.ts";
import { audit, type Loop, Loops, type Memory, Memories, sessionNameOf, Sessions } from "./state.ts";

const run = promisify(execFile);

/** Set by the daemon once the Harness is open; loop tasks and messaging need it outside a tool's api. */
let harnessRef: Harness | undefined;
export function setHarness(harness: Harness): void {
	harnessRef = harness;
}
function harness(): Harness {
	if (harnessRef === undefined) throw new Error("Harness not open");
	return harnessRef;
}

const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });
const fail = (value: string) => ({ ...text(value), isError: true });

// ---------------------------------------------------------------------------------------------------------------
// Coding context: who this session is, the project's own instructions, and the working rules.

const WORKFLOW = `You are one of several long-running pi-durable agent sessions on Tony's machine. You persist across restarts.

Working rules:
- Work in your session's directory. Read the project's AGENTS.md/README before changing code.
- Never commit to main. Create a branch named with the work-branch prefix, commit small coherent steps, run the project's tests/linters, then push with an explicit branch name (\`git push -u origin <branch>\`).
- Open PRs with \`gh pr create\`. A PR is merged only through the \`pr_merge\` tool, which enforces CI, size, protected-path, and review gates. If it refuses, fix the cause or leave the PR for Tony; never try to work around a gate.
- Record durable facts (decisions, conventions, gotchas, preferences Tony states) with \`memory_save\`; check \`memory_search\` before re-deriving something.
- Coordinate with other sessions via \`sessions_list\` / \`session_send\` instead of editing the same repo at once.
- If blocked on a decision that is Tony's to make, say so plainly and stop rather than guessing.`;

function projectInstructions(cwd: string): string | undefined {
	for (const name of ["AGENTS.md", "CLAUDE.md"]) {
		const path = join(cwd, name);
		if (existsSync(path)) {
			const body = readFileSync(path, "utf8");
			return `From ${path}:\n${body.length > 12_000 ? `${body.slice(0, 12_000)}\n…(truncated)` : body}`;
		}
	}
	return undefined;
}

export const SessionContext = defineExtension({
	name: "pdl.context",
	sections: [
		section("preamble", () => WORKFLOW, { tag: false }),
		section("session", async (input, context) => {
			const sessions = await input.read.snapshot(Sessions, context);
			const name = sessions === undefined ? undefined : sessionNameOf(sessions.byName, input.conversationId);
			if (sessions === undefined || name === undefined) return undefined;
			const me = sessions.byName[name]!;
			const peers = Object.entries(sessions.byName)
				.filter(([other]) => other !== name)
				.map(([other, info]) => `- ${other} (${info.cwd})${info.purpose ? `: ${info.purpose}` : ""}`);
			const policy = loadPolicy();
			return [
				`Session: ${name}`,
				me.purpose ? `Purpose: ${me.purpose}` : undefined,
				`Directory: ${me.cwd}`,
				`Work-branch prefix: ${policy.automerge.branchPrefix}`,
				peers.length > 0 ? `Other sessions:\n${peers.join("\n")}` : undefined,
			]
				.filter((line) => line !== undefined)
				.join("\n");
		}),
		section("project", (input) => (input.env?.cwd === undefined ? undefined : projectInstructions(input.env.cwd))),
	],
});

// ---------------------------------------------------------------------------------------------------------------
// Shared memory: one durable document every session reads in its system prompt and writes through tools.

function memoryAppliesTo(memory: Memory, cwd: string | undefined): boolean {
	if (memory.project === undefined) return true;
	if (cwd === undefined) return false;
	const rel = relative(memory.project, cwd);
	return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

function formatMemory(memory: Memory): string {
	const where = memory.project === undefined ? "global" : memory.project;
	const tags = memory.tags.length > 0 ? ` [${memory.tags.join(", ")}]` : "";
	return `#${memory.id} (${where}) ${memory.topic}${tags}: ${memory.text}`;
}

const MEMORY_PROMPT_BUDGET = 8_000;

async function sessionCwd(api: { snapshot: Harness["snapshot"] }, conversationId: number, context: Context) {
	const sessions = await api.snapshot(Sessions, context);
	const name = sessions === undefined ? undefined : sessionNameOf(sessions.byName, conversationId);
	return { name, cwd: name === undefined ? undefined : sessions!.byName[name]!.cwd };
}

export const Memory_ = defineExtension({
	name: "pdl.memory",
	sections: [
		section("memory", async (input, context) => {
			const memories = await input.read.snapshot(Memories, context);
			if (memories === undefined) return undefined;
			const relevant = Object.values(memories.items)
				.filter((memory) => memoryAppliesTo(memory, input.env?.cwd))
				.sort((a, b) => b.updatedAt - a.updatedAt);
			if (relevant.length === 0) return undefined;
			const lines: string[] = [];
			let used = 0;
			for (const memory of relevant) {
				const line = formatMemory(memory);
				if (used + line.length > MEMORY_PROMPT_BUDGET) {
					lines.push(`…${relevant.length - lines.length} older memories not shown; use memory_search.`);
					break;
				}
				lines.push(line);
				used += line.length;
			}
			return `Shared memory (all sessions read and write this; newest first):\n${lines.join("\n")}`;
		}),
	],
	tools: [
		defineTool({
			name: "memory_save",
			description:
				"Save or update a durable fact shared with every session: decisions, conventions, gotchas, user preferences, project status. Keep each memory one self-contained fact. Pass `id` to update an existing memory instead of adding a near-duplicate.",
			parameters: Type.Object({
				topic: Type.String({ description: "Short title, e.g. 'test command' or 'deploy process'" }),
				text: Type.String({ description: "The fact, written so it makes sense with no other context" }),
				scope: Type.Union([Type.Literal("project"), Type.Literal("global")], {
					description: "project: about this session's directory; global: holds everywhere (user preferences, machine setup)",
				}),
				tags: Type.Optional(Type.Array(Type.String())),
				id: Type.Optional(Type.String({ description: "Existing memory id to replace" })),
			}),
			execute: async (args, api, context) => {
				const { name, cwd } = await sessionCwd(api, api.conversationId, context);
				const saved = await api.commit(async (tx) => {
					const memories = await tx.doc(Memories);
					const id = args.id ?? String(memories.nextId++);
					if (args.id !== undefined && memories.items[id] === undefined) return undefined;
					const memory: Memory = {
						id,
						topic: args.topic,
						text: args.text,
						tags: args.tags ?? [],
						by: name ?? "unknown",
						updatedAt: Date.now(),
					};
					if (args.scope === "project" && cwd !== undefined) memory.project = cwd;
					memories.items[id] = memory;
					return memory;
				}, context);
				return saved === undefined ? fail(`No memory #${args.id}`) : text(`Saved ${formatMemory(saved)}`);
			},
		}),
		defineTool({
			name: "memory_search",
			description: "Search shared memory across all projects by words in topic, text, tags, or project path.",
			parameters: Type.Object({
				query: Type.String(),
				limit: Type.Optional(Type.Number({ default: 20 })),
			}),
			execute: async (args, api, context) => {
				const memories = await api.snapshot(Memories, context);
				const words = args.query.toLowerCase().split(/\s+/).filter(Boolean);
				const scored = Object.values(memories?.items ?? {})
					.map((memory) => {
						const haystack = `${memory.topic} ${memory.text} ${memory.tags.join(" ")} ${memory.project ?? ""}`.toLowerCase();
						return { memory, score: words.filter((word) => haystack.includes(word)).length };
					})
					.filter((hit) => hit.score > 0)
					.sort((a, b) => b.score - a.score || b.memory.updatedAt - a.memory.updatedAt)
					.slice(0, args.limit ?? 20);
				return text(scored.length === 0 ? "No matching memories." : scored.map((hit) => formatMemory(hit.memory)).join("\n"));
			},
		}),
		defineTool({
			name: "memory_forget",
			description: "Delete a memory that is wrong or obsolete.",
			parameters: Type.Object({ id: Type.String() }),
			execute: async (args, api, context) => {
				const removed = await api.commit(async (tx) => {
					const memories = await tx.doc(Memories);
					const memory = memories.items[args.id] === undefined ? undefined : { ...memories.items[args.id]! };
					delete memories.items[args.id];
					return memory;
				}, context);
				return removed === undefined ? fail(`No memory #${args.id}`) : text(`Forgot #${args.id}: ${removed.topic}`);
			},
		}),
	],
});

// ---------------------------------------------------------------------------------------------------------------
// Sessions talking to each other.

export const Sessions_ = defineExtension({
	name: "pdl.sessions",
	tools: [
		defineTool({
			name: "sessions_list",
			description: "List the other agent sessions on this machine, their directories, purposes, and whether they are busy.",
			parameters: Type.Object({}),
			execute: async (_args, api, context) => {
				const sessions = await api.snapshot(Sessions, context);
				const inspection = await harness().inspect(context);
				const busy = new Set<number>(inspection.tasks.filter((task) => !task.record.background).map((task) => task.record.conversationId));
				const lines = Object.entries(sessions?.byName ?? {}).map(
					([name, info]) =>
						`${name}${info.conversationId === api.conversationId ? " (you)" : ""} — ${busy.has(info.conversationId) ? "busy" : "idle"} — ${info.cwd}${info.purpose ? ` — ${info.purpose}` : ""}`,
				);
				return text(lines.join("\n") || "No sessions.");
			},
		}),
		defineTool({
			name: "session_send",
			description:
				"Send a message to another session. It arrives as a user turn from you; it does not wait for a reply. The other session can answer with session_send. Use for handing off work, asking a question, or warning about a conflicting change.",
			parameters: Type.Object({
				to: Type.String({ description: "Session name" }),
				message: Type.String(),
				urgent: Type.Optional(Type.Boolean({ description: "Steer the session's current run instead of queueing after it" })),
			}),
			replay: "safe",
			execute: async (args, api, context) => {
				const sessions = await api.snapshot(Sessions, context);
				const target = sessions?.byName[args.to];
				if (target === undefined) return fail(`No session named ${args.to}`);
				if (target.conversationId === api.conversationId) return fail("That is you.");
				const from = sessionNameOf(sessions!.byName, api.conversationId) ?? "another session";
				const conversation = await api.conversation(target.conversationId as never, context);
				if (conversation === undefined) return fail(`Session ${args.to} has no conversation`);
				await conversation.submit(
					{
						type: "input",
						content: `[message from session "${from}"] ${args.message}`,
						whenBusy: args.urgent === true ? "steer" : "followUp",
						entry: { kind: "pdl.peer", data: { from, text: args.message } },
						requestId: `peer:${api.taskId}`,
					},
					context,
				);
				return text(`Sent to ${args.to}.`);
			},
		}),
	],
});

// ---------------------------------------------------------------------------------------------------------------
// Web access.

function isPrivateHost(hostname: string): boolean {
	return (
		hostname === "localhost" ||
		hostname.endsWith(".local") ||
		hostname.endsWith(".internal") ||
		/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|\[?f[cd])/i.test(hostname)
	);
}

export function htmlToText(html: string): string {
	return html
		.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, "")
		.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, "\n")
		.replace(/<li\b[^>]*>/gi, "- ")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s*\n\s*\n+/g, "\n\n")
		.trim();
}

/** One search request through the Messages API's server-side web search tool; returns cited text and the sources. */
async function anthropicWebSearch(query: string, allowedDomains: string[] | undefined, signal: AbortSignal | undefined): Promise<string> {
	const client = new Anthropic();
	const ref = splitModel(loadPolicy().searchModel);
	const messages: Anthropic.MessageParam[] = [
		{ role: "user", content: `Search the web and answer concisely, citing sources with their URLs:\n\n${query}` },
	];
	const parts: string[] = [];
	const sources = new Map<string, string>();
	// A long search can pause mid-turn; continue it a few times by sending the paused turn back.
	for (let attempt = 0; attempt < 3; attempt++) {
		const response = await client.messages.create(
			{
				model: ref.modelId,
				max_tokens: 16000,
				output_config: { effort: "low" },
				tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5, ...(allowedDomains?.length ? { allowed_domains: allowedDomains } : {}) }],
				messages,
			},
			{ signal },
		);
		for (const block of response.content) {
			if (block.type === "text") {
				parts.push(block.text);
				for (const citation of block.citations ?? []) {
					if (citation.type === "web_search_result_location") sources.set(citation.url, citation.title ?? citation.url);
				}
			} else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
				for (const result of block.content) sources.set(result.url, result.title);
			}
		}
		if (response.stop_reason !== "pause_turn") break;
		messages.push({ role: "assistant", content: response.content });
	}
	const list = [...sources].map(([url, title], i) => `${i + 1}. ${title}\n   ${url}`).join("\n");
	return `${parts.join("").trim() || "No answer."}\n\nSources:\n${list || "(none)"}`;
}

export const Web_ = defineExtension({
	name: "pdl.web",
	tools: [
		defineTool({
			name: "web_search",
			description:
				"Search the web (Anthropic server-side search). Returns a sourced answer with citations plus the result URLs; follow up with web_fetch for full pages.",
			parameters: Type.Object({
				query: Type.String({ description: "What to find out; a question works better than bare keywords" }),
				allowedDomains: Type.Optional(Type.Array(Type.String(), { description: "Only search these hostnames, e.g. docs.python.org" })),
			}),
			replay: "safe",
			execute: async (args, _api, context) => {
				try {
					return text(await anthropicWebSearch(args.query, args.allowedDomains, context.abortSignal));
				} catch (error) {
					if (error instanceof Anthropic.AuthenticationError) return fail("Web search failed: ANTHROPIC_API_KEY is missing or invalid.");
					if (error instanceof Anthropic.RateLimitError) return fail("Web search is rate limited; try again shortly.");
					if (error instanceof Anthropic.APIError) return fail(`Web search failed: ${error.status} ${error.message}`);
					throw error;
				}
			},
		}),
		defineTool({
			name: "web_fetch",
			description: "Fetch a public web page or raw file and return it as text. Public http(s) URLs only.",
			parameters: Type.Object({
				url: Type.String(),
				maxChars: Type.Optional(Type.Number({ default: 30_000 })),
			}),
			replay: "safe",
			execute: async (args, _api, context) => {
				let url: URL;
				try {
					url = new URL(args.url);
				} catch {
					return fail("Invalid URL");
				}
				if (!/^https?:$/.test(url.protocol)) return fail("Only http(s) URLs");
				if (isPrivateHost(url.hostname)) return fail("Private and local addresses are blocked");
				const response = await fetch(url, {
					headers: { "User-Agent": "pi-durable-local/0.1 (+agent fetch)", Accept: "text/html,text/plain,application/json,*/*" },
					redirect: "follow",
					signal: AbortSignal.any([context.abortSignal ?? new AbortController().signal, AbortSignal.timeout(30_000)]),
				});
				if (isPrivateHost(new URL(response.url).hostname)) return fail("Redirected to a private address; blocked");
				const type = response.headers.get("content-type") ?? "";
				const raw = await response.text();
				const body = type.includes("html") ? htmlToText(raw) : raw;
				const max = args.maxChars ?? 30_000;
				return text(
					`${response.status} ${response.url}\n\n${body.length > max ? `${body.slice(0, max)}\n…(truncated, ${body.length} chars total)` : body}`,
				);
			},
		}),
	],
});

// ---------------------------------------------------------------------------------------------------------------
// Gated merge. Every gate must pass; any doubt leaves the PR open for a human.

type PrView = {
	number: number;
	title: string;
	body: string;
	state: string;
	isDraft: boolean;
	baseRefName: string;
	headRefName: string;
	headRefOid: string;
	additions: number;
	deletions: number;
	changedFiles: number;
	files: { path: string }[];
	mergeable: string;
	reviewDecision: string;
};

async function gh(args: string[], context: Context): Promise<string> {
	const { stdout } = await run("gh", args, { maxBuffer: 64 * 1024 * 1024, signal: context.abortSignal, env: { ...process.env, GH_PROMPT_DISABLED: "1" } });
	return stdout;
}

export type GateResult = { ok: true; summary: string } | { ok: false; reasons: string[] };

export async function evaluateMergeGates(
	repo: string,
	number: number,
	policy: Policy,
	review: (pr: PrView, diff: string) => Promise<{ approve: boolean; reasons: string[] }>,
	context: Context,
): Promise<{ result: GateResult; pr?: PrView }> {
	const rules = policy.automerge;
	if (!rules.repos.includes(repo)) {
		return { result: { ok: false, reasons: [`${repo} is not in automerge.repos in ~/.config/pi-durable/policy.json`] } };
	}
	const pr = JSON.parse(
		await gh(
			["pr", "view", String(number), "--repo", repo, "--json",
				"number,title,body,state,isDraft,baseRefName,headRefName,headRefOid,additions,deletions,changedFiles,files,mergeable,reviewDecision"],
			context,
		),
	) as PrView;
	const defaultBranch = (await gh(["repo", "view", repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"], context)).trim();
	const reasons: string[] = [];
	if (pr.state !== "OPEN") reasons.push(`PR is ${pr.state}`);
	if (pr.isDraft) reasons.push("PR is a draft");
	if (pr.baseRefName !== defaultBranch) reasons.push(`base is ${pr.baseRefName}, not ${defaultBranch}`);
	if (!pr.headRefName.startsWith(rules.branchPrefix)) reasons.push(`head branch ${pr.headRefName} lacks prefix ${rules.branchPrefix}`);
	if (pr.mergeable !== "MERGEABLE") reasons.push(`GitHub says mergeable=${pr.mergeable}`);
	if (pr.reviewDecision === "CHANGES_REQUESTED") reasons.push("a reviewer requested changes");
	const lines = pr.additions + pr.deletions;
	if (lines > rules.maxChangedLines) reasons.push(`${lines} changed lines > limit ${rules.maxChangedLines}; split the PR`);
	if (pr.changedFiles > rules.maxChangedFiles) reasons.push(`${pr.changedFiles} files > limit ${rules.maxChangedFiles}`);
	const touched = protectedMatches(pr.files.map((file) => file.path), rules.protectedPaths);
	if (touched.length > 0) reasons.push(`touches protected paths (human review needed): ${touched.join(", ")}`);

	let checks: { name: string; bucket: string }[] = [];
	try {
		checks = JSON.parse(await gh(["pr", "checks", String(number), "--repo", repo, "--json", "name,bucket"], context));
	} catch (error) {
		// `gh pr checks` exits non-zero when checks fail or none exist; its JSON is still on stdout.
		const stdout = (error as { stdout?: string }).stdout ?? "";
		checks = stdout.trim().startsWith("[") ? JSON.parse(stdout) : [];
	}
	const pending = checks.filter((check) => check.bucket === "pending");
	const failed = checks.filter((check) => check.bucket === "fail" || check.bucket === "cancel");
	if (failed.length > 0) reasons.push(`failing checks: ${failed.map((check) => check.name).join(", ")}`);
	if (pending.length > 0) reasons.push(`checks still running: ${pending.map((check) => check.name).join(", ")} (try again later)`);
	if (rules.requireChecks && checks.filter((check) => check.bucket === "pass").length === 0) {
		reasons.push("no passing CI checks; repos without CI are never auto-merged");
	}
	// Cheap gates first: the model review runs only when everything else passed.
	if (reasons.length === 0 && rules.requireAiReview) {
		const diff = await gh(["pr", "diff", String(number), "--repo", repo], context);
		const verdict = await review(pr, diff);
		if (!verdict.approve) reasons.push(...verdict.reasons.map((reason) => `review: ${reason}`));
	}
	if (reasons.length > 0) return { result: { ok: false, reasons }, pr };
	return {
		result: { ok: true, summary: `${lines} lines in ${pr.changedFiles} files, ${checks.length} checks green, review approved` },
		pr,
	};
}

const REVIEW_PROMPT = `You are the last automated gate before a pull request is merged to the default branch with no human review.
Approve only if the change is correct, coherent, matches the PR description, includes or updates tests where behavior changed, and has no security problems (secrets, injection, auth bypass, unsafe deserialization, disabled checks), no destructive data changes, and no unrelated edits.
When in doubt, reject: a human will look at rejected PRs.
Reply with JSON only: {"approve": true|false, "reasons": ["..."]}. Give concrete reasons on reject.`;

export const Git_ = defineExtension({
	name: "pdl.git",
	tools: [
		defineTool({
			name: "pr_merge",
			description:
				"Request a merge of one of your PRs. Runs every safety gate (allowlisted repo, work-branch prefix, CI green, size limits, protected paths, independent AI review) and merges only if all pass, pinned to the reviewed head commit. Otherwise returns the reasons and leaves the PR open.",
			parameters: Type.Object({
				repo: Type.String({ description: "owner/repo" }),
				number: Type.Number(),
			}),
			execute: async (args, api, context) => {
				const policy = loadPolicy();
				const { name } = await sessionCwd(api, api.conversationId, context);
				const review = async (pr: PrView, diff: string) => {
					const ref = splitModel(policy.reviewModel);
					const model = api.models.getModels().find((m) => m.provider === ref.provider && m.id === ref.modelId);
					if (model === undefined) return { approve: false, reasons: [`review model ${policy.reviewModel} not found`] };
					const clipped = diff.length > 200_000 ? `${diff.slice(0, 200_000)}\n…(diff truncated)` : diff;
					const answer = await api.models.completeSimple(
						model,
						{
							systemPrompt: REVIEW_PROMPT,
							messages: [
								{
									role: "user",
									content: `PR #${pr.number}: ${pr.title}\n\n${pr.body}\n\nDiff:\n${clipped}`,
									timestamp: Date.now(),
								},
							],
						},
						{ signal: context.abortSignal },
					);
					const reply = answer.content.map((part) => (part.type === "text" ? part.text : "")).join("");
					const json = /\{[\s\S]*\}/.exec(reply)?.[0];
					try {
						const parsed = JSON.parse(json ?? "") as { approve?: unknown; reasons?: unknown };
						return {
							approve: parsed.approve === true,
							reasons: Array.isArray(parsed.reasons) ? parsed.reasons.map(String) : ["no reasons given"],
						};
					} catch {
						return { approve: false, reasons: [`unparseable review reply: ${reply.slice(0, 200)}`] };
					}
				};
				let gates: Awaited<ReturnType<typeof evaluateMergeGates>>;
				try {
					gates = await evaluateMergeGates(args.repo, args.number, policy, review, context);
				} catch (error) {
					audit("merge_error", { session: name, repo: args.repo, pr: args.number, error: String(error) });
					return fail(`Could not evaluate the PR: ${String(error).slice(0, 500)}`);
				}
				if (!gates.result.ok) {
					audit("merge_refused", { session: name, repo: args.repo, pr: args.number, reasons: gates.result.reasons });
					const body = `🛑 **pi-durable auto-merge held this PR**\n\n${gates.result.reasons.map((r) => `- ${r}`).join("\n")}`;
					await gh(["pr", "comment", String(args.number), "--repo", args.repo, "--body", body], context).catch(() => undefined);
					return fail(`Not merged. Gates that failed:\n- ${gates.result.reasons.join("\n- ")}`);
				}
				try {
					await gh(
						["pr", "merge", String(args.number), "--repo", args.repo, `--${policy.automerge.mergeMethod}`,
							"--delete-branch", "--match-head-commit", gates.pr!.headRefOid],
						context,
					);
				} catch (error) {
					audit("merge_failed", { session: name, repo: args.repo, pr: args.number, error: String(error) });
					return fail(`Gates passed but the merge failed: ${String(error).slice(0, 500)}`);
				}
				audit("merged", { session: name, repo: args.repo, pr: args.number, sha: gates.pr!.headRefOid, summary: gates.result.summary });
				return text(`Merged ${args.repo}#${args.number} (${gates.result.summary}).`);
			},
		}),
	],
});

// ---------------------------------------------------------------------------------------------------------------
// Loops: a durable task that wakes a session on an interval to push a goal forward, within a budget.

function costOf(usage: { models: Record<string, unknown>; tools: Record<string, unknown> } | undefined): number {
	let total = 0;
	for (const bucket of [usage?.models ?? {}, usage?.tools ?? {}]) {
		for (const entry of Object.values(bucket)) total += (entry as { cost?: { total?: number } }).cost?.total ?? 0;
	}
	return total;
}

export function loopPrompt(loop: Loop, policy: Policy): string {
	return `[loop ${loop.id}, iteration ${loop.iteration + 1}/${loop.maxIterations}]
Ongoing goal: ${loop.goal}

Advance this goal by one meaningful, reviewable step, then stop. Each iteration:
1. Orient: check memory, git status, open PRs (\`gh pr list --author @me\`), CI results, and notes from the last iteration.
2. If a previous PR of yours is open: get it green and through \`pr_merge\`, or address the gate reasons. Prefer finishing over starting.
3. Otherwise pick the next step. Early on that may be conceptual work (a PLAN.md, issues, a spike); later, implementation on a fresh \`${policy.automerge.branchPrefix}…\` branch with tests, pushed and opened as a PR.
4. Save what the next iteration needs to know with memory_save (project scope).
5. Finish by calling loop_report with status "continue", "done" (goal fully achieved), or "blocked" (needs Tony), and a one-line note.`;
}

type LoopCheckpoint = { phase: "wait" } | { phase: "run"; iteration: number };

export const LoopTask = defineTask<{ loopId: string }, LoopCheckpoint, { iterations: number }>({
	name: "pdl.loop",
	version: 1,
	initial: () => ({ phase: "run", iteration: 0 }),
	phases: {
		wait: async (task, runtime, context) => {
			const loop = (await runtime.snapshot(Loops, context))?.byId[task.input.loopId];
			if (loop === undefined || loop.status !== "active") {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { iterations: loop?.iteration ?? 0 } } }), context);
				return;
			}
			await runtime.sleepUntil(loop.nextRunAt ?? Date.now(), { phase: "run", iteration: loop.iteration }, context);
		},
		run: async (task, runtime, context) => {
			const policy = loadPolicy();
			const loop = (await runtime.snapshot(Loops, context))?.byId[task.input.loopId];
			const sessions = await runtime.snapshot(Sessions, context);
			const session = loop === undefined ? undefined : sessions?.byName[loop.session];
			const stop = async (status: Loop["status"], note: string) =>
				runtime.commit(async (tx) => {
					const current = (await tx.doc(Loops)).byId[task.input.loopId];
					if (current !== undefined && current.status === "active") Object.assign(current, { status, note });
					return { status: "terminal", outcome: { status: "completed", result: { iterations: current?.iteration ?? 0 } } };
				}, context);
			if (loop === undefined || loop.status !== "active") return stop("done", loop?.note ?? "");
			if (session === undefined) return stop("failed", `session ${loop.session} no longer exists`);
			const usage = await runtime.snapshot(UsageDoc, session.conversationId as never, context);
			const spent = costOf(usage) - loop.costAtStart;
			if (spent >= loop.budgetUsd) return stop("paused", `budget reached: $${spent.toFixed(2)} of $${loop.budgetUsd}`);
			if (loop.iteration >= loop.maxIterations) return stop("done", `reached ${loop.maxIterations} iterations`);

			const conversation = await harness().conversation(session.conversationId as never, context);
			if (conversation === undefined) return stop("failed", "conversation missing");
			// The request ID makes a rerun after a crash find the same submission instead of sending twice.
			const submission = await conversation.submit(
				{
					type: "input",
					content: loopPrompt(loop, policy),
					entry: { kind: "pdl.loop-tick", data: { loopId: loop.id, iteration: task.state.checkpoint.iteration } },
					requestId: `loop:${loop.id}:${task.state.checkpoint.iteration}`,
				},
				context,
			);
			const settled = await submission.wait(context);
			await runtime.commit(async (tx) => {
				const current = (await tx.doc(Loops)).byId[task.input.loopId]!;
				current.iteration = task.state.checkpoint.iteration + 1;
				current.lastRunAt = Date.now();
				current.nextRunAt = Date.now() + current.intervalMinutes * 60_000;
				if (settled.status !== "done" && current.status === "active") current.note = `iteration ${current.iteration} ended ${settled.status}`;
				if (current.status === "active" && current.iteration >= current.maxIterations) {
					current.status = "done";
					current.note = `reached ${current.maxIterations} iterations`;
				}
				return { status: "running", checkpoint: { phase: "wait" } };
			}, context);
		},
	},
	abort: async (task, runtime, context) => {
		await runtime.commit(async (tx) => {
			const current = (await tx.doc(Loops)).byId[task.input.loopId];
			if (current !== undefined && current.status === "active") Object.assign(current, { status: "paused", note: "stopped" });
			return { status: "terminal", outcome: { status: "aborted" } };
		}, context);
	},
});

export const Loops_ = defineExtension({
	name: "pdl.loops",
	tasks: [LoopTask],
	tools: [
		defineTool({
			name: "loop_report",
			description:
				"End a loop iteration: record status and a one-line note. 'done' ends the loop (goal achieved); 'blocked' pauses it until Tony resumes it; 'continue' keeps it scheduled.",
			parameters: Type.Object({
				loopId: Type.String(),
				status: Type.Union([Type.Literal("continue"), Type.Literal("done"), Type.Literal("blocked")]),
				note: Type.String(),
			}),
			execute: async (args, api, context) => {
				const updated = await api.commit(async (tx) => {
					const loop = (await tx.doc(Loops)).byId[args.loopId];
					if (loop === undefined) return undefined;
					loop.note = args.note;
					if (loop.status === "active" && args.status !== "continue") loop.status = args.status === "done" ? "done" : "paused";
					return { ...loop };
				}, context);
				if (updated === undefined) return fail(`No loop ${args.loopId}`);
				audit("loop_report", { loop: args.loopId, status: args.status, note: args.note });
				return { ...text(`Loop ${args.loopId}: ${updated.status} — ${args.note}`), control: { terminate: true } };
			},
		}),
	],
});

// ---------------------------------------------------------------------------------------------------------------
// The guard: every tool call in every session passes through it.

export const Guard_ = defineExtension({
	name: "pdl.guard",
	hooks: [
		hook(ToolTask, {
			beforeTool: async (call, api, context) => {
				const { name, cwd } = await sessionCwd(api, api.conversationId, context);
				const reason = checkToolCall(call.name, call.arguments as Record<string, unknown>, cwd ?? resolve("/nonexistent"), loadPolicy());
				if (reason === undefined) return undefined;
				audit("blocked", { session: name, tool: call.name, args: call.arguments, reason });
				return { block: `Blocked by safety policy: ${reason}` };
			},
		}),
	],
});

