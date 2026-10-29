// pdd: the one process that owns the pi-durable store. Every session, loop, and memory lives here; clients talk to it
// over a Unix socket (HTTP + NDJSON event streams).
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
import { dryRunGates, Git_, Guard_, readOriginUrl, LoopTask, Loops_, Memory_, SessionContext, Sessions_, setHarness, Web_ } from "./extensions.ts";
import { audit, type Loop, Loops, Memories, Sessions } from "./state.ts";

const context = BACKGROUND_CONTEXT;
const run = promisify(execFile);
const AGENT_SHELL = fileURLToPath(new URL("../bin/agent-shell", import.meta.url));
const log = (...parts: unknown[]) => console.log(new Date().toISOString(), ...parts);

ensureDirs();
// Secrets reach the model providers through the daemon's own environment; agent shells get a scrubbed copy.
const shellEnv = scrubbedEnv();
for (const [name, value] of Object.entries(loadSecrets())) process.env[name] = value;
if (!process.env.ANTHROPIC_API_KEY) log("warning: ANTHROPIC_API_KEY is not set; sessions will fail until it is (pd doctor)");

const models = createModels({ identity: { attribution: { name: "pi-durable-local", url: "https://github.com/tonyjmartinez/pi-durable-local" } } });
models.setProvider(anthropicProvider());

const registry = createRegistry();
// Guard first, so its hook sees every call before anything else can act on it.
for (const extension of [Guard_, createCodingTools(), SessionContext, Memory_, Sessions_, Web_, Git_, Loops_]) {
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
		const usage = await harness.snapshot(UsageDoc, info.conversationId as never, context);
		let cost = 0;
		for (const bucket of [usage?.models ?? {}, usage?.tools ?? {}]) for (const u of Object.values(bucket)) cost += (u as { cost?: { total?: number } }).cost?.total ?? 0;
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
async function startProject(body: { repo?: string; name?: string; purpose?: string; goal?: string; intervalMinutes?: number; maxIterations?: number; budgetUsd?: number; baseBranch?: string }) {
	const repo = String(body.repo ?? "");
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new HttpError(400, "repo must be owner/name");
	const name = String(body.name ?? repo.split("/")[1]!.replace(/\.[a-z]+$/i, "")).toLowerCase();
	const root = loadPolicy().writableRoots[0]!.replace(/^~(?=\/|$)/, process.env.HOME!);
	const dir = resolve(root, repo.split("/")[1]!);
	if (!existsSync(dir)) {
		// Hooks off and no global config: nothing in the cloned repo runs with the daemon's credentials.
		await run("git", ["-c", "core.hooksPath=/dev/null", "clone", "--quiet", `git@github.com:${repo}.git`, dir], {
			env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
		});
		audit("cloned", { repo, dir });
	}
	if (body.baseBranch) {
		// Where PRs for this repo should land, for repos whose GitHub default isn't the deploy branch.
		const policy = JSON.parse(readFileSync(POLICY_FILE, "utf8"));
		policy.automerge = { ...policy.automerge, baseBranches: { ...policy.automerge?.baseBranches, [repo]: body.baseBranch } };
		writeFileSync(POLICY_FILE, `${JSON.stringify(policy, null, "\t")}\n`);
	}
	const existing = (await harness.snapshot(Sessions, context))?.byName[name];
	const session = existing === undefined ? await createSession({ name, cwd: dir, purpose: body.purpose ?? `${repo}` }) : { name, cwd: existing.cwd };
	const loop = body.goal ? await startLoop({ session: name, goal: body.goal, intervalMinutes: body.intervalMinutes, maxIterations: body.maxIterations, budgetUsd: body.budgetUsd }) : undefined;
	return { session, loop };
}

async function startLoop(body: { session?: string; goal?: string; intervalMinutes?: number; maxIterations?: number; budgetUsd?: number }) {
	const policy = loadPolicy();
	const { conversation } = await sessionByName(String(body.session ?? ""));
	if (!body.goal) throw new HttpError(400, "goal is required");
	const usage = await harness.snapshot(UsageDoc, conversation.id, context);
	let costAtStart = 0;
	for (const bucket of [usage?.models ?? {}, usage?.tools ?? {}]) for (const u of Object.values(bucket)) costAtStart += (u as { cost?: { total?: number } }).cost?.total ?? 0;
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
		const { conversation } = await sessionByName(loop.session);
		await conversation.commit(async (tx) => {
			const current = (await tx.doc(Loops)).byId[id]!;
			Object.assign(current, { status: "active", note: "resumed", nextRunAt: Date.now() });
			const usage = await tx.doc(UsageDoc, conversation.id);
			// A resumed loop gets a fresh budget window.
			let cost = 0;
			for (const bucket of [usage.models, usage.tools]) for (const u of Object.values(bucket)) cost += (u as { cost?: { total?: number } }).cost?.total ?? 0;
			current.costAtStart = cost;
			current.taskId = await tx.createTask(LoopTask, { loopId: id }, { ownership: { kind: "conversation" }, background: true });
		}, context);
	} else throw new HttpError(400, `unknown action ${action}`);
	audit(`loop_${action}`, { loop: id });
	return (await harness.snapshot(Loops, context))?.byId[id];
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP over the Unix socket.

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	if (chunks.length === 0) return {};
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
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
	["POST", /^\/loops\/([^/]+)\/(pause|resume|stop)$/, (m) => setLoopStatus(m[1]!, m[2]!)],
	["POST", /^\/gates$/, async (_m, body) => dryRunGates(String(body.repo), Number(body.number), models, context)],
	["POST", /^\/tasks\/([^/]+)\/retry$/, async (m) => {
		await harness.retryTask(m[1] as never, context);
		return { retried: m[1] };
	}],
	["GET", /^\/audit$/, async () =>
		existsSync(AUDIT_LOG) ? readFileSync(AUDIT_LOG, "utf8").trim().split("\n").slice(-200).map((line) => JSON.parse(line)) : []],
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
