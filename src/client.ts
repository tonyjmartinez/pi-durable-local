// pd: terminal client for the pdd daemon.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { DB_PATH, ENV_FILE, loadSecrets, POLICY_FILE, SOCKET_PATH } from "./config.ts";

type Json = any;

function call(method: string, path: string, body?: unknown): Promise<Json> {
	return new Promise((done, fail) => {
		const req = request({ socketPath: SOCKET_PATH, method, path, headers: { "content-type": "application/json" } }, (res) => {
			let data = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => (data += chunk));
			res.on("end", () => {
				const parsed = data ? JSON.parse(data) : {};
				if ((res.statusCode ?? 500) >= 400) fail(new Error(parsed.error ?? `HTTP ${res.statusCode}`));
				else done(parsed);
			});
		});
		req.on("error", (error: NodeJS.ErrnoException) =>
			fail(error.code === "ENOENT" || error.code === "ECONNREFUSED" ? new Error(`pdd is not running. Start it: pdd-up (log: ${SOCKET_PATH.replace(/pdd\.sock$/, "pdd.log")})`) : error),
		);
		if (body !== undefined) req.write(JSON.stringify(body));
		req.end();
	});
}

const c = {
	dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
	bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
	cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
	green: (s: string) => `\x1b[32m${s}\x1b[0m`,
	red: (s: string) => `\x1b[31m${s}\x1b[0m`,
	yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
	magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

function flags(args: string[]): { positional: string[]; opts: Record<string, string | true> } {
	const positional: string[] = [];
	const opts: Record<string, string | true> = {};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg.startsWith("--")) {
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				opts[arg.slice(2)] = next;
				i++;
			} else opts[arg.slice(2)] = true;
		} else positional.push(arg);
	}
	return { positional, opts };
}

const money = (n: number) => `$${n.toFixed(2)}`;
const ago = (t?: number) => {
	if (!t) return "-";
	const s = Math.round((Date.now() - t) / 1000);
	return s < 0 ? `in ${fmtDur(-s)}` : `${fmtDur(s)} ago`;
};
const fmtDur = (s: number) => (s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);

// ---------------------------------------------------------------------------------------------------------------
// Rendering transcript entries and live events.

function textOf(content: Json): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part: Json) => (part.type === "text" ? part.text : part.type === "image" ? "[image]" : "")).join("");
}

function summarizeArgs(name: string, args: Json): string {
	if (args === undefined || args === null) return "";
	if (name === "bash") return String(args.command ?? "").split("\n")[0]!.slice(0, 160);
	if (typeof args.path === "string") return args.path;
	const s = JSON.stringify(args);
	return s.length > 160 ? `${s.slice(0, 157)}…` : s;
}

function renderEntry(entry: Json): string | undefined {
	const message = entry.model?.[0];
	switch (entry.kind) {
		case "pi.user":
			return `\n${c.bold(c.cyan("you ›"))} ${textOf(message?.content)}`;
		case "pdl.peer":
			return `\n${c.bold(c.magenta(`${entry.data?.from} ›`))} ${entry.data?.text}`;
		case "pdl.loop-tick":
			return `\n${c.bold(c.yellow(`loop ${entry.data?.loopId} › iteration ${Number(entry.data?.iteration) + 1}`))}`;
		case "pi.assistant": {
			const lines: string[] = [];
			for (const block of message?.content ?? []) {
				if (block.type === "text" && block.text.trim()) lines.push(block.text.trim());
				if (block.type === "toolCall") lines.push(c.dim(`⚙ ${block.name} ${summarizeArgs(block.name, block.arguments)}`));
			}
			return lines.length ? `${c.bold(c.green("pi ›"))} ${lines.join("\n")}` : undefined;
		}
		case "pi.tool-result":
			return message?.isError ? c.red(`  ✗ ${textOf(message.content).split("\n")[0]!.slice(0, 200)}`) : undefined;
		case "pi.compaction":
			return c.dim("── context compacted ──");
		case "pi.reset":
			return c.dim("── context reset ──");
		default:
			return undefined;
	}
}

