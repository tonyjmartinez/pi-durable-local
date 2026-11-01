// Friction issues: durable papercuts that agents file so another agent can fix them.
// The fields and the P0-P3 / needs-decision labels follow Kent C. Dodds's autopilot friction log
// (https://github.com/kentcdodds/kcd-skills, MIT). Everything here is pure; filing the issue is the caller's job.
import { redact } from "./redact.ts";

export type Priority = "P0" | "P1" | "P2" | "P3";

export type FrictionInput = {
	title: string;
	whatHappened: string;
	whatYouWanted: string;
	howToReproduce: string;
	cost: string;
	/** What was already tried or read before filing. */
	alreadyLooked?: string;
	relevantFiles?: readonly string[];
	priority: Priority;
	/** A human call is needed (a policy change, a product decision): agents wait for it. */
	needsDecision?: boolean;
	/** A strategist proposal for the owner: labelled `proposal` and `needs-decision`, never by title alone. */
	proposal?: boolean;
	/** ISO time a two-way proposal is adopted by default if nobody answers. */
	defaultBy?: string;
	/** Stable identity for deduplication, e.g. `guard:<rule>`. Written into the body as a hidden marker. */
	key?: string;
};

export const FRICTION_LABEL = "friction";
export const PROPOSAL_LABEL = "proposal";

export const FRICTION_TEMPLATE = `## What happened

<What went wrong or got in the way.>

## What you wanted

<What should have happened.>

## How to reproduce

<Steps or the exact command, enough for the next agent to see it without your session.>

## Cost

<Time, retries, or risk it caused, and how often.>

## What you already looked at

<Files, docs, and issues you checked.>

## Relevant files

<Paths, one per line.>

Priority: <P0 | P1 | P2 | P3>
Needs decision: <yes | no>
`;

const KEY_MARKER = /<!--\s*friction-key:\s*(.+?)\s*-->/i;

const oneLine = (text: string) => redact(text).replace(/\s+/g, " ").trim();
const block = (text: string | undefined, fallback: string) => {
	const cleaned = redact(text ?? "").trim();
	return cleaned === "" ? fallback : cleaned;
};

export function buildFrictionIssue(input: FrictionInput): { title: string; body: string; labels: string[] } {
	const title = oneLine(input.title).slice(0, 120) || "Untitled friction";
	const files = (input.relevantFiles ?? []).map((file) => oneLine(file)).filter((file) => file !== "");
	const sections = [
		`## What happened\n\n${block(input.whatHappened, "(not given)")}`,
		`## What you wanted\n\n${block(input.whatYouWanted, "(not given)")}`,
		`## How to reproduce\n\n${block(input.howToReproduce, "(not given)")}`,
		`## Cost\n\n${block(input.cost, "(not given)")}`,
		`## What you already looked at\n\n${block(input.alreadyLooked, "(nothing recorded)")}`,
		`## Relevant files\n\n${files.length === 0 ? "(none)" : files.map((file) => `- \`${file}\``).join("\n")}`,
		`Priority: ${input.priority}\nNeeds decision: ${input.needsDecision === true || input.proposal === true ? "yes" : "no"}`,
	];
	if (input.proposal === true && input.defaultBy !== undefined) sections.push(`Default by: ${oneLine(input.defaultBy)}`);
	if (input.key !== undefined) sections.push(`<!-- friction-key: ${oneLine(input.key)} -->`);
	const labels = [FRICTION_LABEL, input.priority];
	if (input.needsDecision === true || input.proposal === true) labels.push("needs-decision");
	if (input.proposal === true) labels.push(PROPOSAL_LABEL);
	return { title, body: `${sections.join("\n\n")}\n`, labels };
}

const STOP = new Set(["the", "and", "for", "are", "but", "not", "you", "with", "that", "this", "from", "have", "has", "was", "were", "can", "its", "into", "when", "why", "what", "how", "should", "would", "could", "does", "doesn", "don", "all", "any", "out", "get", "got", "too", "very", "also"]);

function tokens(text: string): Set<string> {
	const out = new Set<string>();
	// "re-runs" and "reruns" are one word.
	const joined = text.toLowerCase().replace(/<!--[\s\S]*?-->/g, " ").replace(/(?<=[a-z0-9])-(?=[a-z0-9])/g, "");
	for (const raw of joined.split(/[^a-z0-9_]+/)) {
		if (raw.length < 3 || STOP.has(raw)) continue;
		// Crude plural/tense folding so "blocks" and "blocked" meet.
		out.add(raw.replace(/(?:ing|ed|es|s)$/, ""));
	}
	return out;
}

/** Every friction issue shares the template's headings and trailer lines; only the content tells them apart. */
const bodyContent = (body: string) =>
	body
		.split("\n")
		.filter((line) => !/^\s*(?:#{1,6}\s|priority:|needs decision:|\(none\)|\(not given\)|\(nothing recorded\))/i.test(line))
		.join("\n");

function overlap(a: Set<string>, b: Set<string>): number {
	const small = Math.min(a.size, b.size);
	// A short body is contained in a long one too easily; below five tokens fall back to the stricter measure.
	if (small < 5) return jaccard(a, b);
	let shared = 0;
	for (const token of a) if (b.has(token)) shared++;
	return shared / small;
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let shared = 0;
	for (const token of a) if (b.has(token)) shared++;
	return shared / (a.size + b.size - shared);
}

export const DUPLICATE_THRESHOLDS = {
	/** Titles this alike are the same issue on their own. */
	title: 0.8,
	/** Titles this alike AND bodies this alike are the same issue. */
	titleWithBody: 0.55,
	body: 0.5,
};

/** The number of an open issue that is the same friction, or undefined. Errs toward filing a new issue. */
export function findDuplicate(
	candidate: { title: string; body: string },
	openIssues: readonly { number: number; title: string; body: string }[],
	thresholds = DUPLICATE_THRESHOLDS,
): number | undefined {
	const key = KEY_MARKER.exec(candidate.body)?.[1]?.toLowerCase();
	const titleTokens = tokens(candidate.title);
	const bodyTokens = tokens(bodyContent(candidate.body));
	let best: { number: number; score: number } | undefined;
	for (const issue of openIssues) {
		const issueKey = KEY_MARKER.exec(issue.body ?? "")?.[1]?.toLowerCase();
		if (key !== undefined && issueKey === key) return issue.number;
		// Two keyed issues about different things share boilerplate; the keys settle it.
		if (key !== undefined && issueKey !== undefined) continue;
		const titleScore = jaccard(titleTokens, tokens(issue.title));
		const bodyScore = overlap(bodyTokens, tokens(bodyContent(issue.body ?? "")));
		const same = titleScore >= thresholds.title || (titleScore >= thresholds.titleWithBody && bodyScore >= thresholds.body);
		if (same && (best === undefined || titleScore + bodyScore > best.score)) best = { number: issue.number, score: titleScore + bodyScore };
	}
	return best?.number;
}

export type AuditEntry = { at?: string; event?: string; session?: string; tool?: string; args?: Record<string, unknown>; reason?: string };

export type AuditWindow = {
	/** Defaults to the current time. */
	now?: number;
	/** Look back this far. Default 24. */
	hours?: number;
	/** Report a rule blocked at least this many times. Default 3. */
	minCount?: number;
};

export type AuditFriction = FrictionInput & { key: string; count: number; sessions: string[] };

function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	const cut = text.slice(0, max);
	return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max / 2))}…`;
}

