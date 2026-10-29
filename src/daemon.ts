// pdd: the one process that owns the pi-durable store. Every session, loop, and memory lives here; clients talk to it
// over a Unix socket (HTTP + NDJSON event streams).
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import {
	type Conversation,
	createRegistry,
	Harness,
	type HarnessSettings,
	UsageDoc,
	watchEvents,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { AUDIT_LOG, DB_PATH, ensureDirs, loadPolicy, loadSecrets, POLICY_FILE, SOCKET_PATH, scrubbedEnv, splitModel } from "./config.ts";
import { dryRunGates, sweepAuditFriction, Git_, Guard_, readOriginUrl, LoopTask, Loops_, Memory_, SessionContext, sessionCost, Sessions_, setHarness, Subagent_, Web_ } from "./extensions.ts";
import { type CleanupName, CLEANUP_PROMPTS, CLEANUP_SCHEDULE } from "./loopgate.ts";
import { Approvals, audit, type Loop, Loops, Memories, Sessions } from "./state.ts";

const context = BACKGROUND_CONTEXT;
const run = promisify(execFile);
const AGENT_SHELL = fileURLToPath(new URL("../bin/agent-shell", import.meta.url));
const log = (...parts: unknown[]) => console.log(new Date().toISOString(), ...parts);

ensureDirs();

// One process owns the store. If a daemon already answers on the socket, leave before touching SQLite.
await new Promise<void>((done) => {
	const probe = connect(SOCKET_PATH);
	probe.once("connect", () => {
		console.error(`pdd is already running on ${SOCKET_PATH}; refusing to open the store twice`);
		process.exit(1);
	});
	probe.once("error", () => done());
});
// Secrets reach the model providers through the daemon's own environment; agent shells get a scrubbed copy.
const shellEnv = scrubbedEnv();
for (const [name, value] of Object.entries(loadSecrets())) process.env[name] = value;
if (!process.env.ANTHROPIC_API_KEY) log("warning: ANTHROPIC_API_KEY is not set; sessions will fail until it is (pd doctor)");

const models = createModels({ identity: { attribution: { name: "pi-durable-local", url: "https://github.com/tonyjmartinez/pi-durable-local" } } });
models.setProvider(anthropicProvider());

const registry = createRegistry();
// Guard first, so its hook sees every call before anything else can act on it.
for (const extension of [Guard_, createCodingTools(), SessionContext, Memory_, Sessions_, Web_, Git_, Loops_, Subagent_]) {
	registry.install(extension);
}

const settings: HarnessSettings = {
	retry: { maxRetries: 4 },
	stream: { timeoutMs: 300_000 },
	toolExecution: "parallel",
	afterFailedRun: "continue",
	compaction: { enabled: true, reserveTokens: 32_768, keepRecentTokens: 40_000 },
};

const storage = await openNodeSqliteStorage(DB_PATH);
const harness = await Harness.open(
	storage,
	{
		models,
		registry,
		settings,
		// Every agent command runs through bin/agent-shell: bash in a bubblewrap sandbox without credentials.
		env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.env.HOME!, shellEnv, shellPath: AGENT_SHELL }),
		onReport: (error, info) => {
			const task = "task" in info ? info.task?.kind : undefined;
			log("report", info.type, task ?? "", String(error).slice(0, 300));
			audit("report", { type: info.type, task, error: String(error).slice(0, 500) });
		},
	},
	context,
);
setHarness(harness);
// Sessions created before remotes were recorded get theirs once, from a plain read of the config file.
await harness.commit(async (tx) => {
	for (const info of Object.values((await tx.doc(Sessions)).byName)) {
		if (info.remote === undefined) {
			const remote = readOriginUrl(info.cwd);
			if (remote !== undefined) info.remote = remote;
		}
	}
}, context);
harness.resume();
harness.closed.then((end) => {
	log("harness closed", end.reason, end.reason === "failed" ? String(end.error) : "");
	// systemd restarts us; reopening recovers every committed step.
	process.exit(end.reason === "failed" ? 1 : 0);
});

