// A shared channel where agents talk to each other: pi sessions, Claude Code, Codex, and you.
// Messages live in an append-only JSONL file outside the database, like the audit log, so any process can
// read or post without opening the store. Posting to a pi session also delivers it as a user turn.
import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
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
