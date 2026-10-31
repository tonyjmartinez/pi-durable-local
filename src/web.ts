// pd-ui: a small local web interface for the pi-durable daemon.
// It listens on 127.0.0.1 only and proxies an allowlist of daemon routes; it never opens the store itself.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DATA_DIR, SOCKET_PATH } from "./config.ts";
import { ChatError, postChat, readChat } from "./chat.ts";
import { control, listProcesses, tailLog } from "./processes.ts";
import type { Action, ProcessOptions } from "./processes.ts";

export const TOKEN_FILE = join(DATA_DIR, "ui-token");
const COOKIE = "pd_ui";
const TOKEN_HEADER = "x-pd-token";
const MAX_BODY = 64 * 1024;
const NAME = "[A-Za-z0-9][A-Za-z0-9._-]{0,40}";

type Proxy = { method: string; pattern: RegExp; upstream: (match: RegExpExecArray) => string };

/** The only daemon routes the browser can reach. `/api/<path>` maps to the daemon's `<path>`. */
const ALLOWED: Proxy[] = [
	{ method: "GET", pattern: /^\/api\/status$/, upstream: () => "/status" },
	{ method: "POST", pattern: /^\/api\/sessions$/, upstream: () => "/sessions" },
	{ method: "POST", pattern: new RegExp(`^/api/sessions/(${NAME})/(send|abort)$`), upstream: (m) => `/sessions/${m[1]}/${m[2]}` },
	{ method: "GET", pattern: new RegExp(`^/api/sessions/(${NAME})/events$`), upstream: (m) => `/sessions/${m[1]}/events` },
	{ method: "GET", pattern: /^\/api\/loops$/, upstream: () => "/loops" },
	{ method: "POST", pattern: /^\/api\/loops$/, upstream: () => "/loops" },
	{ method: "POST", pattern: /^\/api\/loops\/(L\d{1,9})\/(pause|resume|stop)$/, upstream: (m) => `/loops/${m[1]}/${m[2]}` },
	{ method: "GET", pattern: /^\/api\/memory$/, upstream: () => "/memory" },
	{ method: "GET", pattern: /^\/api\/audit$/, upstream: () => "/audit" },
];

export type UiOptions = {
	/** The daemon's Unix socket. */
	socketPath: string;
	/** The shared secret every request must present. */
	token: string;
	/** The page template; `__TOKEN__` and `__NONCE__` are filled in per response. */
	html?: string;
	/** Where the Processes tab looks for the daemon; the defaults are right outside tests. */
	processes?: ProcessOptions;
	/** Where the Chat tab keeps its messages; the default is right outside tests. */
	chatFile?: string;
};

/** Read the UI token, creating it (mode 600) on first use. */
export function loadOrCreateToken(file = TOKEN_FILE): string {
	if (existsSync(file)) {
		const existing = readFileSync(file, "utf8").trim();
		if (/^[0-9a-f]{64}$/.test(existing)) return existing;
	}
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const token = randomBytes(32).toString("hex");
	writeFileSync(file, `${token}\n`, { mode: 0o600 });
	chmodSync(file, 0o600);
	return token;
}

function same(a: string, b: string): boolean {
	// Hash first so the comparison is constant-time whatever the lengths.
	return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

function cookieValue(request: IncomingMessage, name: string): string | undefined {
	for (const part of (request.headers.cookie ?? "").split(";")) {
		const eq = part.indexOf("=");
		if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
	}
	return undefined;
}

function reply(response: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8", headers: Record<string, string> = {}): void {
	response.writeHead(status, {
		"content-type": type,
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
		"referrer-policy": "no-referrer",
		...headers,
	});
	response.end(body);
}

const json = (response: ServerResponse, status: number, value: unknown) => reply(response, status, JSON.stringify(value), "application/json");

function readBody(request: IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		request.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY) {
				reject(Object.assign(new Error("request body too large"), { status: 413 }));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => resolve(Buffer.concat(chunks)));
		request.on("error", reject);
	});
}