// ---------------------------------------------------------------------------------------------------------------
// Operations shared by the HTTP routes.

class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

async function sessionByName(name: string): Promise<{ conversation: Conversation; cwd: string }> {
	const sessions = await harness.snapshot(Sessions, context);
	const info = sessions?.byName[name];
	if (info === undefined) throw new HttpError(404, `no session named ${name}`);
	const conversation = await harness.conversation(info.conversationId as never, context);
	if (conversation === undefined) throw new HttpError(500, `session ${name} lost its conversation`);
	return { conversation, cwd: info.cwd };
}

async function createSession(body: { name?: string; cwd?: string; purpose?: string; model?: string }) {
	const name = String(body.name ?? "").trim();
	if (!/^[a-z0-9][a-z0-9._-]{0,40}$/i.test(name)) throw new HttpError(400, "name: letters, digits, . _ - (max 41)");
	const cwd = resolve(body.cwd ?? process.env.HOME!);
	if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new HttpError(400, `${cwd} is not a directory`);
	const existing = await harness.snapshot(Sessions, context);
	if (existing?.byName[name] !== undefined) throw new HttpError(409, `session ${name} exists`);
	const policy = loadPolicy();
	// Recorded now, from a plain read of the config file, so later pushes never trust the agent-editable .git/config.
	const remote = readOriginUrl(cwd);
	const conversation = await harness.createConversation(
		{ ownership: { kind: "ownerless" }, agent: { model: splitModel(body.model ?? policy.model), thinkingLevel: policy.thinkingLevel, cwd } },
		context,
	);
	await harness.commit(async (tx) => {
		(await tx.doc(Sessions)).byName[name] = {
			conversationId: conversation.id,
			cwd,
			purpose: body.purpose ?? "",
			createdAt: Date.now(),
			...(remote === undefined ? {} : { remote }),
		};
	}, context);
	log("session created", name, cwd);
	return { name, cwd, conversationId: conversation.id };
}

async function status() {
	const sessions = (await harness.snapshot(Sessions, context))?.byName ?? {};
	const inspection = await harness.inspect(context);
	const busy = new Set<number>(inspection.tasks.filter((task) => !task.record.background).map((task) => task.record.conversationId));
	const parked = inspection.tasks.flatMap((task) =>
		task.state.kind === "blocked" ? [{ id: task.record.id, kind: task.record.kind, blocked: task.state.reason }] : [],
	);
	const rows = [];
	for (const [name, info] of Object.entries(sessions)) {
		const cost = await sessionCost(harness, name, info.conversationId, context);
		const conversation = await harness.conversation(info.conversationId as never, context);
		const agent = conversation === undefined ? undefined : await conversation.agent(context);
		rows.push({ name, cwd: info.cwd, purpose: info.purpose, busy: busy.has(info.conversationId), cost, model: agent?.model === undefined ? undefined : `${agent.model.provider}/${agent.model.modelId}` });
	}
	const loops = Object.values((await harness.snapshot(Loops, context))?.byId ?? {});
	return { sessions: rows, loops, parked, usage: await harness.usage(context), keys: { anthropic: Boolean(process.env.ANTHROPIC_API_KEY) } };
}

/**
 * The factory's front door: clone a GitHub repo with the daemon's credentials (agents have none), register a session
 * for it, and optionally start a loop on a goal.
 */