/** Collapse the parts of a block reason that vary per call, so the same rule groups together. */
export function normalizeReason(reason: string): string {
	return reason.replace(/"[^"]*"/g, '"…"').replace(/\b\d+\b/g, "N").replace(/\s+/g, " ").trim();
}

function exampleOf(entry: AuditEntry): string {
	const args = entry.args ?? {};
	const text = typeof args.command === "string" ? args.command : typeof args.path === "string" ? args.path : JSON.stringify(args);
	return redact(`${entry.tool ?? "tool"}: ${text}`.split("\n")[0]!).slice(0, 200);
}

/** Repeated guard blocks, grouped by rule reason across sessions, as friction candidates. */
export function frictionFromAudit(entries: readonly AuditEntry[], window: AuditWindow = {}): AuditFriction[] {
	const now = window.now ?? Date.now();
	const since = now - (window.hours ?? 24) * 3_600_000;
	const minCount = window.minCount ?? 3;
	const groups = new Map<string, { reason: string; entries: AuditEntry[] }>();
	for (const entry of entries) {
		if (entry.event !== "blocked" || typeof entry.reason !== "string" || entry.reason === "") continue;
		const at = Date.parse(entry.at ?? "");
		if (!Number.isFinite(at) || at < since || at > now + 60_000) continue;
		const key = normalizeReason(entry.reason);
		const group = groups.get(key) ?? { reason: entry.reason, entries: [] };
		group.entries.push(entry);
		groups.set(key, group);
	}
	const out: AuditFriction[] = [];
	for (const [normalized, group] of groups) {
		if (group.entries.length < minCount) continue;
		const sessions = [...new Set(group.entries.map((entry) => entry.session ?? "(unknown)"))].sort();
		const examples = [...new Set(group.entries.map(exampleOf))].slice(0, 3);
		const count = group.entries.length;
		out.push({
			title: `Guard keeps blocking: ${clip(redact(normalized), 90)}`,
			whatHappened: `The safety guard blocked the same rule ${count} times in the last ${window.hours ?? 24}h, across ${sessions.length} session${sessions.length === 1 ? "" : "s"} (${sessions.join(", ")}).\n\nRule: ${redact(group.reason)}\n\nExamples:\n${examples.map((example) => `- \`${example}\``).join("\n")}`,
			whatYouWanted: "Either the agents stop attempting this, or the rule is relaxed or documented where agents read it, so they do not keep retrying.",
			howToReproduce: "Search audit.jsonl for `\"event\":\"blocked\"` entries with this reason.",
			cost: `${count} blocked tool calls and the retries around them.`,
			relevantFiles: ["src/guard.ts", "~/.local/share/pi-durable/audit.jsonl"],
			priority: count >= 10 ? "P1" : "P2",
			needsDecision: true,
			key: `guard:${normalized}`,
			count,
			sessions,
		});
	}
	return out.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}
