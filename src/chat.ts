// A shared channel where agents talk to each other: pi sessions, Claude Code, Codex, and you.
// Messages live in an append-only JSONL file outside the database, like the audit log, so any process can
// read or post without opening the store. Posting to a pi session also delivers it as a user turn.
import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import { DATA_DIR, SOCKET_PATH } from "./config.ts";
import { auditTail } from "./ops.ts";
import { redact } from "./redact.ts";

export const CHAT_LOG = join(DATA_DIR, "chat.jsonl");
export const MAX_TEXT = 4000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;

export type ChatMessage = {
	id: string;
	at: string;
	from: string;
	/** A name, or "all" for the whole channel. */
	to: string;
	text: string;
	/** True when the message reached a pi session's conversation; false for other agents and "all". */
	delivered: boolean;
};

export class ChatError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

/** Validate and build a message; secrets in the text are masked before it is stored or delivered. */
export function makeMessage(input: { from: unknown; to?: unknown; text: unknown }): ChatMessage {
	const from = String(input.from ?? "");
	const to = input.to === undefined || input.to === "" ? "all" : String(input.to);
	const text = String(input.text ?? "").trim();
	if (!NAME.test(from)) throw new ChatError(400, "from must be a short name (letters, digits, . _ -)");
	if (to !== "all" && !NAME.test(to)) throw new ChatError(400, "to must be a name or all");
	if (text === "") throw new ChatError(400, "text is empty");
	if (text.length > MAX_TEXT) throw new ChatError(413, `text is over ${MAX_TEXT} characters`);
	return { id: `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`, at: new Date().toISOString(), from, to, text: redact(text), delivered: false };
}

export function appendChat(message: ChatMessage, file = CHAT_LOG): void {
	if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	appendFileSync(file, `${JSON.stringify(message)}\n`, { mode: 0o600 });
	chmodSync(file, 0o600);
}

/** Messages newest last. `after` is a message id: only later messages are returned. */
export function readChat(file = CHAT_LOG, options: { limit?: number; after?: string } = {}): ChatMessage[] {
	if (!existsSync(file)) return [];
	const limit = Math.min(Math.max(Math.trunc(options.limit ?? 200) || 200, 1), 1000);
	const rows = auditTail(file, 1000).filter((row): row is ChatMessage => typeof row === "object" && row !== null && typeof (row as ChatMessage).id === "string");
	if (options.after !== undefined) {
		const index = rows.findIndex((row) => row.id === options.after);
		return (index === -1 ? rows : rows.slice(index + 1)).slice(-limit);
	}
	return rows.slice(-limit);
}

/** Hand a message to a pi session as a user turn. False when no such session exists or the daemon is down. */
export function deliverToSession(to: string, from: string, text: string, socketPath = SOCKET_PATH): Promise<boolean> {
	return new Promise((resolve) => {
		const body = JSON.stringify({ text: `[message from "${from}"] ${text}` });
		const req = httpRequest(
			{ socketPath, method: "POST", path: `/sessions/${to}/send`, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }, timeout: 5000 },
			(res) => {
				res.resume();
				res.on("end", () => resolve((res.statusCode ?? 500) < 300));
			},
		);
		req.on("error", () => resolve(false));
		req.on("timeout", () => {
			req.destroy();
			resolve(false);
		});
		req.end(body);
	});
}

/** Post to the channel: validate, deliver to a pi session when `to` names one, then record. */
export async function postChat(input: { from: unknown; to?: unknown; text: unknown }, options: { file?: string; socketPath?: string; deliver?: boolean } = {}): Promise<ChatMessage> {
	const message = makeMessage(input);
	if (message.to !== "all" && options.deliver !== false) message.delivered = await deliverToSession(message.to, message.from, message.text, options.socketPath);
	appendChat(message, options.file);
	return message;
}

export function formatMessage(message: ChatMessage): string {
	const where = message.to === "all" ? "all" : `${message.to}${message.delivered ? "" : " (not a live pi session)"}`;
	return `${message.at.slice(11, 19)} ${message.from} -> ${where}: ${message.text}`;
}

// ---- Per-agent inbox, wait, ask, who ----
export const CURSOR_FILE = join(DATA_DIR, "chat-cursors.json");
type Cursors = Record<string, { id: string; at: string }>;

function readCursors(file: string): Cursors {
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		return typeof parsed === "object" && parsed !== null ? (parsed as Cursors) : {};
	} catch {
		return {};
	}
}

export function getCursor(name: string, file = CURSOR_FILE): { id: string; at: string } | undefined {
	return readCursors(file)[name];
}