export function createUiServer(options: UiOptions): Server {
	const template = options.html ?? readFileSync(join(dirname(fileURLToPath(import.meta.url)), "web", "index.html"), "utf8");

	const server = createServer(async (request, response) => {
		try {
			await handle(request, response);
		} catch (error) {
			const status = (error as { status?: number }).status ?? 500;
			if (!response.headersSent) json(response, status, { error: status === 500 ? "internal error" : String((error as Error).message) });
			else response.destroy();
		}
	});

	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const port = (server.address() as { port: number } | null)?.port;
		// Only the loopback names are served: a DNS-rebinding page would arrive with its own Host.
		const host = request.headers.host ?? "";
		if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return reply(response, 403, "bad host");

		const url = new URL(request.url ?? "/", "http://ui");
		const method = request.method ?? "GET";

		// A POST must carry the token header: a cookie alone is what a cross-site form would send.
		const header = request.headers[TOKEN_HEADER];
		const presented =
			method === "GET" || method === "HEAD"
				? [typeof header === "string" ? header : undefined, cookieValue(request, COOKIE), url.searchParams.get("token") ?? undefined]
				: [typeof header === "string" ? header : undefined];
		if (!presented.some((candidate) => candidate !== undefined && candidate !== "" && same(candidate, options.token))) {
			return reply(response, 401, "unauthorized: open the URL printed by pd-ui, including ?token=");
		}
		if (method !== "GET" && method !== "HEAD") {
			const origin = request.headers.origin;
			if (origin !== undefined && origin !== `http://${host}`) return reply(response, 403, "bad origin");
		}

		if (url.pathname === "/" && (method === "GET" || method === "HEAD")) {
			// Trade ?token= for a cookie so the secret leaves the address bar and history.
			if (url.searchParams.has("token")) {
				return reply(response, 302, "", "text/plain", {
					location: "/",
					"set-cookie": `${COOKIE}=${options.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
				});
			}
			const nonce = randomBytes(16).toString("base64");
			const page = template.replaceAll("__NONCE__", nonce).replaceAll("__TOKEN__", options.token);
			return reply(response, 200, page, "text/html; charset=utf-8", {
				"content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
				"x-frame-options": "DENY",
			});
		}

		// Process management is local to the UI server so it still works when the daemon is down.
		if (url.pathname === "/api/processes" && method === "GET") return json(response, 200, await listProcesses(options.processes));
		if (url.pathname === "/api/processes/log" && method === "GET") {
			const report = await listProcesses(options.processes);
			return json(response, 200, { log: tailLog(report.logFile, Number(url.searchParams.get("lines") ?? 200)) });
		}
		if (url.pathname === "/api/chat" && method === "GET") {
			return json(response, 200, readChat(options.chatFile, { limit: Number(url.searchParams.get("limit") ?? 200), after: url.searchParams.get("after") ?? undefined }));
		}
		if (url.pathname === "/api/chat" && method === "POST") {
			let input: Record<string, unknown>;
			try {
				input = JSON.parse((await readBody(request)).toString("utf8") || "{}") as Record<string, unknown>;
			} catch {
				return json(response, 400, { error: "body must be JSON" });
			}
			try {
				return json(response, 200, await postChat({ from: input.from ?? "you", to: input.to, text: input.text }, { file: options.chatFile, socketPath: options.socketPath }));
			} catch (error) {
				if (error instanceof ChatError) return json(response, error.status, { error: error.message });
				throw error;
			}
		}
		const act = /^\/api\/processes\/(start|stop|restart)$/.exec(url.pathname);
		if (act !== null && method === "POST") {
			try {
				return json(response, 200, { ok: true, message: await control(act[1] as Action, options.processes) });
			} catch (error) {
				return json(response, 500, { error: (error as Error).message });
			}
		}

		const route = ALLOWED.map((entry) => ({ entry, match: entry.method === method ? entry.pattern.exec(url.pathname) : null })).find((hit) => hit.match !== null);
		if (route === undefined || route.match === null) return json(response, 404, { error: "not found" });

		let body: Buffer | undefined;
		if (method === "POST") {
			const raw = await readBody(request);
			try {
				body = Buffer.from(JSON.stringify(raw.length === 0 ? {} : JSON.parse(raw.toString("utf8"))));
			} catch {
				return json(response, 400, { error: "body must be JSON" });
			}
		}

		const upstream = httpRequest(
			{
				socketPath: options.socketPath,
				method,
				path: route.entry.upstream(route.match),
				headers: body === undefined ? {} : { "content-type": "application/json", "content-length": String(body.length) },
			},
			(daemon) => {
				response.writeHead(daemon.statusCode ?? 502, {
					"content-type": daemon.headers["content-type"] ?? "application/json",
					"cache-control": "no-store",
					"x-content-type-options": "nosniff",
					"x-accel-buffering": "no",
				});
				daemon.pipe(response);
				daemon.on("error", () => response.destroy());
			},
		);
		upstream.on("error", () => {
			if (!response.headersSent) json(response, 502, { error: "the daemon is not reachable; start it with pdd-up" });
			else response.destroy();
		});
		// A closed browser tab ends the event stream upstream too.
		response.on("close", () => upstream.destroy());
		upstream.end(body);
	}

	return server;
}

function main(): void {
	const port = Number(process.env.PD_UI_PORT ?? 7777);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		console.error(`PD_UI_PORT must be a port number (got ${process.env.PD_UI_PORT})`);
		process.exit(2);
	}
	const token = loadOrCreateToken();
	const server = createUiServer({ socketPath: SOCKET_PATH, token });
	server.on("error", (error: NodeJS.ErrnoException) => {
		console.error(error.code === "EADDRINUSE" ? `port ${port} is in use; set PD_UI_PORT to another port` : String(error));
		process.exit(1);
	});
	// Loopback only, by construction: there is no option to change the host.
	server.listen(port, "127.0.0.1", () => {
		console.log(`pd-ui listening on http://127.0.0.1:${port}`);
		console.log(`open: http://127.0.0.1:${port}/?token=${token}`);
		console.log(`(token file: ${TOKEN_FILE}; daemon socket: ${SOCKET_PATH})`);
	});
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