async function attach(name: string): Promise<void> {
	const sessions = (await call("GET", "/status")).sessions as Json[];
	if (!sessions.some((s) => s.name === name)) throw new Error(`no session named ${name}`);
	console.log(c.dim(`attached to ${name}. Type to send (queued if busy). /steer <msg>, /abort, /reset [note], /compact, /model <m>, /quit. Detaching never stops the agent.`));

	let streaming = false;
	let running = false;
	const prompt = () => process.stdout.write(c.cyan(running ? "… " : "› "));
	const req = request({ socketPath: SOCKET_PATH, method: "GET", path: `/sessions/${name}/events` }, (res) => {
		let buffer = "";
		res.setEncoding("utf8");
		res.on("data", (chunk: string) => {
			buffer += chunk;
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line) onEvent(JSON.parse(line));
			}
		});
		res.on("end", () => {
			console.log(c.dim("\n[stream closed]"));
			process.exit(0);
		});
	});
	req.end();

	function onEvent(event: Json) {
		switch (event.type) {
			case "snapshot":
				for (const entry of event.entries.slice(-30)) {
					const text = renderEntry(entry);
					if (text) console.log(text);
				}
				running = event.run !== undefined;
				if (running) console.log(c.dim("[agent is working…]"));
				prompt();
				break;
			case "run_start":
				running = true;
				break;
			case "message_update":
				for (const change of event.changes) {
					if (change.type === "text_delta") {
						if (!streaming) process.stdout.write(`\n${c.bold(c.green("pi ›"))} `);
						streaming = true;
						process.stdout.write(change.delta);
					}
				}
				break;
			case "message_end":
				if (streaming) process.stdout.write("\n");
				streaming = false;
				break;
			case "tool_execution_start":
				if (!event.parentToolCallId) process.stdout.write(c.dim(`\n⚙ ${event.toolName} ${summarizeArgs(event.toolName, event.args)}`));
				break;
			case "tool_execution_end":
				if (!event.parentToolCallId) {
					const isError = event.entry?.model?.[0]?.isError;
					process.stdout.write(isError ? c.red(" ✗") : c.green(" ✓"));
					if (isError) process.stdout.write(c.red(`  ${textOf(event.entry.model[0].content).split("\n")[0]!.slice(0, 200)}`));
				}
				break;
			case "entry_appended":
				if (event.entry.kind !== "pi.assistant" && event.entry.kind !== "pi.tool-result") {
					const text = renderEntry(event.entry);
					if (text) console.log(text);
				}
				break;
			case "auto_retry_start":
				console.log(c.yellow(`\n[retry ${event.attempt}: ${event.errorMessage}]`));
				break;
			case "task_failed":
				console.log(c.red(`\n[${event.kind} failed: ${event.message}]`));
				break;
			case "submission":
				if (event.record.status === "unanswered") console.log(c.red(`\n[unanswered: ${JSON.stringify(event.record.reason ?? event.record.detail ?? "")}]`));
				break;
			case "run_end":
				running = false;
				process.stdout.write("\n");
				prompt();
				break;
		}
	}

	const rl = createInterface({ input: process.stdin });
	rl.on("line", async (line) => {
		const text = line.trim();
		try {
			if (text === "") return prompt();
			if (text === "/quit" || text === "/q") process.exit(0);
			else if (text === "/abort") await call("POST", `/sessions/${name}/abort`);
			else if (text.startsWith("/reset")) await call("POST", `/sessions/${name}/reset`, { handoff: text.slice(6).trim() || undefined });
			else if (text.startsWith("/compact")) await call("POST", `/sessions/${name}/compact`, { instructions: text.slice(8).trim() || undefined });
			else if (text.startsWith("/model ")) await call("POST", `/sessions/${name}/model`, { model: text.slice(7).trim() });
			else if (text.startsWith("/steer ")) await call("POST", `/sessions/${name}/send`, { text: text.slice(7), mode: "steer" });
			else await call("POST", `/sessions/${name}/send`, { text });
		} catch (error) {
			console.log(c.red(String((error as Error).message)));
			prompt();
		}
	});
	rl.on("close", () => process.exit(0));
}

