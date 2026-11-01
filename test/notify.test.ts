import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { detectTarget, notify, resetNotifyRateLimit } from "../src/notify.ts";
import type { NotifyEvent } from "../src/notify.ts";

type Hit = { method: string; url: string; headers: IncomingHttpHeaders; body: string };
const hits: Hit[] = [];
let server: Server;
let base: string;
let respond: (hit: Hit, res: import("node:http").ServerResponse) => void = (_hit, res) => res.writeHead(200).end("ok");

before(async () => {
	server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk: Buffer) => (body += chunk));
		req.on("end", () => {
			const hit = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
			hits.push(hit);
			respond(hit, res);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => {
	server.closeAllConnections();
	server.close();
});
beforeEach(() => {
	hits.length = 0;
	resetNotifyRateLimit();
	respond = (_hit, res) => res.writeHead(200).end("ok");
});

const event: NotifyEvent = { type: "merged", title: "Merged #12", text: "pi-durable-local#12 squashed to main", url: "https://github.com/o/r/pull/12" };

describe("detectTarget", () => {
	it("recognizes ntfy, Discord, and everything else", () => {
		assert.equal(detectTarget("https://ntfy.sh/my-topic"), "ntfy");
		assert.equal(detectTarget("https://ntfy.example.com/topic"), "ntfy");
		assert.equal(detectTarget("https://discord.com/api/webhooks/1/abc"), "discord");
		assert.equal(detectTarget("https://discordapp.com/api/webhooks/1/abc"), "discord");
		assert.equal(detectTarget("https://discord.com/channels/1/2"), "json");
		assert.equal(detectTarget("https://hooks.example.com/x"), "json");
		assert.equal(detectTarget("not a url"), "json");
		assert.equal(detectTarget("https://notntfy.sh.evil.com/x"), "json");
	});
});

describe("ntfy", () => {
	it("posts plain text with Title, Priority, Tags and Click headers", async () => {
		const result = await notify(event, { webhookUrl: `${base}/topic`, target: "ntfy" });
		assert.deepEqual(result, { ok: true, target: "ntfy" });
		assert.equal(hits.length, 1);
		const hit = hits[0]!;
		assert.equal(hit.method, "POST");
		assert.equal(hit.url, "/topic");
		assert.match(String(hit.headers["content-type"]), /^text\/plain/);
		assert.equal(hit.body, event.text);
		assert.equal(hit.headers.title, "Merged #12");
		assert.equal(hit.headers.priority, "low");
		assert.equal(hit.headers.tags, "white_check_mark,pi-durable");
		assert.equal(hit.headers.click, "https://github.com/o/r/pull/12");
	});

	it("maps each event to a priority and tag", async () => {
		const expected = { merged: "low", parked: "default", loop_blocked: "high", budget_hit: "high", tick_error: "high" } as const;
		for (const [type, priority] of Object.entries(expected)) {
			hits.length = 0;
			await notify({ type: type as NotifyEvent["type"], title: type, text: type }, { webhookUrl: `${base}/t`, target: "ntfy" });
			assert.equal(hits[0]!.headers.priority, priority, type);
			assert.ok(String(hits[0]!.headers.tags).endsWith(",pi-durable"));
		}
	});

	it("encodes non-ASCII titles so the header is valid", async () => {
		const result = await notify({ ...event, title: "Merged ✅ #12" }, { webhookUrl: `${base}/t`, target: "ntfy" });
		assert.equal(result.ok, true);
		assert.match(String(hits[0]!.headers.title), /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
		assert.equal(Buffer.from(String(hits[0]!.headers.title).slice(10, -2), "base64").toString("utf8"), "Merged ✅ #12");
	});

	it("drops a click link that is not http(s) and strips newlines from the title", async () => {
		await notify({ ...event, title: "a\r\nInjected: yes", url: "javascript:alert(1)" }, { webhookUrl: `${base}/t`, target: "ntfy" });
		assert.equal(hits[0]!.headers.click, undefined);
		assert.equal(hits[0]!.headers.injected, undefined);
		assert.equal(hits[0]!.headers.title, "a Injected: yes");
	});
});

describe("discord", () => {
	it("posts JSON content with mentions disabled", async () => {
		const result = await notify({ ...event, text: "hello @everyone" }, { webhookUrl: `${base}/api/webhooks/1/abc`, target: "discord" });
		assert.equal(result.ok, true);
		const body = JSON.parse(hits[0]!.body) as { content: string; allowed_mentions: { parse: string[] }; username: string };
		assert.match(body.content, /^\*\*Merged #12\*\*\nhello @everyone\n<https:\/\/github\.com\/o\/r\/pull\/12>$/);
		assert.deepEqual(body.allowed_mentions, { parse: [] });
		assert.equal(body.username, "pi-durable");
		assert.match(String(hits[0]!.headers["content-type"]), /application\/json/);
	});

	it("keeps the message under Discord's limit", async () => {
		await notify({ ...event, text: "x ".repeat(3000) }, { webhookUrl: `${base}/w`, target: "discord" });
		assert.ok((JSON.parse(hits[0]!.body) as { content: string }).content.length <= 2000);
	});
});

describe("generic JSON", () => {
	it("posts the event as JSON to an unknown URL", async () => {
		const result = await notify(event, { webhookUrl: `${base}/hook` });
		assert.deepEqual(result, { ok: true, target: "json" });
		assert.deepEqual(JSON.parse(hits[0]!.body), { source: "pi-durable", type: "merged", title: event.title, text: event.text, url: event.url });
	});
});

describe("safety", () => {
	it("redacts credentials from the title, text, and link", async () => {
		await notify(
			{ type: "tick_error", title: "failed with sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv", text: "ANTHROPIC_API_KEY=abc12345xyz and ghp_abcdefghijklmnopqrstuvwxyz0123456789", url: "https://user:p4ss@example.com/x" },
			{ webhookUrl: `${base}/hook` },
		);
		assert.ok(!/sk-ant|abc12345xyz|ghp_|p4ss/.test(hits[0]!.body), hits[0]!.body);
		assert.match(hits[0]!.body, /\[redacted\]/);
	});

	it("never repeats the webhook URL in an error", async () => {
		respond = (_hit, res) => res.writeHead(500).end("boom");
		const result = await notify(event, { webhookUrl: `${base}/secret-topic-123` });
		assert.equal(result.ok, false);
		assert.equal(result.error, "webhook answered HTTP 500");
		assert.ok(!JSON.stringify(result).includes("secret-topic-123"));
	});

	it("reports a timeout without throwing", async () => {
		respond = () => undefined;
		const started = Date.now();
		const result = await notify(event, { webhookUrl: `${base}/slow`, timeoutMs: 150 });
		assert.deepEqual(result, { ok: false, error: "webhook timed out" });
		assert.ok(Date.now() - started < 2000);
	});

	it("reports a refused connection without throwing or leaking the URL", async () => {
		const result = await notify(event, { webhookUrl: "http://127.0.0.1:1/very-secret" });
		assert.equal(result.ok, false);
		assert.ok(!JSON.stringify(result).includes("very-secret"));
	});

	it("does not follow redirects", async () => {
		respond = (_hit, res) => res.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" }).end();
		const result = await notify(event, { webhookUrl: `${base}/r` });
		assert.equal(result.ok, false);
		assert.equal(hits.length, 1);
	});

	it("rejects URLs that are not http(s), and missing webhooks are a no-op", async () => {
		assert.equal((await notify(event, { webhookUrl: "ftp://example.com/x" })).ok, false);
		assert.equal((await notify(event, { webhookUrl: "file:///etc/passwd" })).ok, false);
		assert.equal((await notify(event, { webhookUrl: "nonsense" })).ok, false);
		assert.deepEqual(await notify(event, { webhookUrl: undefined }), { ok: true, skipped: "no-webhook" });
		assert.deepEqual(await notify(event, { webhookUrl: "  " }), { ok: true, skipped: "no-webhook" });
		assert.equal(hits.length, 0);
	});

	it("never throws on odd events", async () => {
		const odd = [{ type: "merged", title: undefined, text: null }, { type: "nope", title: 5, text: {} }, {}] as unknown as NotifyEvent[];
		for (const weird of odd) await assert.doesNotReject(notify(weird, { webhookUrl: `${base}/x` }));
	});
});

describe("rate limiting", () => {
	it("sends an identical event once per window", async () => {
		let now = 1_000_000;
		const options = { webhookUrl: `${base}/hook`, now: () => now };
		assert.deepEqual(await notify(event, options), { ok: true, target: "json" });
		assert.deepEqual(await notify(event, options), { ok: true, skipped: "rate-limited" });
		now += 9 * 60_000;
		assert.deepEqual(await notify(event, options), { ok: true, skipped: "rate-limited" });
		now += 2 * 60_000;
		assert.deepEqual(await notify(event, options), { ok: true, target: "json" });
		assert.equal(hits.length, 2);
	});

	it("treats different events as different", async () => {
		const options = { webhookUrl: `${base}/hook`, now: () => 5 };
		await notify(event, options);
		await notify({ ...event, text: "another" }, options);
		await notify({ ...event, type: "parked" }, options);
		assert.equal(hits.length, 3);
	});

	it("counts events that differ only by a secret as the same", async () => {
		const options = { webhookUrl: `${base}/hook`, now: () => 5 };
		await notify({ ...event, text: "key sk-ant-api03-AAAAAAAAAAAAAAAA" }, options);
		const second = await notify({ ...event, text: "key sk-ant-api03-BBBBBBBBBBBBBBBB" }, options);
		assert.equal(second.skipped, "rate-limited");
	});

	it("does not suppress a retry after a failed send", async () => {
		respond = (_hit, res) => res.writeHead(503).end();
		const options = { webhookUrl: `${base}/hook`, now: () => 5 };
		assert.equal((await notify(event, options)).ok, false);
		respond = (_hit, res) => res.writeHead(200).end();
		assert.deepEqual(await notify(event, options), { ok: true, target: "json" });
	});

	it("does not suppress a retry after a timeout", async () => {
		respond = () => undefined;
		const options = { webhookUrl: `${base}/hook`, now: () => 5, timeoutMs: 100 };
		assert.equal((await notify(event, options)).ok, false);
		respond = (_hit, res) => res.writeHead(200).end();
		assert.equal((await notify(event, options)).ok, true);
	});

	it("honours a custom window", async () => {
		let now = 10;
		const options = { webhookUrl: `${base}/hook`, now: () => now, dedupeMs: 1000 };
		await notify(event, options);
		now += 1001;
		assert.equal((await notify(event, options)).skipped, undefined);
	});
});

import { notificationFor } from "../src/state.ts";
describe("proposal notification", () => {
	it("notifies once for a newly filed proposal, not for duplicates or plain friction", () => {
		assert.equal(notificationFor("friction", { proposal: true, title: "x", repo: "o/r", url: "https://github.com/o/r/issues/1" })?.type, "proposal");
		assert.equal(notificationFor("friction", { proposal: true, title: "x", repo: "o/r", duplicateOf: 1 }), undefined);
		assert.equal(notificationFor("friction", { title: "x", url: "u" }), undefined);
	});
});

describe("needsOwner notification", () => {
	it("notifies with the ask on any status, not only blocked", () => {
		const n = notificationFor("loop_report", { loop: "L9", status: "idle", note: "n", needsOwner: { ask: "Need the API key" } });
		assert.equal(n?.type, "loop_blocked");
		assert.equal(n?.title, "Loop L9 needs you");
		assert.equal(n?.text, "Need the API key");
		assert.equal(notificationFor("loop_report", { loop: "L9", status: "continue", note: "n" }), undefined);
	});
});