export function setCursor(name: string, id: string, file = CURSOR_FILE): void {
	if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const cursors = readCursors(file);
	cursors[name] = { id, at: new Date().toISOString() };
	writeFileSync(file, JSON.stringify(cursors, null, 1), { mode: 0o600 });
	chmodSync(file, 0o600);
}

/** Messages to `name` (or "all"), not from `name`, after the agent's cursor. Advances the cursor unless `peek`. */
export function inbox(name: string, options: { file?: string; cursorFile?: string; peek?: boolean } = {}): ChatMessage[] {
	if (!NAME.test(name)) throw new ChatError(400, "name must be a short name (letters, digits, . _ -)");
	const rows = readChat(options.file, { limit: 1000 });
	const cursor = getCursor(name, options.cursorFile)?.id;
	const index = cursor === undefined ? -1 : rows.findIndex((row) => row.id === cursor);
	const fresh = rows.slice(index + 1);
	if (!options.peek && rows.length > 0 && rows[rows.length - 1]?.id !== cursor) setCursor(name, rows[rows.length - 1]?.id ?? "", options.cursorFile);
	const mine = fresh.filter((row) => row.from !== name && (row.to === name || row.to === "all"));
	// A first call has no cursor: show only the latest few instead of the whole history.
	return cursor === undefined ? mine.slice(-FIRST_INBOX) : mine;
}

const FIRST_INBOX = 10;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve when `check` returns a non-empty list, waking on fs.watch and a poll (watch is unreliable on WSL/Windows). Null on timeout. */
async function waitFor<T>(check: () => T[], file: string, timeoutSec: number, pollMs: number): Promise<T[] | null> {
	const deadline = Date.now() + timeoutSec * 1000;
	let wake: (() => void) | undefined;
	let watcher: ReturnType<typeof watch> | undefined;
	try {
		watcher = watch(existsSync(file) ? file : dirname(file), () => wake?.());
		watcher.on("error", () => {});
	} catch {
		watcher = undefined;
	}
	try {
		for (;;) {
			const found = check();
			if (found.length > 0) return found;
			const left = deadline - Date.now();
			if (left <= 0) return null;
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, Math.min(pollMs, left));
				wake = () => {
					clearTimeout(timer);
					resolve();
				};
			});
		}
	} finally {
		watcher?.close();
	}
}

/** Block until `name` has inbox messages; returns them (cursor advanced) or null on timeout. */
export function waitInbox(name: string, options: { file?: string; cursorFile?: string; timeoutSec?: number; pollMs?: number } = {}): Promise<ChatMessage[] | null> {
	if (NAME.test(name) && getCursor(name, options.cursorFile) === undefined) inbox(name, { ...options, peek: false }); // start from now
	return waitFor(() => inbox(name, options), options.file ?? CHAT_LOG, options.timeoutSec ?? 600, options.pollMs ?? 1000);
}

/** Post, then wait for the first reply from `to` addressed to `from`. Null on timeout. */
export async function askChat(input: { from: string; to: string; text: string }, options: { file?: string; socketPath?: string; deliver?: boolean; timeoutSec?: number; pollMs?: number } = {}): Promise<ChatMessage | null> {
	if (input.to === "all") throw new ChatError(400, "ask needs a specific recipient, not all");
	const sent = await postChat(input, options);
	const file = options.file ?? CHAT_LOG;
	const found = await waitFor(() => readChat(file, { limit: 1000, after: sent.id }).filter((row) => row.from === input.to && (row.to === input.from)).slice(0, 1), file, options.timeoutSec ?? 600, options.pollMs ?? 1000);
	return found?.[0] ?? null;
}

/** Names seen in the last `hours`, with last post time and cursor age. */
export function whoChat(options: { file?: string; cursorFile?: string; hours?: number; now?: number } = {}): { name: string; lastPost: string | null; cursorAt: string | null }[] {
	const now = options.now ?? Date.now();
	const since = now - (options.hours ?? 24) * 3600_000;
	const last = new Map<string, string>();
	for (const row of readChat(options.file, { limit: 1000 })) if (Date.parse(row.at) >= since) last.set(row.from, row.at);
	const cursors = readCursors(options.cursorFile ?? CURSOR_FILE);
	for (const [name, c] of Object.entries(cursors)) if (Date.parse(c.at) >= since && !last.has(name)) last.set(name, "");
	return [...last].map(([name, at]) => ({ name, lastPost: at || null, cursorAt: cursors[name]?.at ?? null })).sort((a, b) => a.name.localeCompare(b.name));
}
