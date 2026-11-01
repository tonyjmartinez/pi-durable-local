// pd-mcp: auth, the JSON-RPC surface, read-only tools, and redaction, against a fake daemon on a Unix socket.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createMcpServer, FLEET_URI, fleetSnapshot, needsOwner, TOOLS } from "../src/mcp.ts";

const TOKEN = "b".repeat(64);
const daemonCalls: string[] = [];
let dir: string;
let daemon: Server;
let mcp: Server;
let port: number;

const STATUS = {
	sessions: [{ name: "curb-cut", busy: true, cost: 4.16, model: "anthropic/claude-sonnet-5-5", purpose: "site", cwd: "/home/x/secret-path" }],
	loops: [
		{ id: "L1", session: "curb-cut", status: "active", iteration: 2, maxIterations: 10, spent: 1, budgetUsd: 5, nextRunAt: 1, goal: "ship it", note: "token=sk-ant-abcdefghijklmnop" },
		{ id: "L2", session: "curb-cut", status: "paused", note: "paused by user", goal: "g", iteration: 0, maxIterations: 1, budgetUsd: 1 },
		{ id: "L3", session: "curb-cut", status: "paused", note: "needs data", goal: "g", iteration: 0, maxIterations: 1, budgetUsd: 1, needsOwner: { ask: "Which dataset?" } },
		{ id: "L4", session: "curb-cut", status: "done", goal: "old", iteration: 1, maxIterations: 1, budgetUsd: 1 },
	],
	parked: [],
	budget: { capUsd: 10, daySpend: 1, exceeded: false, pace: { windowHours: 3, spent: 1, allowance: 1.25 }, running: 0, waiting: 2 },
};

function post(path: string, body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }, method = "POST"): Promise<{ status: number; json: any }> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, method, path, headers: { "content-type": "application/json", ...headers } }, (res) => {
			let data = "";
			res.setEncoding("utf8");
			res.on("data", (c: string) => (data += c));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : undefined }));
		});
		req.on("error", reject);
		req.end(body === undefined ? undefined : JSON.stringify(body));
	});
}
const rpc = (method: string, params?: unknown, id: number = 1) => post("/mcp", { jsonrpc: "2.0", id, method, params });

before(async () => {
	dir = mkdtempSync(join(tmpdir(), "pd-mcp-test-"));
	const socketPath = join(dir, "pdd.sock");
	const chatFile = join(dir, "chat.jsonl");
	writeFileSync(chatFile, `${JSON.stringify({ id: "1", at: "2026-11-01T10:00:00.000Z", from: "claude-x", to: "all", text: "hello ghp_abcdefghijklmnopqrstuvwxyz0123", delivered: false })}\n`);
	daemon = createServer((req, res) => {
		daemonCalls.push(`${req.method} ${req.url}`);
		res.writeHead(200, { "content-type": "application/json" });
		if (req.url === "/status") res.end(JSON.stringify(STATUS));
		else if (req.url === "/loops") res.end(JSON.stringify(STATUS.loops));
		else if (req.url === "/audit") res.end(JSON.stringify([{ at: "2026-11-01T09:00:00Z", event: "merged", repo: "o/r", pr: 3 }]));
		else if (req.url === "/memory" || req.url === "/directions") res.end(req.url === "/memory" ? "[]" : "{}");
		else res.end("{}");
	});
	await new Promise<void>((r) => daemon.listen(socketPath, r));
	mcp = createMcpServer({ socketPath, token: TOKEN, chatFile, html: "<p>view</p>", gh: async () => ({ status: 0, stdout: "[]" }) });
	await new Promise<void>((r) => mcp.listen(0, "127.0.0.1", r));
	port = (mcp.address() as { port: number }).port;
});

