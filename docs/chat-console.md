# pd in ChatGPT and Claude: the chat console

Goal: Tony sees, and later steers, the whole factory from a ChatGPT or Claude chat (desktop or phone) without a terminal. `pd ui` stays the local fallback.

Owner: claude-console (Claude Code general). Research: codex-context. Requested by Tony 2026-11-01.

## Architecture

```
ChatGPT / Claude app ──HTTPS──▶ tunnel (phase 2) ──▶ pd-mcp (127.0.0.1:7787) ──unix socket──▶ pdd
        │                                              │
        └─ renders ui://pd/fleet.html in a sandboxed    └─ read-only routes only in phase 1:
           iframe (MCP Apps); the view makes no            GET /status /loops /audit /memory /directions,
           network calls, it asks the host to call         plus the chat log file and `gh` for the brief
           fleet_status again
```

- `src/mcp.ts` (`bin/pd-mcp`): MCP over **stateless Streamable HTTP**. It handles POST JSON-RPC only, with no SSE and no `Mcp-Session-Id`. Both hosts accept this mode (OpenAI's app quickstart uses `sessionIdGenerator: undefined` with `enableJsonResponse: true`; Anthropic's connector docs describe stateless POST). The JSON-RPC is hand-rolled, so there is no new dependency.
- The daemon socket remains the only way in. pd-mcp never opens the store, and like `pd ui` it is a client.
- `src/briefdata.ts`: the `pd brief` data gathering, moved out of `client.ts` so the terminal and the chat apps show the same brief.
- `src/web/fleet.html`: the MCP Apps view (`text/html;profile=mcp-app`). It speaks the MCP Apps postMessage bridge (`ui/initialize`, `ui/notifications/tool-result`, `tools/call` for refresh) and also reads ChatGPT's `window.openai` globals. It uses only inline code, with no external loads.

## Tools

| tool | phase | what |
|---|---|---|
| `fleet_status` | 1 | Structured snapshot of sessions, open loops, budget/pace and queue. Renders the dashboard. Owner-paused loops are not counted as asks, as in `pd brief`. |
| `factory_brief` | 1 | The `pd brief` text. |
| `recent_chat` | 1 | pd-chat messages (at most 100), redacted. |
| `loop_detail` | 1 | One loop record by id. |
| `recent_audit` | 1 | Audit events (at most 100). |
| `loop_pause` / `loop_resume` | 3 | One loop, with an operation id and a receipt. Reversible, so it comes first. |
| `send_to_session` | 4 | Queued through the daemon's budgeted path (respects the send cap, pace and boost), never a direct send. |
| bulk pause/resume | 4 | Reports per-target receipts and partial failure. Pause is separate from abort. |
| `message_general` | 4 | Posts to pd-chat for Claude Code/Codex generals. These are labelled *message only*: the daemon cannot control them, so the UI never shows live controls for them. |

Every output is clipped and passed through `redact()`. Session `cwd`s stay local.

## Auth and exposure

Findings from codex-context (official docs, 2026-11-01):
- **ChatGPT** custom connectors support OAuth or *no auth*. ChatGPT cannot present a custom API key or bearer token.
- **Claude** custom connectors support OAuth (DCR, CIMD or a pre-registered client). Static request headers are a beta for limited organizations, and custom header names need approval, so Cloudflare Access service-token headers are probably unusable.
- OAuth 2.1 with PKCE is the one contract that works on both hosts.

pd-mcp therefore accepts its token either as `Authorization: Bearer` or as the last URL segment (`/mcp/<64-hex>`). The secret URL is what lets ChatGPT and Claude connect in "no auth" mode during the read-only phases, since a secret URL is a capability. It is **not** acceptable for write tools: phase 3 requires OAuth in front of pd-mcp first.

Exposure (Tony chose this 2026-11-01): **Workers VPC**. His Cloudflare account has no zone, so a tunnel has no public hostname; instead a Worker on workers.dev reaches the tunnel privately:

```
https://pd.ajosephmartinez.workers.dev/mcp/<token>
  → Worker `pd` (deploy/pd-console)       only /mcp with a 64-hex token, POST only, 256 KB cap
  → VPC service `pd-mcp`                  http 127.0.0.1:7787 through the tunnel
  → tunnel `pd-console` (cloudflared, outbound only, run by bin/pd-console-up)
  → pd-mcp                                checks the token itself
```

Setup, done once by a general with `CLOUDFLARE_API_TOKEN` from `~/.config/pi-durable/env`. The token needs Account › Cloudflare Tunnel: Edit, Account › Connectivity Directory: Admin, and Account › Workers Scripts: Edit.
1. Create the tunnel: `POST /accounts/<id>/cfd_tunnel {"name":"pd-console","config_src":"cloudflare"}`. Then save `GET …/cfd_tunnel/<tid>/token` to `~/.config/pi-durable/tunnel-token` (mode 600).
2. Create the VPC service: `npx wrangler vpc service create pd-mcp --type http --tunnel-id <tid> --ipv4 127.0.0.1 --http-port 7787`. Put its id in `deploy/pd-console/wrangler.jsonc` (it is not a secret).
3. Deploy the Worker: `npx wrangler deploy -c deploy/pd-console/wrangler.jsonc`.
4. Run `bin/pd-console-up`, and add it to `~/.profile` next to `pdd-up` so it starts on login.

When the machine is asleep, the Worker answers 503 "the factory is offline". OpenAI's Secure MCP Tunnel was the alternative; it covers ChatGPT only.

## Phases and gates

1. **Read-only server (this PR).** Gate: tests pass, plus a live smoke test against pdd (initialize, tools/list, fleet_status, factory_brief, resources/read) and a screenshot of the view in light and dark. ✅
2. **Exposure.** Workers VPC, set up as above; `bin/pd-console-up` supervises pd-mcp and the tunnel. Add the connector in ChatGPT developer mode and as a Claude custom connector. Gate: the dashboard renders in both hosts on desktop *and* phone, refresh works, and a wrong token gets 401.
3. **OAuth and one control.** Put an OAuth front in place (Cloudflare Access for SaaS acting as the OAuth provider, or a minimal built-in authorization server). Add `loop_pause`/`loop_resume` with an operation id, audit (`by: chat-console`) and receipts. Gate: pause and resume round-trip from the phone, the audit shows it, and a replayed operation id is a no-op.
4. **Steering.** Queued sends, bulk actions with partial-failure receipts, and messages to generals. Gate: a capped budget refuses or queues exactly as `pd send` does; bulk pause of N loops reports N receipts.

## Run it

```bash
bin/pd-mcp                      # 127.0.0.1:7787 (PD_MCP_PORT to change); token in ~/.local/share/pi-durable/mcp-token
curl -s -H "Authorization: Bearer $(cat ~/.local/share/pi-durable/mcp-token)" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"fleet_status"}}' http://127.0.0.1:7787/mcp
```

The token file is created with mode 600 on first run. Rotate it by deleting the file and restarting pd-mcp.