async function startProject(body: { repo?: string; name?: string; purpose?: string; goal?: string; intervalMinutes?: number; maxIterations?: number; budgetUsd?: number; baseBranch?: string; merge?: boolean }) {
	const repo = String(body.repo ?? "");
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.split("/").some((part) => part === "." || part === "..")) throw new HttpError(400, "repo must be owner/name");
	const name = String(body.name ?? repo.split("/")[1]!.replace(/\.[a-z]+$/i, "")).toLowerCase();
	if (!/^[a-z0-9][a-z0-9._-]{0,40}$/.test(name) || name.includes("..")) throw new HttpError(400, "invalid session name");
	const root = loadPolicy().writableRoots[0]!.replace(/^~(?=\/|$)/, process.env.HOME!);
	const dir = resolve(root, repo.split("/")[1]!);
	if (!existsSync(dir)) {
		// Hooks off and no global config: nothing in the cloned repo runs with the daemon's credentials.
		await run("git", ["-c", "core.hooksPath=/dev/null", "clone", "--quiet", `git@github.com:${repo}.git`, dir], {
			env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
		});
		audit("cloned", { repo, dir });
	}
	if (body.baseBranch || body.merge) {
		const policy = JSON.parse(readFileSync(POLICY_FILE, "utf8"));
		policy.automerge ??= {};
		// Where PRs for this repo should land, for repos whose GitHub default isn't the deploy branch.
		if (body.baseBranch) policy.automerge.baseBranches = { ...policy.automerge.baseBranches, [repo]: body.baseBranch };
		// The human running `pd factory --merge` is the approval; it is audited like any other.
		if (body.merge) {
			policy.automerge.repos = [...new Set([...(policy.automerge.repos ?? []), repo])];
			audit("automerge_enabled", { repo, by: "pd factory --merge" });
		}
		writeFileSync(POLICY_FILE, `${JSON.stringify(policy, null, "\t")}\n`);
	}
	const existing = (await harness.snapshot(Sessions, context))?.byName[name];
	const session = existing === undefined ? await createSession({ name, cwd: dir, purpose: body.purpose ?? `${repo}` }) : { name, cwd: existing.cwd };
	const loop = body.goal ? await startLoop({ session: name, goal: body.goal, intervalMinutes: body.intervalMinutes, maxIterations: body.maxIterations, budgetUsd: body.budgetUsd }) : undefined;
	return { session, loop };
}

async function startLoop(body: { session?: string; goal?: string; preset?: string; intervalMinutes?: number; maxIterations?: number; budgetUsd?: number }) {
	const policy = loadPolicy();
	const { conversation } = await sessionByName(String(body.session ?? ""));
	// A preset is one of the cleanup automations: its own brief, schedule, and idle gate.
	const preset = body.preset === undefined ? undefined : (body.preset as CleanupName);
	if (preset !== undefined && !(preset in CLEANUP_PROMPTS)) throw new HttpError(400, `unknown preset; one of ${Object.keys(CLEANUP_PROMPTS).join(", ")}`);
	if (preset !== undefined) {
		body.goal = CLEANUP_PROMPTS[preset];
		body.intervalMinutes ??= CLEANUP_SCHEDULE[preset].intervalMinutes;
	}
	if (!body.goal) throw new HttpError(400, "goal is required");
	// The budget window starts at the session's spend including its subagents, the same measure the loop checks.
	const costAtStart = await sessionCost(harness, String(body.session), conversation.id, context);
	const clamp = (value: number | undefined, min: number, max: number) => (value === undefined || !Number.isFinite(value) ? undefined : Math.min(Math.max(value, min), max));
	body.intervalMinutes = clamp(body.intervalMinutes, 5, 60 * 24 * 30);
	body.maxIterations = clamp(body.maxIterations, 1, 1000);
	body.budgetUsd = clamp(body.budgetUsd, 0.01, 1000);
	return conversation.commit(async (tx) => {
		const loops = await tx.doc(Loops);
		const id = `L${loops.nextId++}`;
		const loop: Loop = {
			id,
			session: body.session!,
			goal: body.goal!,
			intervalMinutes: body.intervalMinutes ?? policy.loops.defaultIntervalMinutes,
			maxIterations: body.maxIterations ?? policy.loops.defaultMaxIterations,
			budgetUsd: body.budgetUsd ?? policy.loops.defaultBudgetUsd,
			iteration: 0,
			status: "active",
			note: "",
			createdAt: Date.now(),
			nextRunAt: Date.now(),
			costAtStart,
			...(preset === undefined ? {} : { kind: CLEANUP_SCHEDULE[preset].kind, ...(CLEANUP_SCHEDULE[preset].skipIfIdleHours ? { skipIfIdleHours: CLEANUP_SCHEDULE[preset].skipIfIdleHours } : {}) }),
		};
		// Background: the loop must not keep the session "busy" or die when someone presses Esc on a run.
		loop.taskId = await tx.createTask(LoopTask, { loopId: id }, { ownership: { kind: "conversation" }, background: true });
		loops.byId[id] = loop;
		audit("loop_started", { loop: id, session: loop.session, goal: loop.goal, budgetUsd: loop.budgetUsd });
		return loop;
	}, context);
}

