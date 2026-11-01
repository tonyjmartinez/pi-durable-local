// pd-mcp: a read-only MCP server so ChatGPT and Claude apps can show the factory (phase 1 of docs/chat-console.md).
// It speaks MCP over stateless Streamable HTTP (JSON responses, no SSE, no sessions), listens on 127.0.0.1 only, and
// reads the daemon through its Unix socket like `pd` does; it never opens the store and has no write tools yet.
// Every request must carry the token: `Authorization: Bearer <token>`, or as the last path segment (`/mcp/<token>`)
// for hosts that only take a URL. Exposing it beyond localhost (a tunnel) is a separate, owner-approved step.
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectBrief, runGh } from "./briefdata.ts";
import type { DaemonCall, GhRun } from "./briefdata.ts";
import { CHAT_LOG, readChat } from "./chat.ts";
import { DATA_DIR, SOCKET_PATH } from "./config.ts";
import { redact } from "./redact.ts";
import { loadOrCreateToken } from "./web.ts";

type Json = any;

export const MCP_TOKEN_FILE = join(DATA_DIR, "mcp-token");
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
export const FLEET_URI = "ui://pd/fleet.html";
const UI_MIME = "text/html;profile=mcp-app";
const MAX_BODY = 256 * 1024;
const VERSION = "0.1.0";

export type McpOptions = {
	socketPath: string;
	token: string;
	chatFile?: string;
	/** The fleet view template; read from src/web/fleet.html by default. */
	html?: string;
	gh?: GhRun;
	now?: () => number;
};

class RpcError extends Error {
	code: number;
	constructor(code: number, message: string) {
		super(message);
		this.code = code;
	}
}

function daemonCaller(socketPath: string): DaemonCall {
	return (method, path, body) =>
		new Promise((done, fail) => {
			const req = httpRequest({ socketPath, method, path, headers: { "content-type": "application/json" }, timeout: 20_000 }, (res) => {
				let data = "";
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => (data += chunk));
				res.on("end", () => {
					try {
						const parsed = data ? JSON.parse(data) : {};
						if ((res.statusCode ?? 500) >= 400) fail(new Error(parsed.error ?? `daemon HTTP ${res.statusCode}`));
						else done(parsed);
					} catch {
						fail(new Error("daemon sent a non-JSON reply"));
					}
				});
			});
			req.on("timeout", () => req.destroy(new Error("daemon did not answer in 20s")));
			req.on("error", (error: NodeJS.ErrnoException) => fail(error.code === "ENOENT" || error.code === "ECONNREFUSED" ? new Error("pdd is not running (start it with pdd-up)") : error));
			if (body !== undefined) req.write(JSON.stringify(body));
			req.end();
		});
}

const clip = (text: unknown, length: number) => {
	const s = typeof text === "string" ? text : "";
	return s.length <= length ? s : `${s.slice(0, length - 1)}…`;
};
const intArg = (value: unknown, fallback: number, max: number) => Math.min(Math.max(Math.trunc(Number(value ?? fallback)) || fallback, 1), max);

/** The structured fleet snapshot the view renders: bounded, redacted, and safe to show in a chat app. */
export function fleetSnapshot(status: Json, at: number): Json {
	const loops = (status.loops ?? []) as Json[];
	return {
		at,
		sessions: (status.sessions ?? []).map((s: Json) => ({ name: s.name, busy: Boolean(s.busy), cost: Number(s.cost ?? 0), model: s.model, purpose: redact(clip(s.purpose, 160)) })),
		loops: loops
			.filter((l) => l.status !== "done" && l.status !== "stopped")
			.map((l) => ({
				id: l.id,
				session: l.session,
				status: l.status === "active" && l.dormant ? "dormant" : l.status,
				iteration: l.iteration,
				maxIterations: l.maxIterations,
				spent: Number(l.spent ?? 0),
				budgetUsd: Number(l.budgetUsd ?? 0),
				nextRunAt: l.status === "active" ? l.nextRunAt : undefined,
				lastRunAt: l.lastRunAt,
				userPaused: l.status === "paused" && /paused by user|stopped by user/.test(l.note ?? ""),
				goal: redact(clip(l.goal, 240)),
				note: redact(clip(l.note, 300)),
				needsOwner: l.needsOwner ? { ask: redact(clip(l.needsOwner.ask, 300)), recommendation: redact(clip(l.needsOwner.recommendation, 200)) } : undefined,
			})),
		finishedLoops: loops.filter((l) => l.status === "done" || l.status === "stopped").length,
		parkedTasks: (status.parked ?? []).length,
		budget: status.budget
			? { capUsd: status.budget.capUsd, daySpend: status.budget.daySpend, exceeded: Boolean(status.budget.exceeded), pace: status.budget.pace, running: status.budget.running, waiting: status.budget.waiting }
			: undefined,
	};
}

/** Like `pd brief`: a loop the owner paused himself is not a decision. */
export const needsOwner = (l: Json): boolean => Boolean(l.needsOwner) || l.status === "failed" || (l.status === "paused" && !l.userPaused);

