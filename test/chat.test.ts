// The agent channel: validation, redaction, tailing, and delivery to a pi session over a Unix socket.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ChatError, askChat, getCursor, inbox, waitInbox, whoChat, appendChat, formatMessage, makeMessage, postChat, readChat } from "../src/chat.ts";

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

describe("bridge", () => {
	const mk = (from: string, to: string, text: string) => {
		const m = makeMessage({ from, to, text });
		return m;
	};
	it("inbox filters, advances the cursor, and peek does not", () => {
		const f = join(dir, "i.jsonl");
		const c = join(dir, "i-cur.json");
		appendChat(mk("a", "b", "one"), f);
		appendChat(mk("b", "all", "own"), f);
		appendChat(mk("a", "all", "two"), f);
		appendChat(mk("a", "c", "other"), f);
		assert.deepEqual(inbox("b", { file: f, cursorFile: c, peek: true }).map((m) => m.text), ["one", "two"]);
		assert.equal(getCursor("b", c), undefined);
		assert.deepEqual(inbox("b", { file: f, cursorFile: c }).map((m) => m.text), ["one", "two"]);
		assert.equal(statSync(c).mode & 0o777, 0o600);
		assert.deepEqual(inbox("b", { file: f, cursorFile: c }), []);
		appendChat(mk("a", "b", "three"), f);
		assert.deepEqual(inbox("b", { file: f, cursorFile: c }).map((m) => m.text), ["three"]);
	});
	it("wait resolves on append and times out", async () => {
		const f = join(dir, "w.jsonl");
		const c = join(dir, "w-cur.json");
		appendChat(mk("a", "all", "seed"), f);
		inbox("b", { file: f, cursorFile: c });
		assert.equal(await waitInbox("b", { file: f, cursorFile: c, timeoutSec: 0.2, pollMs: 50 }), null);
		setTimeout(() => { appendChat(mk("a", "b", "hi"), f) }, 100);
		const got = await waitInbox("b", { file: f, cursorFile: c, timeoutSec: 5, pollMs: 50 });
		assert.equal(got?.[0]?.text, "hi");
	});
	it("ask matches only the reply from <to> to <from>", async () => {
		const f = join(dir, "a.jsonl");
		setTimeout(() => {
			appendChat(mk("z", "a", "noise"), f);
			appendChat(mk("b", "z", "wrong recipient"), f);
			appendChat(mk("b", "a", "answer"), f);
		}, 100);
		const reply = await askChat({ from: "a", to: "b", text: "q" }, { file: f, deliver: false, timeoutSec: 5, pollMs: 50 });
		assert.equal(reply?.text, "answer");
		assert.equal(await askChat({ from: "a", to: "q", text: "q" }, { file: f, deliver: false, timeoutSec: 0.2, pollMs: 50 }), null);
	});
	it("who lists recent posters", () => {
		const f = join(dir, "who.jsonl");
		appendChat(mk("a", "all", "x"), f);
		assert.deepEqual(whoChat({ file: f, cursorFile: join(dir, "none.json") }).map((w) => w.name), ["a"]);
		assert.deepEqual(whoChat({ file: f, cursorFile: join(dir, "none.json"), now: Date.now() + 48 * 3600_000 }), []);
	});
});
