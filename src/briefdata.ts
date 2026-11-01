// Gathers the inputs for `pd brief` from the daemon and GitHub. Shared by the terminal client and the MCP console,
// so both show the same brief. brief.ts stays pure; the side effects live here.
import { execFile } from "node:child_process";
import { buildBrief } from "./brief.ts";
import type { AuditEntry, BriefInput } from "./brief.ts";
import { openParks } from "./brief.ts";
import { AGENDA_TOPIC } from "./devil.ts";

type Json = any;
/** Calls a daemon route, like client.ts `call`. */
export type DaemonCall = (method: string, path: string, body?: unknown) => Promise<Json>;
/** Runs `gh` and resolves with its exit status and stdout; never rejects. */
export type GhRun = (args: string[]) => Promise<{ status: number; stdout: string }>;

export const runGh: GhRun = (args) =>
	new Promise((done) => {
		execFile("gh", args, { encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
			done({ status: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: stdout ?? "" });
		});
	});

export async function collectBriefInput(call: DaemonCall, gh: GhRun = runGh, now = Date.now()): Promise<BriefInput> {
	const [s, audit, memories, dirs] = await Promise.all([
		call("GET", "/status"),
		call("GET", "/audit") as Promise<AuditEntry[]>,
		call("GET", "/memory").catch(() => []),
		call("GET", "/directions").catch(() => ({})) as Promise<Record<string, Json>>,
	]);
	const agenda = (memories as Json[]).filter((m) => m.topic === AGENDA_TOPIC).sort((a, b) => b.updatedAt - a.updatedAt)[0];
	const parked = openParks(audit, new Set(audit.filter((e) => e.event === "parked").map((e) => `${e.repo}#${e.pr}`)));
	const owners = [...new Set(audit.map((e) => e.repo?.split("/")[0]).filter(Boolean))] as string[];
	const search = async (owner: string, label: string, fields: string) => {
		const out = await gh(["search", "issues", "--owner", owner, "--label", label, "--state", "open", "--json", fields]);
		return out.status === 0 ? (JSON.parse(out.stdout || "[]") as Json[]) : [];
	};
	const [states, decisionLists, proposalLists] = await Promise.all([
		Promise.all(parked.map(async (park) => ({ key: park.key, open: (await gh(["pr", "view", String(park.pr), "-R", park.repo, "--json", "state", "--jq", ".state"])).stdout.trim() === "OPEN" }))),
		Promise.all(owners.map((owner) => search(owner, "needs-decision", "repository,number,title"))),
		Promise.all(owners.map((owner) => search(owner, "proposal", "repository,number,title,createdAt,body"))),
	]);
	return {
		now,
		sessions: s.sessions,
		loops: s.loops,
		audit,
		openPrs: new Set(states.filter((x) => x.open).map((x) => x.key)),
		decisions: decisionLists.flat().map((i) => ({ repo: i.repository.nameWithOwner, number: i.number, title: i.title })),
		proposals: proposalLists.flat().map((i) => ({ repo: i.repository.nameWithOwner, number: i.number, title: i.title, createdAt: i.createdAt, defaultBy: /^Default by:\s*(\S+)/m.exec(i.body ?? "")?.[1] })),
		directions: Object.entries(dirs).map(([key, d]) => ({ key, ...d })) as never,
		...(s.budget ? { budget: s.budget } : {}),
		...(agenda ? { agenda: { text: agenda.text, by: agenda.by, updatedAt: agenda.updatedAt } } : {}),
	};
}

export async function collectBrief(call: DaemonCall, gh: GhRun = runGh): Promise<string> {
	return buildBrief(await collectBriefInput(call, gh));
}
