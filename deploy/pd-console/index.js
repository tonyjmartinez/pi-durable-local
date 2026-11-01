// pd-console: the public front door for pd-mcp (docs/chat-console.md, phase 2).
// It forwards only the MCP endpoint, through a Workers VPC service, to a Cloudflare Tunnel on Tony's machine,
// where pd-mcp listens on 127.0.0.1:7787. pd-mcp checks the token itself; this Worker refuses everything else early.
const MCP_PATH = /^\/mcp\/[0-9a-f]{64}\/?$/;
const MAX_BODY = 256 * 1024;

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const authed = MCP_PATH.test(url.pathname) || (url.pathname === "/mcp" && /^Bearer [0-9a-f]{64}$/i.test(request.headers.get("authorization") ?? ""));
		if (!authed) return new Response("not found", { status: 404 });
		if (request.method !== "POST") return Response.json({ error: "POST JSON-RPC only" }, { status: 405, headers: { allow: "POST" } });
		if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return Response.json({ error: "body too large" }, { status: 413 });
		const headers = new Headers({ "content-type": "application/json", accept: "application/json" });
		const auth = request.headers.get("authorization");
		if (auth) headers.set("authorization", auth);
		try {
			const upstream = await env.PD.fetch(new Request(`http://127.0.0.1:7787${url.pathname}`, { method: "POST", headers, body: request.body }));
			return new Response(upstream.body, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" } });
		} catch {
			// The tunnel or pd-mcp is down (machine asleep, pd-console-up not running).
			return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "the factory is offline: pd-mcp or its tunnel is not running" } }, { status: 503 });
		}
	},
};