// ---------------------------------------------------------------------------------------------------------------
// Commands.

async function status(): Promise<void> {
	const s = await call("GET", "/status");
	if (!s.keys.anthropic) console.log(c.red("ANTHROPIC_API_KEY is not set — run pd doctor"));
	console.log(c.bold("Sessions"));
	if (s.sessions.length === 0) console.log(c.dim("  none — create one: pd new <name> --cwd <dir> --purpose \"…\""));
	for (const row of s.sessions) {
		console.log(`  ${row.busy ? c.yellow("●") : c.green("○")} ${c.bold(row.name.padEnd(16))} ${money(row.cost).padStart(8)}  ${c.dim(row.model ?? "")}  ${row.cwd}${row.purpose ? c.dim(` — ${row.purpose}`) : ""}`);
	}
	if (s.loops.length > 0) {
		console.log(c.bold("\nLoops"));
		for (const loop of s.loops) printLoop(loop);
	}
	if (s.parked.length > 0) {
		console.log(c.bold(c.red("\nParked tasks (pd retry <id>)")));
		for (const task of s.parked) console.log(`  ${task.id} ${task.kind} ${task.blocked}`);
	}
	let total = 0;
	for (const bucket of [s.usage.models, s.usage.tools]) for (const u of Object.values(bucket) as Json[]) total += u.cost?.total ?? 0;
	console.log(c.dim(`\nTotal spend: ${money(total)}`));
}

function printLoop(loop: Json): void {
	const color = loop.status === "active" ? c.green : loop.status === "paused" ? c.yellow : loop.status === "failed" ? c.red : c.dim;
	console.log(
		`  ${c.bold(loop.id.padEnd(4))} ${color(loop.status.padEnd(7))} ${loop.session.padEnd(14)} ${loop.iteration}/${loop.maxIterations}  every ${loop.intervalMinutes}m  budget ${money(loop.budgetUsd)}  next ${loop.status === "active" ? ago(loop.nextRunAt) : "-"}`,
	);
	console.log(`       ${loop.goal.slice(0, 110)}`);
	if (loop.note) console.log(c.dim(`       ${loop.note.slice(0, 160)}`));
}

function doctor(): void {
	const ok = (label: string, good: boolean, hint = "") => console.log(`${good ? c.green("✓") : c.red("✗")} ${label}${good || !hint ? "" : c.dim(`  → ${hint}`)}`);
	const secrets = loadSecrets();
	ok("ANTHROPIC_API_KEY in " + ENV_FILE, Boolean(secrets.ANTHROPIC_API_KEY), `add: echo 'ANTHROPIC_API_KEY=sk-ant-…' >> ${ENV_FILE}`);
	ok("policy file " + POLICY_FILE, existsSync(POLICY_FILE));
	const pid = spawnSync("bash", ["-c", `kill -0 "$(cat ${DB_PATH.replace(/state\.sqlite$/, "pdd.pid")})" 2>/dev/null`]);
	ok("pdd supervisor running", pid.status === 0, "pdd-up (log: ~/.local/share/pi-durable/pdd.log)");
	ok("autostart on login", readFileSync(`${process.env.HOME}/.profile`, "utf8").includes("pdd-up"), "see README: add the pdd-up line to ~/.profile");
	ok("daemon socket " + SOCKET_PATH, existsSync(SOCKET_PATH));
	ok("store " + DB_PATH, existsSync(DB_PATH));
	const gh = spawnSync("gh", ["auth", "status"], { encoding: "utf8" });
	ok("GitHub CLI logged in", gh.status === 0, "gh auth login --git-protocol ssh --web");
	const policy = JSON.parse(readFileSync(POLICY_FILE, "utf8"));
	ok(`auto-merge repos: ${policy.automerge.repos.join(", ") || "none (PRs stay open)"}`, true);
}

