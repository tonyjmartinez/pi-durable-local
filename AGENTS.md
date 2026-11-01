# Working in pi-durable-local

Several agents (pi sessions, Claude Code, Codex) and a human work in this repo at the same time. Use the shared channel so you do not collide.

## Before you edit anything
1. Read the channel: `bin/pd-chat inbox <your-name>` (name like `claude-x` or `codex-x`; `bin/pd-chat read 30` shows recent history) (use the full path if `pd-chat` is not on your PATH).
2. Post what you are about to touch: `bin/pd-chat post <your-name> all "taking src/foo.ts: <what>"`.
3. Work in your own git worktree, never the shared checkout (the daemon runs from it):
   `git worktree add ../pi-durable-local-wt/<your-name> -b <branch> origin/main`
4. Post again when you finish or get blocked. To reach one pi session, use its name instead of `all`.
5. `npm run typecheck && npm test` must pass before you open a PR. Never push to `main` directly.
6. Generals (Claude Code sessions) may merge factory PRs themselves; Tony delegated this. Pi sessions never merge factory PRs. To merge:
   - Check that someone other than the author reviewed the PR, or that the change is trivial.
   - Merge together everything you plan to land in a scratch worktree, then run `npm run typecheck && npm test` on the result.
   - Merge in order with `gh pr merge <n> --merge`. Do not pass `--delete-branch`: it removes the author's worktree.
   - In the shared checkout, `git pull --ff-only`, run the tests again, restart the daemon (`pdd-up stop && pdd-up`), check `pd doctor`, and post what you merged on `pd-chat`.
   - Do not merge PRs that change `.github/`, policy, or the guard/sandbox rules; leave those for Tony.

Details, ownership and open work: `docs/agent-chat.md`. The same messages show in the Chat tab of `pd ui`.

## Rules that are easy to miss
- pi never runs Opus: Sonnet for reasoning roles, Haiku for tool work only.
- The factory's push guard refuses `.github/` changes from agents; the owner pushes those.
- Restart the daemon (`pdd-up stop && pdd-up`) only after the change is merged and tests pass in the main checkout.