function fleetText(snap: Json): string {
	const busy = snap.sessions.filter((s: Json) => s.busy).length;
	const asks = snap.loops.filter(needsOwner);
	const b = snap.budget;
	const lines = [
		`Fleet at ${new Date(snap.at).toISOString()}: ${busy}/${snap.sessions.length} sessions busy, ${snap.loops.length} open loops (${snap.loops.filter((l: Json) => l.status === "active").length} scheduled).`,
		b ? `Budget: $${Number(b.daySpend).toFixed(2)} of $${b.capUsd} in 24h${b.pace ? `; last ${b.pace.windowHours}h $${Number(b.pace.spent).toFixed(2)} of $${Number(b.pace.allowance).toFixed(2)} pace` : ""}; ${b.running} running, ${b.waiting} waiting.` : "",
		snap.loops.some((l: Json) => l.userPaused) ? `${snap.loops.filter((l: Json) => l.userPaused).length} loops paused by the owner.` : "",
		asks.length ? `Needs the owner (${asks.length}):` : "Nothing needs the owner.",
		...asks.map((l: Json) => `- ${l.id} ${l.session} ${l.status}${l.needsOwner ? ` asks: ${l.needsOwner.ask}` : l.note ? `: ${l.note}` : ""}`),
	];
	return lines.filter(Boolean).join("\n");
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
// The shared MCP Apps contract; the openai/* keys are ChatGPT's older aliases, kept for older clients.
const uiMeta = { ui: { resourceUri: FLEET_URI, visibility: ["model", "app"] }, "openai/outputTemplate": FLEET_URI, "openai/widgetAccessible": true };

export const TOOLS = [
	{
		name: "fleet_status",
		title: "Factory fleet status",
		description: "Live snapshot of the pi-durable software factory: sessions, open loops, budget and pacing, and loops that need the owner. Renders the fleet dashboard.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		annotations: READ_ONLY,
		_meta: uiMeta,
	},
	{
		name: "factory_brief",
		title: "Factory brief",
		description: "The `pd brief` text: what needs a general (parked PRs, blocked loops, owner asks, needs-decision issues, proposals), the last 24h, budget, then the workforce.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		annotations: { ...READ_ONLY, openWorldHint: true },
	},
	{
		name: "recent_chat",
		title: "Agent chat",
		description: "Recent messages on the shared agent channel (pd-chat) between pi sessions and the Claude Code/Codex generals.",
		inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 100, default: 25 } }, additionalProperties: false },
		annotations: READ_ONLY,
	},
	{
		name: "loop_detail",
		title: "Loop detail",
		description: "Full record of one factory loop (goal, note, spend, schedule, owner ask) by id, e.g. L52.",
		inputSchema: { type: "object", properties: { id: { type: "string", pattern: "^L\\d{1,9}$" } }, required: ["id"], additionalProperties: false },
		annotations: READ_ONLY,
	},
	{
		name: "recent_audit",
		title: "Audit log",
		description: "Recent factory audit events (merges, parks, approvals, loop pauses/resumes, boosts), newest last.",
		inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 100, default: 30 } }, additionalProperties: false },
		annotations: READ_ONLY,
	},
];

const text = (s: string) => ({ content: [{ type: "text", text: s }] });