function tmux(names: string[]): void {
	const self = resolve(import.meta.dirname, "..", "bin", "pd");
	const target = "pd";
	const has = spawnSync("tmux", ["has-session", "-t", target]).status === 0;
	if (!has) execFileSync("tmux", ["new-session", "-d", "-s", target, "-n", "status", `watch -c -n 5 ${self} status`]);
	const existing = execFileSync("tmux", ["list-windows", "-t", target, "-F", "#W"], { encoding: "utf8" }).split("\n");
	for (const name of names) if (!existing.includes(name)) execFileSync("tmux", ["new-window", "-t", target, "-n", name, `${self} attach ${name}`]);
	if (process.env.TMUX) execFileSync("tmux", ["switch-client", "-t", target], { stdio: "inherit" });
	else spawnSync("tmux", ["attach", "-t", target], { stdio: "inherit" });
}

const HELP = `pd — pi-durable sessions that keep running

  pd factory <owner/repo> ["goal"] [--base main] [--every 60] [--max 20] [--budget 5] [--name n]
                                            clone, create a session, and (with a goal) start a loop
  pd status                                 sessions, loops, spend
  pd new <name> --cwd <dir> [--purpose "…"] [--model provider/id]
  pd attach <name>                          live view + chat (Ctrl-C detaches; agent keeps going)
  pd send <name> "message" [--steer]        fire and forget
  pd rm <name>                              remove a session (its history stays in the store)
  pd tmux [names…]                          tmux session "pd": status window + one per session

  pd loop start <session> "goal" [--every 60] [--max 20] [--budget 5]
  pd loop ls | pause <id> | resume <id> | stop <id>

  pd mem [search words]                     shared memory
  pd mem add "topic" "fact" [--project <dir>]
  pd mem rm <id>

  pd gates <owner/repo> <pr>                dry-run every merge gate (incl. AI review), no merge
  pd audit                                  safety decisions and merges
  pd retry <taskId>                         rerun a parked task
  pd doctor                                 check setup`;

/** Start the daemon through its supervisor when the socket is missing, and wait for it to listen. */
async function ensureDaemon(): Promise<void> {
	if (existsSync(SOCKET_PATH)) return;
	spawnSync(resolve(import.meta.dirname, "..", "bin", "pdd-up"), { stdio: "inherit" });
	for (let i = 0; i < 40 && !existsSync(SOCKET_PATH); i++) await new Promise((done) => setTimeout(done, 250));
}