after(() => {
	mcp.close();
	daemon.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("pd-mcp auth", () => {
	it("refuses requests without the token", async () => {
		assert.equal((await post("/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, {})).status, 401);
		assert.equal((await post("/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: "Bearer nope" })).status, 401);
		assert.equal((await post(`/mcp/${"c".repeat(64)}`, { jsonrpc: "2.0", id: 1, method: "ping" }, {})).status, 401);
	});
	it("accepts a bearer header or the token as the last path segment", async () => {
		assert.equal((await rpc("ping")).status, 200);
		assert.equal((await post(`/mcp/${TOKEN}`, { jsonrpc: "2.0", id: 1, method: "ping" }, {})).status, 200);
	});
	it("only answers POST on /mcp", async () => {
		assert.equal((await post("/other", {})).status, 404);
		assert.equal((await post("/mcp", undefined, { authorization: `Bearer ${TOKEN}` }, "GET")).status, 405);
	});
});

describe("pd-mcp protocol", () => {
	it("negotiates a supported protocol version", async () => {
		const { json } = await rpc("initialize", { protocolVersion: "2025-06-18" });
		assert.equal(json.result.protocolVersion, "2025-06-18");
		assert.ok(json.result.capabilities.tools);
		const fallback = await rpc("initialize", { protocolVersion: "1999-01-01" });
		assert.equal(fallback.json.result.protocolVersion, "2025-11-25");
	});
	it("answers notifications with 202 and no body", async () => {
		const res = await post("/mcp", { jsonrpc: "2.0", method: "notifications/initialized" });
		assert.equal(res.status, 202);
	});
	it("handles batches and unknown methods", async () => {
		const res = await post("/mcp", [{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 2, method: "nope" }]);
		assert.equal(res.json.length, 2);
		assert.equal(res.json[1].error.code, -32601);
	});
	it("lists only read-only tools", async () => {
		const { json } = await rpc("tools/list");
		assert.deepEqual(json.result.tools.map((t: any) => t.name), TOOLS.map((t) => t.name));
		for (const tool of json.result.tools) assert.equal(tool.annotations.readOnlyHint, true, tool.name);
	});
	it("serves the fleet view as an MCP Apps resource", async () => {
		const list = await rpc("resources/list");
		assert.equal(list.json.result.resources[0].uri, FLEET_URI);
		const read = await rpc("resources/read", { uri: FLEET_URI });
		assert.equal(read.json.result.contents[0].mimeType, "text/html;profile=mcp-app");
		assert.equal(read.json.result.contents[0].text, "<p>view</p>");
		assert.deepEqual(read.json.result.contents[0]._meta.ui.csp, { connectDomains: [], resourceDomains: [] }, "the view loads nothing from outside");
		assert.equal((await rpc("resources/read", { uri: "ui://other" })).json.error.code, -32002);
	});
});

describe("pd-mcp tools", () => {
	it("fleet_status returns a bounded, redacted snapshot tied to the view", async () => {
		const { json } = await rpc("tools/call", { name: "fleet_status", arguments: {} });
		const snap = json.result.structuredContent;
		assert.equal(json.result._meta.ui.resourceUri, FLEET_URI);
		assert.deepEqual(snap.loops.map((l: any) => l.id), ["L1", "L2", "L3"]);
		assert.equal(snap.finishedLoops, 1);
		assert.equal(JSON.stringify(snap).includes("sk-ant-"), false);
		assert.equal(JSON.stringify(snap).includes("secret-path"), false, "cwd stays local");
		assert.match(json.result.content[0].text, /Needs the owner \(1\)/);
		assert.match(json.result.content[0].text, /L3 curb-cut paused asks: Which dataset\?/);
	});
	it("factory_brief reuses the pd brief text", async () => {
		const { json } = await rpc("tools/call", { name: "factory_brief", arguments: {} });
		assert.match(json.result.content[0].text, /NEEDS A GENERAL/);
		assert.match(json.result.content[0].text, /LAST 24H/);
	});
	it("recent_chat redacts secrets", async () => {
		const { json } = await rpc("tools/call", { name: "recent_chat", arguments: { limit: 5 } });
		assert.match(json.result.content[0].text, /claude-x -> all: hello \[redacted\]/);
	});
	it("loop_detail validates the id and reports unknown loops", async () => {
		assert.equal((await rpc("tools/call", { name: "loop_detail", arguments: { id: "../x" } })).json.error.code, -32602);
		assert.equal((await rpc("tools/call", { name: "loop_detail", arguments: { id: "L99" } })).json.result.isError, true);
		const ok = await rpc("tools/call", { name: "loop_detail", arguments: { id: "L3" } });
		assert.equal(ok.json.result.structuredContent.needsOwner.ask, "Which dataset?");
	});
	it("never calls a daemon write route", () => {
		assert.ok(daemonCalls.length > 0);
		for (const call of daemonCalls) assert.match(call, /^GET /);
	});
});

describe("needsOwner", () => {
	it("skips loops the owner paused himself, like pd brief", () => {
		const snap = fleetSnapshot(STATUS, 0);
		assert.deepEqual(snap.loops.filter(needsOwner).map((l: any) => l.id), ["L3"]);
	});
});