async function setLoopStatus(id: string, action: string) {
	const loop = (await harness.snapshot(Loops, context))?.byId[id];
	if (loop === undefined) throw new HttpError(404, `no loop ${id}`);
	if (action === "pause" || action === "stop") {
		await harness.commit(async (tx) => {
			const current = (await tx.doc(Loops)).byId[id]!;
			current.status = action === "stop" ? "done" : "paused";
			current.note = action === "stop" ? "stopped by user" : "paused by user";
		}, context);
		if (loop.taskId !== undefined) {
			const task = await harness.getTask(loop.taskId as never, context);
			if (task !== undefined && task.state.status !== "terminal") await harness.abortTask(loop.taskId as never, context);
		}
	} else if (action === "resume") {
		if (loop.status === "active") throw new HttpError(409, `loop ${id} is already active`);
		const { conversation } = await sessionByName(loop.session);
		// A loop paused by its own report may still have a live task waiting to notice; end it so only one runs.
		if (loop.taskId !== undefined) {
			const task = await harness.getTask(loop.taskId as never, context);
			if (task !== undefined && task.state.status !== "terminal") {
				await harness.abortTask(loop.taskId as never, context);
				await harness.waitForTask(loop.taskId as never, context);
			}
		}
		// A resumed loop gets a fresh budget window, measured the same way the loop measures spend.
		const cost = await sessionCost(harness, loop.session, conversation.id, context);
		await conversation.commit(async (tx) => {
			const current = (await tx.doc(Loops)).byId[id]!;
			Object.assign(current, { status: "active", note: "resumed", nextRunAt: Date.now() });
			current.costAtStart = cost;
			current.taskId = await tx.createTask(LoopTask, { loopId: id }, { ownership: { kind: "conversation" }, background: true });
		}, context);
	} else throw new HttpError(400, `unknown action ${action}`);
	audit(`loop_${action}`, { loop: id });
	return (await harness.snapshot(Loops, context))?.byId[id];
}

/** The last `count` audit entries, reading only the end of the file and skipping torn lines. */
function auditTail(count: number): unknown[] {
	const size = statSync(AUDIT_LOG).size;
	const start = Math.max(0, size - 512 * 1024);
	const text = readFileSync(AUDIT_LOG).subarray(start).toString("utf8");
	return text.split("\n").slice(start > 0 ? 1 : 0).filter(Boolean).slice(-count).flatMap((line) => {
		try {
			return [JSON.parse(line)];
		} catch {
			return [];
		}
	});
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP over the Unix socket.

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	if (chunks.length === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
	} catch {
		throw new HttpError(400, "body must be JSON");
	}
}

function send(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
}

async function streamEvents(name: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
	const { conversation } = await sessionByName(name);
	const stream = await watchEvents(harness, conversation.id, context);
	response.writeHead(200, { "content-type": "application/x-ndjson" });
	response.write(`${JSON.stringify(stream.snapshot)}\n`);
	stream.start(async (events) => {
		for (const event of events) response.write(`${JSON.stringify(event)}\n`);
	});
	const stop = () => void stream.stop();
	request.on("close", stop);
	void stream.closed.then(() => response.end());
}

