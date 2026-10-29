// pd-ui: auth, CSRF, host checks, the proxy allowlist, and streaming, against a fake daemon on a Unix socket.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, request } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createUiServer, loadOrCreateToken } from "../src/web.ts";

const TOKEN = "a".repeat(64);
const seen: { method: string; url: string; body: string; headers: IncomingHttpHeaders }[] = [];

let dir: string;
let daemon: Server;
let ui: Server;
let port: number;

type Reply = { status: number; headers: IncomingHttpHeaders; body: string };

function call(method: string, path: string, headers: Record<string, string> = {}, body?: string, host?: string): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, method, path, headers: { host: host ?? `127.0.0.1:${port}`, ...headers } }, (res) => {
			let data = "";
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => (data += chunk));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
		});
		req.on("error", reject);
		req.end(body);
	});
}

const authed = { "x-pd-token": TOKEN };

before(async () => {
	dir = mkdtempSync(join(tmpdir(), "pd-ui-test-"));
	const socketPath = join(dir, "pdd.sock");
	daemon = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk: Buffer) => (body += chunk));
		req.on("end", () => {
			seen.push({ method: req.method ?? "", url: req.url ?? "", body, headers: req.headers });
			if (req.url === "/status") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ sessions: [{ name: "demo" }] }));
			} else if (req.url?.endsWith("/events")) {
				res.writeHead(200, { "content-type": "application/x-ndjson" });
				res.write(`${JSON.stringify({ type: "snapshot", entries: [] })}\n`);
				res.end(`${JSON.stringify({ type: "run_end" })}\n`);
			} else {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: true, echo: body }));
			}
		});
	});
	await new Promise<void>((resolve) => daemon.listen(socketPath, resolve));
	ui = createUiServer({ socketPath, token: TOKEN, html: '<meta name="pd-token" content="__TOKEN__"><script nonce="__NONCE__"></script>' });
	await new Promise<void>((resolve) => ui.listen(0, "127.0.0.1", resolve));
	port = (ui.address() as { port: number }).port;
});

after(() => {
	ui.close();
	daemon.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("authentication", () => {
	it("returns 401 without a token", async () => {
		assert.equal((await call("GET", "/")).status, 401);
		assert.equal((await call("GET", "/api/status")).status, 401);
	});

	it("returns 401 for a wrong token in any position", async () => {
		const wrong = "b".repeat(64);
		assert.equal((await call("GET", `/?token=${wrong}`)).status, 401);
		assert.equal((await call("GET", "/api/status", { "x-pd-token": wrong })).status, 401);
		assert.equal((await call("GET", "/api/status", { cookie: `pd_ui=${wrong}` })).status, 401);
		assert.equal((await call("GET", "/api/status", { "x-pd-token": "" })).status, 401);
		assert.equal((await call("GET", "/api/status", { "x-pd-token": TOKEN.slice(0, 63) })).status, 401);
	});

	it("never reaches the daemon without a valid token", async () => {
		const before = seen.length;
		await call("GET", "/api/status");
		await call("POST", "/api/sessions", {}, "{}");
		assert.equal(seen.length, before);
	});

	it("trades ?token= for a cookie and redirects without the token in the URL", async () => {
		const res = await call("GET", `/?token=${TOKEN}`);
		assert.equal(res.status, 302);
		assert.equal(res.headers.location, "/");
		const cookie = String(res.headers["set-cookie"]);
		assert.match(cookie, /HttpOnly/);
		assert.match(cookie, /SameSite=Strict/);
		const follow = await call("GET", "/", { cookie: cookie.split(";")[0]! });
		assert.equal(follow.status, 200);
	});

	it("serves the page with a nonce CSP and the token only after authentication", async () => {
		const res = await call("GET", "/", authed);
		assert.equal(res.status, 200);
		const nonce = /nonce="([^"]+)"/.exec(res.body)?.[1];
		assert.ok(nonce);
		assert.match(String(res.headers["content-security-policy"]), new RegExp(`script-src 'nonce-${nonce.replace(/[+/=]/g, "\\$&")}'`));
		assert.match(String(res.headers["content-security-policy"]), /default-src 'none'/);
		assert.ok(res.body.includes(`content="${TOKEN}"`));
		assert.equal(res.headers["cache-control"], "no-store");
		assert.ok(!(await call("GET", "/")).body.includes(TOKEN));
	});
});

describe("CSRF and host checks", () => {
	it("rejects a POST that carries only the cookie", async () => {
		const res = await call("POST", "/api/sessions/demo/send", { cookie: `pd_ui=${TOKEN}`, "content-type": "application/json" }, '{"text":"hi"}');
		assert.equal(res.status, 401);
	});

	it("rejects a POST with the token query parameter but no header", async () => {
		assert.equal((await call("POST", `/api/sessions/demo/abort?token=${TOKEN}`, {}, "{}")).status, 401);
	});

	it("rejects a POST whose Origin is another site", async () => {
		const res = await call("POST", "/api/sessions/demo/abort", { ...authed, origin: "http://evil.example" }, "{}");
		assert.equal(res.status, 403);
	});

	it("accepts a POST from its own origin with the header", async () => {
		const res = await call("POST", "/api/sessions/demo/abort", { ...authed, origin: `http://127.0.0.1:${port}` }, "{}");
		assert.equal(res.status, 200);
	});

	it("rejects an unexpected Host header (DNS rebinding)", async () => {
		assert.equal((await call("GET", "/api/status", authed, undefined, "evil.example")).status, 403);
		assert.equal((await call("GET", "/api/status", authed, undefined, `evil.example:${port}`)).status, 403);
		assert.equal((await call("GET", "/api/status", authed, undefined, `localhost:${port}`)).status, 200);
	});
});

