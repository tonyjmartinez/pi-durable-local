// Tell the user something happened: a phone notification (ntfy), a Discord message, or a generic JSON webhook.
// Never throws; text is scrubbed of credentials; identical events are sent once per window.
import { createHash } from "node:crypto";
import { redact } from "./redact.ts";

export type NotifyType = "merged" | "parked" | "loop_blocked" | "budget_hit" | "tick_error" | "proposal";

export type NotifyEvent = {
	type: NotifyType;
	title: string;
	text: string;
	/** A link to open, such as the PR. */
	url?: string;
};

export type NotifyTarget = "ntfy" | "discord" | "json";

export type NotifyOptions = {
	webhookUrl: string | undefined;
	/** Force a target instead of detecting it from the URL (a self-hosted ntfy, or a test server). */
	target?: NotifyTarget;
	timeoutMs?: number;
	/** Identical events inside this window are skipped. Default 10 minutes. */
	dedupeMs?: number;
	now?: () => number;
};

export type NotifyResult = { ok: boolean; target?: NotifyTarget; error?: string; skipped?: "rate-limited" | "no-webhook" };

const TAGS: Record<NotifyType, string> = {
	merged: "white_check_mark",
	parked: "raised_hand",
	loop_blocked: "no_entry",
	budget_hit: "moneybag",
	tick_error: "rotating_light",
	proposal: "bulb",
};
const PRIORITY: Record<NotifyType, string> = { merged: "low", parked: "default", loop_blocked: "high", budget_hit: "high", tick_error: "high", proposal: "default" };

export function detectTarget(url: string): NotifyTarget {
	let host: string;
	let path: string;
	try {
		const parsed = new URL(url);
		host = parsed.hostname.toLowerCase();
		path = parsed.pathname;
	} catch {
		return "json";
	}
	if (host === "ntfy.sh" || host.endsWith(".ntfy.sh") || host.startsWith("ntfy.")) return "ntfy";
	if ((host === "discord.com" || host.endsWith(".discord.com") || host === "discordapp.com" || host.endsWith(".discordapp.com")) && path.startsWith("/api/webhooks/")) return "discord";
	return "json";
}

const recent = new Map<string, number>();
/** Forget what was sent (for tests). */
export function resetNotifyRateLimit(): void {
	recent.clear();
}

function tooSoon(key: string, now: number, windowMs: number): boolean {
	for (const [k, at] of recent) if (now - at >= windowMs) recent.delete(k);
	if (recent.has(key)) return true;
	recent.set(key, now);
	// Bounded: drop the oldest entries if something floods.
	while (recent.size > 500) recent.delete(recent.keys().next().value as string);
	return false;
}

/** HTTP headers are Latin-1; anything else goes out as RFC 2047 base64, which ntfy decodes. */
function headerValue(text: string): string {
	const flat = text.replace(/[\r\n]+/g, " ").trim();
	return /^[\x20-\x7e]*$/.test(flat) ? flat : `=?UTF-8?B?${Buffer.from(flat, "utf8").toString("base64")}?=`;
}

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function request(target: NotifyTarget, event: NotifyEvent): { headers: Record<string, string>; body: string } {
	const url = event.url === undefined ? undefined : /^https?:\/\//i.test(event.url) ? event.url : undefined;
	if (target === "ntfy") {
		return {
			headers: {
				"content-type": "text/plain; charset=utf-8",
				title: headerValue(clip(event.title, 120)),
				priority: PRIORITY[event.type],
				tags: `${TAGS[event.type]},pi-durable`,
				...(url === undefined ? {} : { click: url }),
			},
			body: clip(event.text, 3500),
		};
	}
	if (target === "discord") {
		const lines = [`**${event.title}**`, event.text, ...(url === undefined ? [] : [`<${url}>`])];
		// No mentions: the text can come from an agent.
		return { headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "pi-durable", content: clip(lines.join("\n"), 1900), allowed_mentions: { parse: [] } }) };
	}
	return {
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ source: "pi-durable", type: event.type, title: event.title, text: event.text, ...(url === undefined ? {} : { url }) }),
	};
}

export async function notify(event: NotifyEvent, options: NotifyOptions): Promise<NotifyResult> {
	let key: string | undefined;
	try {
		if (options.webhookUrl === undefined || options.webhookUrl.trim() === "") return { ok: true, skipped: "no-webhook" };
		let url: URL;
		try {
			url = new URL(options.webhookUrl.trim());
		} catch {
			return { ok: false, error: "webhook url is not a valid URL" };
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, error: "webhook url must be http or https" };

		const clean: NotifyEvent = {
			type: event.type,
			title: redact(String(event.title)),
			text: redact(String(event.text)),
			...(event.url === undefined ? {} : { url: redact(String(event.url)) }),
		};
		const now = (options.now ?? Date.now)();
		key = createHash("sha256").update(`${clean.type}\n${clean.title}\n${clean.text}`).digest("hex");
		if (tooSoon(key, now, options.dedupeMs ?? 600_000)) return { ok: true, skipped: "rate-limited" };

		const target = options.target ?? detectTarget(url.toString());
		const { headers, body } = request(target, clean);
		const response = await fetch(url, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? 5000) });
		await response.body?.cancel();
		// The URL is a secret (a Discord token, an ntfy topic), so errors never repeat it.
		if (!response.ok) {
			recent.delete(key);
			return { ok: false, target, error: `webhook answered HTTP ${response.status}` };
		}
		return { ok: true, target };
	} catch (error) {
		// A send that did not arrive must not block its own retry.
		if (key !== undefined) recent.delete(key);
		const name = (error as { name?: string }).name;
		return { ok: false, error: name === "TimeoutError" || name === "AbortError" ? "webhook timed out" : "webhook request failed" };
	}
}