export function createMcpServer(options: McpOptions): Server {
	const call = daemonCaller(options.socketPath);
	const now = options.now ?? Date.now;
	const html = () => options.html ?? readFileSync(join(dirname(fileURLToPath(import.meta.url)), "web", "fleet.html"), "utf8");

	async function callTool(name: string, args: Json): Promise<Json> {
		if (name === "fleet_status") {
			const snap = fleetSnapshot(await call("GET", "/status"), now());
			return { ...text(fleetText(snap)), structuredContent: snap, _meta: uiMeta };
		}
		if (name === "factory_brief") return text(redact(await collectBrief(call, options.gh ?? runGh)));
		if (name === "recent_chat") {
			const rows = readChat(options.chatFile ?? CHAT_LOG, { limit: intArg(args.limit, 25, 100) });
			const messages = rows.map((m) => ({ at: m.at, from: m.from, to: m.to, text: redact(clip(m.text, 1200)) }));
			return { ...text(messages.map((m) => `${m.at.slice(11, 19)} ${m.from} -> ${m.to}: ${m.text}`).join("\n") || "no messages"), structuredContent: { messages } };
		}
		if (name === "loop_detail") {
			const id = String(args.id ?? "");
			if (!/^L\d{1,9}$/.test(id)) throw new RpcError(-32602, "id must look like L52");
			const loop = ((await call("GET", "/loops")) as Json[]).find((l) => l.id === id);
			if (!loop) return { ...text(`no loop ${id}`), isError: true };
			return { ...text(redact(JSON.stringify(loop, null, 2))), structuredContent: JSON.parse(redact(JSON.stringify(loop))) };
		}
		if (name === "recent_audit") {
			const rows = ((await call("GET", "/audit")) as Json[]).slice(-intArg(args.limit, 30, 100));
			return text(redact(rows.map((e) => [e.at, e.event, e.loop, e.session, e.repo && `${e.repo}#${e.pr ?? ""}`, e.reason ?? e.note].filter(Boolean).join(" ")).join("\n")) || "no audit events");
		}
		throw new RpcError(-32602, `unknown tool ${name}`);
	}

	async function handle(message: Json): Promise<Json | undefined> {
		const isRequest = message && typeof message === "object" && message.jsonrpc === "2.0" && typeof message.method === "string";
		if (!isRequest) return { jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32600, message: "invalid request" } };
		if (message.id === undefined) return undefined; // A notification: nothing to answer.
		const params = message.params ?? {};
		try {
			let result: Json;
			switch (message.method) {
				case "initialize":
					result = {
						protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
						capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
						serverInfo: { name: "pd-factory", title: "pi-durable factory", version: VERSION },
						instructions: "Read-only view of Tony's pi-durable software factory. Start with fleet_status (renders a dashboard) or factory_brief (what needs a decision). There are no control tools yet.",
					};
					break;
				case "ping":
					result = {};
					break;
				case "tools/list":
					result = { tools: TOOLS };
					break;
				case "tools/call":
					try {
						result = await callTool(String(params.name), params.arguments ?? {});
					} catch (error) {
						if (error instanceof RpcError) throw error;
						result = { ...text(`pd: ${(error as Error).message}`), isError: true };
					}
					break;
				case "resources/list":
					result = { resources: [{ uri: FLEET_URI, name: "fleet", title: "Factory fleet dashboard", mimeType: UI_MIME }] };
					break;
				case "resources/templates/list":
					result = { resourceTemplates: [] };
					break;
				case "resources/read":
					if (params.uri !== FLEET_URI) throw new RpcError(-32002, `unknown resource ${params.uri}`);
					result = { contents: [{ uri: FLEET_URI, mimeType: UI_MIME, text: html(), _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } }, "openai/widgetDescription": "Live dashboard of the factory's sessions, loops and budget." } }] };
					break;
				default:
					throw new RpcError(-32601, `method not found: ${message.method}`);
			}
			return { jsonrpc: "2.0", id: message.id, result };
		} catch (error) {
			return { jsonrpc: "2.0", id: message.id, error: { code: error instanceof RpcError ? error.code : -32603, message: (error as Error).message } };
		}
	}

	const tokenHash = createHash("sha256").update(options.token).digest();
	const authorized = (request: IncomingMessage, pathToken: string | undefined): boolean => {
		const header = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
		const presented = header ?? pathToken;
		return presented !== undefined && timingSafeEqual(createHash("sha256").update(presented).digest(), tokenHash);
	};

	return createServer(async (request: IncomingMessage, response: ServerResponse) => {
		const reply = (status: number, body: Json, headers: Record<string, string> = {}) => {
			response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
			response.end(body === undefined ? undefined : JSON.stringify(body));
		};
		const path = new URL(request.url ?? "/", "http://localhost").pathname;
		const match = /^\/mcp(?:\/([0-9a-f]{64}))?\/?$/.exec(path);
		if (!match) return reply(404, { error: "not found" });
		if (!authorized(request, match[1])) return reply(401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="pd-mcp"' });
		if (request.method !== "POST") return reply(405, { error: "this server is stateless: POST JSON-RPC only" }, { allow: "POST" });

		let size = 0;
		const chunks: Buffer[] = [];
		for await (const chunk of request) {
			size += (chunk as Buffer).length;
			if (size > MAX_BODY) return reply(413, { error: "body too large" });
			chunks.push(chunk as Buffer);
		}
		let body: Json;
		try {
			body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			return reply(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
		}
		if (Array.isArray(body)) {
			const out = (await Promise.all(body.map(handle))).filter((x) => x !== undefined);
			return out.length ? reply(200, out) : reply(202, undefined);
		}
		const out = await handle(body);
		return out === undefined ? reply(202, undefined) : reply(200, out);
	});
}

function main(): void {
	const port = Number(process.env.PD_MCP_PORT ?? 7787);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		console.error(`PD_MCP_PORT must be a port number (got ${process.env.PD_MCP_PORT})`);
		process.exit(2);
	}
	const token = loadOrCreateToken(MCP_TOKEN_FILE);
	const server = createMcpServer({ socketPath: SOCKET_PATH, token });
	server.on("error", (error: NodeJS.ErrnoException) => {
		console.error(error.code === "EADDRINUSE" ? `port ${port} is in use; set PD_MCP_PORT to another port` : String(error));
		process.exit(1);
	});
	server.listen(port, "127.0.0.1", () => {
		console.log(`pd-mcp (read-only) listening on http://127.0.0.1:${port}/mcp`);
		console.log(`token: ${MCP_TOKEN_FILE} (send as "Authorization: Bearer <token>" or append /<token> to the URL)`);
	});
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
