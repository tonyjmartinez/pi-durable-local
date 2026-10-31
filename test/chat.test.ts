// The agent channel: validation, redaction, tailing, and delivery to a pi session over a Unix socket.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ChatError, appendChat, formatMessage, makeMessage, postChat, readChat } from "../src/chat.ts";

let dir: string;
let daemon: Server;
const sent: { url: string; body: string }[] = [];
before(async () => {
	dir = mkdtempSync(join(tmpdir(), "pd-chat-"));
	daemon = createServer((req, res) => {
		let body = "";
		req.on("data", (c: Buffer) => (body += c));
		req.on("end", () => {
			sent.push({ url: req.url ?? "", body });
			res.writeHead(req.url === "/sessions/alpha/send" ? 200 : 404, { "content-type": "application/json" });
			res.end("{}");
		});
	});
	await new Promise<void>((resolve) => daemon.listen(join(dir, "pdd.sock"), resolve));
});
after(() => {
	daemon.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("makeMessage", () => {
	it("defaults to everyone and masks secrets", () => {
		const m = makeMessage({ from: "codex", text: "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" });
		assert.equal(m.to, "all");
		assert.ok(!m.text.includes("abcdefghijklmnop"));
	});
	it("rejects bad names, empty text and long text", () => {
		assert.throws(() => makeMessage({ from: "bad name", text: "x" }), ChatError);
		assert.throws(() => makeMessage({ from: "a", to: "../x", text: "x" }), ChatError);
		assert.throws(() => makeMessage({ from: "a", text: "  " }), ChatError);
		assert.throws(() => makeMessage({ from: "a", text: "x".repeat(4001) }), ChatError);
	});
});

describe("postChat and readChat", () => {
	it("delivers to a live session and records it as delivered", async () => {
		const file = join(dir, "chat.jsonl");
		const m = await postChat({ from: "codex", to: "alpha", text: "hello" }, { file, socketPath: join(dir, "pdd.sock") });
		assert.equal(m.delivered, true);
		assert.deepEqual(JSON.parse(sent.at(-1)!.body), { text: '[message from "codex"] hello' });
		assert.equal(statSync(file).mode & 0o777, 0o600);
	});
	it("records a message to a non-session as not delivered", async () => {
		const file = join(dir, "chat2.jsonl");
		const m = await postChat({ from: "claude", to: "codex", text: "ping" }, { file, socketPath: join(dir, "pdd.sock") });
		assert.equal(m.delivered, false);
		assert.match(formatMessage(m), /not a live pi session/);
	});
	it("does not call the daemon for a broadcast, and the daemon being down is not an error", async () => {
		const before = sent.length;
		const file = join(dir, "chat3.jsonl");
		await postChat({ from: "a", text: "all hands" }, { file, socketPath: join(dir, "pdd.sock") });
		assert.equal(sent.length, before);
		const down = await postChat({ from: "a", to: "alpha", text: "x" }, { file, socketPath: join(dir, "nope.sock") });
		assert.equal(down.delivered, false);
	});
	it("returns messages oldest first, honours limit and after, and skips garbage", () => {
		const file = join(dir, "chat4.jsonl");
		const ids = ["1", "2", "3"].map((n) => {
			const m = makeMessage({ from: "a", text: n });
			appendChat(m, file);
			return m.id;
		});
		assert.deepEqual(readChat(file).map((m) => m.text), ["1", "2", "3"]);
		assert.deepEqual(readChat(file, { limit: 2 }).map((m) => m.text), ["2", "3"]);
		assert.deepEqual(readChat(file, { after: ids[0] }).map((m) => m.text), ["2", "3"]);
		assert.deepEqual(readChat(join(dir, "missing.jsonl")), []);
	});
});
