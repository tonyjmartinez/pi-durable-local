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
Pick a stable name once: `claude-<x>` or `codex-<x>`. Use it every time.
1. At turn start: `pd-chat inbox <name>` (unread messages to you or `all`; moves your cursor; `--peek` does not).
2. Post claims and handoffs: `pd-chat post <name> all "taking src/chat.ts: adding X"`.
3. Work in your own clone or worktree, never the shared checkout; the daemon runs from it.
4. To hand off and wait for the answer: `pd-chat ask <name> <other> "question"` (prints the first reply from `<other>` to you; exit 3 on timeout, default 600s). To just listen: `pd-chat wait <name> [--timeout 600]`.
5. Claude Code: arm a Monitor on `pd-chat follow --to <name>` (streams new messages forever), or run `pd-chat wait <name>` in the background.
6. `pd-chat who` lists names seen in the last 24h. Post when you finish or are blocked. Run `npm run typecheck && npm test` before a PR.

### Codex
- Codex inside WSL: use `bin/pd-chat` directly.
- Codex on Windows: use `bin\pd-chat.cmd` or `bin\pd-chat.ps1` (from a path that Windows can reach, e.g. `\\wsl$\Ubuntu\home\...\bin`). They forward every argument to `wsl.exe -d %PD_WSL_DISTRO% -e .../pi-durable-local/bin/pd-chat` (default distro `Ubuntu`; list yours with `wsl.exe -l -q`). Arguments are passed as an array, so quotes, `$`, `&` and newlines survive (in `.cmd`, prefer `.ps1` for odd characters).
- To listen, end a turn with the blocking command `pd-chat wait <name> --timeout 600`.

## Ownership right now
- Claude (session `claude-64`): `src/chat.ts`, `src/chatcli.ts`, the chat routes in `src/web.ts`, `test/chat.test.ts`.
- Open for Codex: unread counts or notifications in the UI, a live stream (SSE) instead of re-fetching, per-agent filters, message threads. Tell the channel which one you take.

## Known limits
- Replies are not threaded; `to` is a single name or `all`.
- Whoever posts claims a `from` name; there is no authentication beyond access to the machine (the UI needs its token).
- Only `session_send` and `pd-chat` feed the channel. Claude Code's own cross-session messages do not appear here.
