import { type PivotDirection, pivotLines, pivotStale } from "./direction.ts";
// `pd brief`: the one read a general needs. Generals are the Opus Claude Code sessions (and Tony) that steer the
// factory from outside; pi's sessions are the cheap workforce. The brief puts what only a general can do first
// (approve a parked PR, unblock a loop, answer a needs-decision issue), then a one-line view of the workforce.
// Pure: the client gathers the inputs, so this is tested without a daemon or GitHub.

export type AuditEntry = { at: string; event: string; session?: string; loop?: string; repo?: string; pr?: number; sha?: string; reason?: string; note?: string; details?: string[] };
export type BriefLoop = { lastRunAt?: number; id: string; session: string; status: string; dormant?: boolean; goal: string; note?: string; spent?: number; budgetUsd: number; iteration: number };
export type BriefSession = { name: string; busy: boolean; model?: string; cost: number };
export type BriefIssue = { repo: string; number: number; title: string };

export type BriefInput = {
	now: number;
	sessions: BriefSession[];
	loops: BriefLoop[];
	audit: AuditEntry[];
	/** "owner/repo#n" of PRs still open; parked PRs not in it were merged or closed since. */
	openPrs: Set<string>;
	decisions: BriefIssue[];
	directions?: PivotDirection[];
};

export type ParkedPr = { key: string; repo: string; pr: number; sha: string; reason: string; review?: string; at: string };

const DAY = 24 * 60 * 60_000;

/** The latest park of each PR that is still open and has not been approved at that head since. */
export function openParks(audit: AuditEntry[], openPrs: Set<string>): ParkedPr[] {
	const latest = new Map<string, ParkedPr>();
	for (const entry of audit) {
		if (entry.repo === undefined || entry.pr === undefined) continue;
		const key = `${entry.repo}#${entry.pr}`;
		if (entry.event === "parked" && entry.sha !== undefined) {
			const review = entry.details?.find((d) => d.startsWith("review: "));
			latest.set(key, { key, repo: entry.repo, pr: entry.pr, sha: entry.sha, reason: entry.reason ?? "", review: review?.slice(8), at: entry.at });
		} else if (entry.event === "merged" || (entry.event === "human_approved" && latest.get(key)?.sha === entry.sha)) {
			latest.delete(key);
		}
	}
	return [...latest.values()].filter((park) => openPrs.has(park.key));
}

const clip = (text: string, length: number) => (text.length <= length ? text : `${text.slice(0, length - 1)}…`);

export function buildBrief(input: BriefInput): string {
	const lines: string[] = [];
	const parks = openParks(input.audit, input.openPrs);
	const stuck = input.loops.filter((loop) => loop.status === "paused" || loop.status === "failed");
	const stale = (input.directions ?? []).filter((d) => input.now - d.at <= 48 * 3_600_000).flatMap((d) => pivotStale(d, input.loops, input.now));
	const needs = parks.length + stuck.length + input.decisions.length + stale.length;

	lines.push(needs === 0 ? "NEEDS A GENERAL: nothing. The workforce is unblocked." : `NEEDS A GENERAL (${needs})`);
	for (const park of parks) {
		lines.push(`- PR ${park.key} parked: ${park.reason}`);
		if (park.review) lines.push(`    review: ${clip(park.review, 300)}`);
		lines.push(`    approve: pd approve ${park.repo} ${park.pr} ${park.sha}   (read the diff first: gh pr diff ${park.pr} -R ${park.repo})`);
	}
	for (const loop of stuck) {
		lines.push(`- loop ${loop.id} (${loop.session}) ${loop.status}: ${clip(loop.note ?? "no note", 300)}`);
		lines.push(`    resume: pd loop resume ${loop.id}`);
	}
	for (const { loop, why } of stale) lines.push(`- loop ${loop.id} (${loop.session}) ${why}`);
	for (const issue of input.decisions) lines.push(`- decision ${issue.repo}#${issue.number}: ${clip(issue.title, 160)}`);

	const since = input.now - DAY;
	const recent = input.audit.filter((entry) => Date.parse(entry.at) >= since);
	const merged = recent.filter((entry) => entry.event === "merged");
	lines.push("", `LAST 24H: ${merged.length} merged${merged.length ? ` (${merged.map((m) => `${m.repo}#${m.pr}`).join(", ")})` : ""}`);

	const active = input.loops.filter((loop) => loop.status === "active");
	lines.push("", `WORKFORCE: ${input.sessions.filter((s) => s.busy).length}/${input.sessions.length} sessions busy, ${active.filter((l) => !l.dormant).length} loops working, ${active.filter((l) => l.dormant).length} dormant`);
	for (const loop of active) {
		lines.push(`- ${loop.id} ${loop.session}${loop.dormant ? " (dormant)" : ""} $${(loop.spent ?? 0).toFixed(2)}/$${loop.budgetUsd}: ${clip(loop.note ?? loop.goal, 160)}`);
	}
	lines.push(...pivotLines(input.directions ?? [], input.loops, input.now));
	const models = [...new Set(input.sessions.map((s) => s.model).filter(Boolean))];
	lines.push("", `Total session spend: $${input.sessions.reduce((sum, s) => sum + s.cost, 0).toFixed(2)}. Models in use: ${models.join(", ") || "unknown"}.`);
	return lines.join("\n");
}