describe("proxy allowlist", () => {
	it("forwards the allowed routes", async () => {
		const res = await call("GET", "/api/status", authed);
		assert.equal(res.status, 200);
		assert.deepEqual(JSON.parse(res.body), { sessions: [{ name: "demo" }] });
		for (const path of ["/api/loops", "/api/memory", "/api/audit"]) assert.equal((await call("GET", path, authed)).status, 200, path);
		for (const path of ["/api/sessions", "/api/loops", "/api/loops/L3/pause", "/api/loops/L3/resume", "/api/loops/L3/stop", "/api/sessions/a.b-c_1/send"]) {
			assert.equal((await call("POST", path, authed, "{}")).status, 200, path);
		}
	});

	it("maps paths to the daemon and forwards JSON bodies", async () => {
		seen.length = 0;
		await call("POST", "/api/sessions/demo/send", authed, '{"text":"hello","mode":"steer"}');
		assert.equal(seen.length, 1);
		assert.equal(seen[0]!.method, "POST");
		assert.equal(seen[0]!.url, "/sessions/demo/send");
		assert.deepEqual(JSON.parse(seen[0]!.body), { text: "hello", mode: "steer" });
	});

	it("does not forward the token, cookie, or query string to the daemon", async () => {
		seen.length = 0;
		await call("GET", `/api/status?token=${TOKEN}&x=1`, { ...authed, cookie: `pd_ui=${TOKEN}` });
		assert.equal(seen[0]!.url, "/status");
		assert.equal(seen[0]!.headers["x-pd-token"], undefined);
		assert.equal(seen[0]!.headers.cookie, undefined);
	});

	it("returns 404 for routes that are not allowlisted", async () => {
		const cases: [string, string][] = [
			["DELETE", "/api/sessions/demo"],
			["POST", "/api/sessions/demo/reset"],
			["POST", "/api/sessions/demo/compact"],
			["POST", "/api/sessions/demo/model"],
			["POST", "/api/memory"],
			["DELETE", "/api/memory/1"],
			["POST", "/api/tasks/5/retry"],
			["GET", "/api/anything"],
			["GET", "/status"],
			["GET", "/api/status/extra"],
			["POST", "/api/status"],
			["GET", "/api/sessions"],
			["POST", "/api/loops/L3/delete"],
			["POST", "/api/loops/3/stop"],
			["GET", "/api/sessions/demo/send"],
			["PUT", "/api/loops"],
			["GET", "/other"],
		];
		for (const [method, path] of cases) {
			const res = await call(method, path, authed, method === "GET" ? undefined : "{}");
			assert.equal(res.status, 404, `${method} ${path}`);
		}
	});

	it("rejects session names that could escape the path", async () => {
		seen.length = 0;
		for (const name of ["..", "%2e%2e", "a%2fb", "a/b", "-x", ".hidden", "a%00b", "a%0d%0ab", "x".repeat(60)]) {
			const res = await call("POST", `/api/sessions/${name}/send`, authed, "{}");
			assert.equal(res.status, 404, name);
		}
		assert.equal(seen.length, 0);
	});

	it("rejects non-JSON POST bodies and oversized bodies", async () => {
		assert.equal((await call("POST", "/api/sessions", authed, "not json")).status, 400);
		const big = JSON.stringify({ text: "x".repeat(70 * 1024) });
		const res = await call("POST", "/api/sessions/demo/send", authed, big).catch(() => ({ status: 413 }));
		assert.equal(res.status, 413);
	});

	it("streams the NDJSON event feed through", async () => {
		const res = await call("GET", "/api/sessions/demo/events", authed);
		assert.equal(res.status, 200);
		assert.match(String(res.headers["content-type"]), /ndjson/);
		const lines = res.body.trim().split("\n").map((line) => JSON.parse(line) as { type: string });
		assert.deepEqual(lines.map((line) => line.type), ["snapshot", "run_end"]);
	});
});

describe("when the daemon is down", () => {
	it("returns 502 with a hint", async () => {
		const orphan = createUiServer({ socketPath: join(dir, "missing.sock"), token: TOKEN, html: "x" });
		await new Promise<void>((resolve) => orphan.listen(0, "127.0.0.1", resolve));
		const orphanPort = (orphan.address() as { port: number }).port;
		const res = await new Promise<Reply>((resolve, reject) => {
			const req = request({ host: "127.0.0.1", port: orphanPort, path: "/api/status", headers: authed }, (r) => {
				let data = "";
				r.on("data", (chunk: Buffer) => (data += chunk));
				r.on("end", () => resolve({ status: r.statusCode ?? 0, headers: r.headers, body: data }));
			});
			req.on("error", reject);
			req.end();
		});
		orphan.close();
		assert.equal(res.status, 502);
		assert.match(res.body, /pdd-up/);
	});
});

describe("token file", () => {
	it("creates a 64-hex token with mode 600 and reuses it", () => {
		const file = join(dir, "sub", "ui-token");
		const first = loadOrCreateToken(file);
		assert.match(first, /^[0-9a-f]{64}$/);
		assert.equal(statSync(file).mode & 0o777, 0o600);
		assert.equal(loadOrCreateToken(file), first);
	});
});