type Route = (match: RegExpExecArray, body: Record<string, unknown>, request: IncomingMessage, response: ServerResponse) => Promise<unknown>;
const routes: [string, RegExp, Route][] = [
	["GET", /^\/status$/, () => status()],
	["POST", /^\/sessions$/, (_m, body) => createSession(body)],
	["POST", /^\/projects$/, (_m, body) => startProject(body)],
	["DELETE", /^\/sessions\/([^/]+)$/, async (m) => {
		const { conversation } = await sessionByName(m[1]!);
		await conversation.abort(context, { background: true });
		await harness.commit(async (tx) => {
			delete (await tx.doc(Sessions)).byName[m[1]!];
		}, context);
		log("session removed", m[1]);
		return { removed: m[1] };
	}],
	["POST", /^\/sessions\/([^/]+)\/send$/, async (m, body) => {
		const { conversation } = await sessionByName(m[1]!);
		const mode = body.mode === "steer" ? "steer" : "followUp";
		const submission = await conversation.submit({ type: "input", content: String(body.text ?? ""), whenBusy: mode }, context);
		return { submission: submission.id };
	}],
	["POST", /^\/sessions\/([^/]+)\/abort$/, async (m) => {
		await (await sessionByName(m[1]!)).conversation.abort(context);
		return { aborted: true };
	}],
	["POST", /^\/sessions\/([^/]+)\/reset$/, async (m, body) => {
		await (await sessionByName(m[1]!)).conversation.reset(typeof body.handoff === "string" ? body.handoff : undefined, context);
		return { reset: true };
	}],
	["POST", /^\/sessions\/([^/]+)\/compact$/, async (m, body) => {
		return { task: await (await sessionByName(m[1]!)).conversation.compact(typeof body.instructions === "string" ? body.instructions : undefined, context) };
	}],
	["POST", /^\/sessions\/([^/]+)\/model$/, async (m, body) => {
		await (await sessionByName(m[1]!)).conversation.configure({ model: splitModel(String(body.model)) }, context);
		return { model: body.model };
	}],
	["GET", /^\/sessions\/([^/]+)\/events$/, async (m, _b, request, response) => {
		await streamEvents(m[1]!, request, response);
		return undefined;
	}],
	["GET", /^\/memory$/, async () => Object.values((await harness.snapshot(Memories, context))?.items ?? {})],
	["POST", /^\/memory$/, async (_m, body) =>
		harness.commit(async (tx) => {
			const memories = await tx.doc(Memories);
			const id = String(memories.nextId++);
			memories.items[id] = {
				id,
				topic: String(body.topic ?? "note"),
				text: String(body.text ?? ""),
				tags: [],
				by: "tony",
				updatedAt: Date.now(),
				...(typeof body.project === "string" ? { project: resolve(body.project) } : {}),
			};
			// Drafts expire with the commit; hand back a plain copy.
			return JSON.parse(JSON.stringify(memories.items[id]));
		}, context)],
	["DELETE", /^\/memory\/([^/]+)$/, async (m) =>
		harness.commit(async (tx) => {
			const memories = await tx.doc(Memories);
			const existed = memories.items[m[1]!] !== undefined;
			delete memories.items[m[1]!];
			return { removed: existed };
		}, context)],
	["GET", /^\/loops$/, async () => Object.values((await harness.snapshot(Loops, context))?.byId ?? {})],
	["POST", /^\/loops$/, (_m, body) => startLoop(body)],
	["POST", /^\/loops\/([^/]+)\/set$/, async (m, body) => {
		const id = m[1]!;
		const updated = await harness.commit(async (tx) => {
			const loop = (await tx.doc(Loops)).byId[id];
			if (loop === undefined) return undefined;
			if (typeof body.intervalMinutes === "number" && body.intervalMinutes >= 5) {
				loop.intervalMinutes = body.intervalMinutes;
				// Takes effect after the iteration already scheduled.
			}
			if (typeof body.maxIterations === "number" && body.maxIterations >= 1) loop.maxIterations = body.maxIterations;
			if (typeof body.budgetUsd === "number" && body.budgetUsd > 0) loop.budgetUsd = body.budgetUsd;
			return JSON.parse(JSON.stringify(loop)) as Loop;
		}, context);
		if (updated === undefined) throw new HttpError(404, `no loop ${id}`);
		audit("loop_set", { loop: id, intervalMinutes: updated.intervalMinutes, maxIterations: updated.maxIterations, budgetUsd: updated.budgetUsd });
		return updated;
	}],
	["POST", /^\/loops\/([^/]+)\/(pause|resume|stop)$/, (m) => setLoopStatus(m[1]!, m[2]!)],
	["POST", /^\/approve$/, async (_m, body) => {
		const repo = String(body.repo);
		const number = Number(body.number);
		const expected = String(body.sha ?? "").toLowerCase();
		if (!/^[0-9a-f]{7,40}$/.test(expected)) throw new HttpError(400, "pass the commit you reviewed: pd approve <repo> <pr> <sha7> (shown in the park comment)");
		const sha = (await run("gh", ["pr", "view", String(number), "--repo", repo, "--json", "headRefOid", "--jq", ".headRefOid"])).stdout.trim();
		// The approval binds the commit Tony saw; if the agent pushed since, he must look again.
		if (!sha.startsWith(expected)) throw new HttpError(409, `PR head is now ${sha.slice(0, 7)}, not ${expected}; review the new commit first`);
		await harness.commit(async (tx) => {
			(await tx.doc(Approvals)).byPr[`${repo}#${number}`] = { sha, at: Date.now() };
		}, context);
		audit("human_approved", { repo, pr: number, sha });
		return { repo, number, sha };
	}],
	["POST", /^\/gates$/, async (_m, body) => dryRunGates(String(body.repo), Number(body.number), models, context)],
	["POST", /^\/tasks\/([^/]+)\/retry$/, async (m) => {
		await harness.retryTask(m[1] as never, context);
		return { retried: m[1] };
	}],
	["GET", /^\/audit$/, async () =>
		existsSync(AUDIT_LOG) ? auditTail(200) : []],
];

