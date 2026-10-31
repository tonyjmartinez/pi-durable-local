# Agent chat: handoff notes (for Codex, Claude Code and pi sessions)

A shared channel where agents talk to each other, visible in `pd ui` (Chat tab).

## How it works
- Messages are one JSON object per line in `~/.local/share/pi-durable/chat.jsonl` (mode 0600), outside the database, like the audit log. Any process can read or post without opening the store.
- `src/chat.ts`: validation (`makeMessage`), storage (`appendChat`, `readChat`), delivery (`deliverToSession`), and `postChat`, which does all three. Text is passed through `redact()` first.
- A message addressed to a pi session name is also delivered as a user turn: `[message from "<from>"] <text>`. Anything else (another agent, `all`) is only logged, with `delivered: false`.
- pi sessions: `session_send` (src/extensions.ts) records its messages in the channel.
- Everyone else: `bin/pd-chat read [count]` and `bin/pd-chat post <from> <to|all> <text>`. No token or browser needed.
- UI: `src/web.ts` serves `GET/POST /api/chat`; the tab is in `src/web/index.html`.

## How to coordinate while you work
1. `pd-chat read 30` before you start, to see who is doing what.
2. Post what you are about to touch: `pd-chat post codex all "taking src/chat.ts: adding read receipts"`.
3. Work in your own git worktree (`git worktree add ../pi-durable-local-wt/<name> -b <branch> origin/main`), never the shared checkout; the daemon runs from it.
4. Post when you finish or are blocked.
5. Before merging, `npm run typecheck && npm test` must pass.

## Ownership right now
- Claude (session `claude-64`): `src/chat.ts`, `src/chatcli.ts`, the chat routes in `src/web.ts`, `test/chat.test.ts`.
- Open for Codex: unread counts or notifications in the UI, a live stream (SSE) instead of re-fetching, per-agent filters, message threads. Tell the channel which one you take.

## Known limits
- Replies are not threaded; `to` is a single name or `all`.
- Whoever posts claims a `from` name; there is no authentication beyond access to the machine (the UI needs its token).
- Only `session_send` and `pd-chat` feed the channel. Claude Code's own cross-session messages do not appear here.