async function main(argv: string[]): Promise<void> {
	const [command = "status", ...rest] = argv;
	if (command !== "doctor" && command !== "help") await ensureDaemon();
	const { positional, opts } = flags(rest);
	switch (command) {
		case "status":
		case "ls":
			return status();
		case "new": {
			const created = await call("POST", "/sessions", {
				name: positional[0],
				cwd: resolve(String(opts.cwd ?? process.cwd())),
				purpose: typeof opts.purpose === "string" ? opts.purpose : "",
				model: typeof opts.model === "string" ? opts.model : undefined,
			});
			console.log(`created ${c.bold(created.name)} in ${created.cwd}. Attach: pd attach ${created.name}`);
			return;
		}
		case "factory": {
			const result = await call("POST", "/projects", {
				repo: positional[0],
				goal: positional.slice(1).join(" ") || undefined,
				name: typeof opts.name === "string" ? opts.name : undefined,
				purpose: typeof opts.purpose === "string" ? opts.purpose : undefined,
				baseBranch: typeof opts.base === "string" ? opts.base : undefined,
				intervalMinutes: opts.every ? Number(opts.every) : undefined,
				maxIterations: opts.max ? Number(opts.max) : undefined,
				budgetUsd: opts.budget ? Number(opts.budget) : undefined,
			});
			console.log(`session ${c.bold(result.session.name)} in ${result.session.cwd}`);
			if (result.loop) printLoop(result.loop);
			else console.log(c.dim(`no goal given; start one with: pd loop start ${result.session.name} "goal"`));
			return;
		}
		case "attach":
		case "a":
			return attach(positional[0] ?? "");
		case "send":
			await call("POST", `/sessions/${positional[0]}/send`, { text: positional.slice(1).join(" "), mode: opts.steer ? "steer" : "followUp" });
			console.log("sent");
			return;
		case "rm":
			await call("DELETE", `/sessions/${positional[0]}`);
			console.log(`removed ${positional[0]}`);
			return;
		case "tmux": {
			const names = positional.length > 0 ? positional : ((await call("GET", "/status")).sessions as Json[]).map((s) => s.name);
			return tmux(names);
		}
		case "loop": {
			const [sub = "ls", ...loopArgs] = positional;
			if (sub === "start") {
				const loop = await call("POST", "/loops", {
					session: loopArgs[0],
					goal: loopArgs.slice(1).join(" "),
					intervalMinutes: opts.every ? Number(opts.every) : undefined,
					maxIterations: opts.max ? Number(opts.max) : undefined,
					budgetUsd: opts.budget ? Number(opts.budget) : undefined,
				});
				printLoop(loop);
			} else if (sub === "ls") for (const loop of await call("GET", "/loops")) printLoop(loop);
			else printLoop(await call("POST", `/loops/${loopArgs[0]}/${sub}`));
			return;
		}
		case "mem": {
			if (positional[0] === "add") {
				const memory = await call("POST", "/memory", { topic: positional[1], text: positional.slice(2).join(" "), project: opts.project });
				console.log(`saved #${memory.id}`);
			} else if (positional[0] === "rm") {
				console.log((await call("DELETE", `/memory/${positional[1]}`)).removed ? "removed" : "no such memory");
			} else {
				const words = positional.map((w) => w.toLowerCase());
				const memories = (await call("GET", "/memory")) as Json[];
				for (const m of memories.sort((a, b) => b.updatedAt - a.updatedAt)) {
					const hay = `${m.topic} ${m.text} ${m.project ?? ""}`.toLowerCase();
					if (words.every((w) => hay.includes(w))) console.log(`${c.bold(`#${m.id}`)} ${c.cyan(m.topic)} ${c.dim(`(${m.project ?? "global"}, ${m.by}, ${ago(m.updatedAt)})`)}\n    ${m.text}`);
				}
			}
			return;
		}
		case "audit":
			for (const e of await call("GET", "/audit")) {
				const color = e.event === "merged" ? c.green : e.event.includes("refused") || e.event === "blocked" ? c.yellow : c.dim;
				console.log(`${c.dim(e.at.slice(0, 19))} ${color(e.event.padEnd(14))} ${e.session ?? e.loop ?? ""} ${e.reason ?? e.repo ?? ""}${e.pr ? `#${e.pr}` : ""} ${e.reasons ? e.reasons.join("; ") : e.note ?? e.tool ?? ""}`);
			}
			return;
		case "gates": {
			const result = await call("POST", "/gates", { repo: positional[0], number: Number(positional[1]) });
			console.log(result.ok ? c.green(`✓ all gates pass: ${result.summary}`) : c.yellow(`✗ would be held:\n  - ${result.reasons.join("\n  - ")}`));
			if (!result.allowlisted) console.log(c.dim(`(${positional[0]} is not in automerge.repos, so pr_merge would refuse it regardless)`));
			return;
		}
		case "retry":
			await call("POST", `/tasks/${positional[0]}/retry`);
			console.log("retrying");
			return;
		case "doctor":
			return doctor();
		default:
			console.log(HELP);
	}
}

main(process.argv.slice(2)).catch((error) => {
	console.error(c.red(error instanceof Error ? error.message : String(error)));
	process.exit(1);
});