const server = createServer(async (request, response) => {
	const path = new URL(request.url ?? "/", "http://pdd").pathname;
	try {
		for (const [method, pattern, handler] of routes) {
			const match = pattern.exec(path);
			if (match === null || method !== request.method) continue;
			const result = await handler(match, request.method === "GET" ? {} : await readBody(request), request, response);
			if (result !== undefined) send(response, 200, result);
			return;
		}
		send(response, 404, { error: `no route ${request.method} ${path}` });
	} catch (error) {
		const status = error instanceof HttpError ? error.status : 500;
		if (!response.headersSent) send(response, status, { error: error instanceof Error ? error.message : String(error) });
		else response.end();
		if (status === 500) log("request failed", request.method, path, error);
	}
});

if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
server.listen(SOCKET_PATH, async () => {
	await chmod(SOCKET_PATH, 0o600);
	log(`pdd listening on ${SOCKET_PATH}, store ${DB_PATH}`);
});

// Every 6 hours, turn repeated guard blocks into friction issues on this repo (deduplicated by rule).
const frictionTimer = setInterval(() => {
	void sweepAuditFriction(context).then((filed) => filed > 0 && log(`friction sweep filed ${filed} issue(s)`)).catch((error) => log("friction sweep failed", String(error)));
}, 6 * 60 * 60 * 1000);
frictionTimer.unref();

let closing = false;
async function shutdown(signal: string) {
	if (closing) return;
	closing = true;
	log(`${signal}: closing`);
	server.close();
	await harness.close(context);
	process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
