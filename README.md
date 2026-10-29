# pi-durable-local

A small, portable software factory: durable coding-agent sessions that keep running on your machine, built on `pi-durable`. Agents take work from idea to merged PR inside a sandbox, under budgets and merge gates you control. Clone it onto any Linux or WSL box, run `scripts/install.sh`, add one API key, and it runs locally.

One daemon, `pdd`, owns a pi-durable SQLite store at `~/.local/share/pi-durable/state.sqlite`. A small client, `pd`, talks to it over a Unix socket (`~/.local/share/pi-durable/pdd.sock`, mode 0600). Everything lives in the daemon:

- **Named sessions.** Each is a long-running agent conversation with its own working directory and purpose. They survive restarts and crashes; the daemon resumes from the last committed step.
- **Shared memory.** One durable document that every session reads in its system prompt (project-scoped entries only where they apply) and writes through `memory_save`, `memory_search`, and `memory_forget`.
- **Cross-session messaging.** `sessions_list` and `session_send` let sessions hand work to each other.
- **Loops.** A session can be woken on an interval to push a goal forward, within a dollar budget and an iteration cap.
- **Safeguards.** Every agent shell runs in a bubblewrap sandbox with no credentials. The daemon pushes and opens PRs on the agents' behalf, a gated `pr_merge` tool is the only way anything merges, and an audit log records every decision.
- **Web access.** `web_search` (Anthropic server-side search) and `web_fetch` (public http(s) only; private and local addresses are blocked).

Why one process: pi-durable has no cross-process locking on its store. Two processes opening the same SQLite file would corrupt each other's state, so exactly one daemon opens it and everything else goes through the socket.

## Setup

Requires Node (the unit file points at an nvm install), `gh`, and optionally `tmux`.

```sh
npm install

# Secrets: the daemon reads ~/.config/pi-durable/env (created on first start, mode 0600).
# Only ANTHROPIC_API_KEY is needed. Web search uses Anthropic's server-side search, so no search key.
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> ~/.config/pi-durable/env

mkdir -p ~/.local/bin
ln -sf "$PWD/bin/pd" ~/.local/bin/pd
ln -sf "$PWD/bin/pdd-up" ~/.local/bin/pdd-up
pdd-up            # start the daemon under a restart loop (pdd-up stop to stop it)

# Start it whenever WSL opens a login shell:
echo '[ -x "$HOME/.local/bin/pdd-up" ] && "$HOME/.local/bin/pdd-up" >/dev/null 2>&1' >> ~/.profile

gh auth login --git-protocol ssh --web
pd doctor
```

Why not systemd: on WSL, WSLg mounts its own tmpfs over `/run/user/$UID`, which hides the systemd user bus, so `systemctl --user` cannot connect. `bin/pdd-up` is a small supervisor instead: it runs the daemon in its own process group and restarts it 5 seconds after any exit. `pd` also starts it on demand when the socket is missing. A unit file is kept in `systemd/` for machines where the user bus works.

`pd doctor` checks: the API key, the policy file, the supervisor, login autostart, the socket, the store, `gh` login, and the auto-merge allowlist.

## Daily use

```
pd status                                 sessions, loops, spend, parked tasks
pd new <name> --cwd <dir> [--purpose "..."] [--model provider/id]
pd attach <name>                          live view and chat
pd send <name> "message" [--steer]        fire and forget
pd rm <name>                              remove a session (its history stays in the store)
pd tmux [names...]                        tmux session "pd": status window plus one window per session
pd loop start <session> "goal" [--every 60] [--max 20] [--budget 5]
pd loop ls | pause <id> | resume <id> | stop <id>
pd mem [search words]                     shared memory
pd mem add "topic" "fact" [--project <dir>]
pd mem rm <id>
pd audit                                  safety decisions and merges
pd retry <taskId>                         rerun a parked task
pd doctor                                 check setup
```

`pd` with no arguments is `pd status`. Session names are letters, digits, `.`, `_`, `-` (max 41 characters). Without `--cwd`, `pd new` uses your current directory.

Inside `pd attach`, plain text is sent as a message (queued if the agent is busy). Slash commands:

- `/steer <msg>` interrupts the current run with a message
- `/abort` aborts the current run
- `/reset [note]` resets context, optionally with a handoff note
- `/compact` compacts context
- `/model <provider/id>` switches model
- `/quit` (or Ctrl-C) detaches

Detaching never stops the agent. Sessions also see the project's `AGENTS.md` or `CLAUDE.md` (first 12,000 characters) in their prompt.

## Loops

```sh
pd loop start myproj "Get the test suite green and the docs current" --every 30 --max 10 --budget 3
```

Defaults come from the policy: 60 minutes between iterations, 20 iterations, 5 USD. Spend is measured as the session's cost since the loop started.

Lifecycle: `active` while scheduled; `paused` when you pause it, when the budget is reached, or when the agent reports `blocked`; `done` when the goal is achieved, the iteration cap is reached, or you stop it; `failed` if the session disappears. `pd loop resume <id>` reactivates a paused loop with a fresh budget window. Loops run in the background, so they do not mark the session as busy.

Each iteration sends the session a prompt that tells it to: orient (memory, git status, open PRs, CI, last iteration's notes); finish any open PR of its own first, through `pr_merge`; otherwise take the next step, which may be planning work early on or implementation on a fresh `pd/...` branch with tests, pushed and opened as a PR; save what the next iteration needs with `memory_save`; and end by calling `loop_report` with `continue`, `done`, or `blocked` and a one-line note. `blocked` pauses the loop until you resume it.

Agents may only push branches that start with the branch prefix (`pd/` by default).

## Auto-merge gates

Agents never hold GitHub credentials. They commit locally and call tools that the daemon runs with its own login:

- `git_push` pushes a `pd/` work branch. The daemon fetches it from the agent's repo into a bare mirror it owns, then pushes from the mirror to the remote recorded when the session was created. It never runs git with agent-controlled config or hooks.
- `pr_create` pushes and opens a PR against the repo's deploy branch. `pr_status` and `pr_list` read PRs and CI.
- `pr_merge` checks every gate below. If any fails, the PR stays open, a comment listing the reasons is posted, and the refusal is audited. If all pass, it merges pinned to the checked head commit (`--match-head-commit`).

1. The repo is in `automerge.repos`.
2. The PR is open, not a draft, not from a fork, and authored by the daemon's own account.
3. The base is the deploy branch: `automerge.baseBranches[repo]` if set, else the GitHub default branch.
4. The head branch starts with `automerge.branchPrefix`.
5. GitHub reports it mergeable, and no reviewer requested changes.
6. The description has a `Verification:` section and a `Door: two-way` line. One-way-door changes (migrations, deletions, public API, dependencies, infrastructure) are always left for a human.
7. Added plus deleted lines ≤ `maxChangedLines`, files ≤ `maxChangedFiles`.
8. No changed file matches `protectedPaths`, checking both sides of a rename. Defaults include CI config, env and key files, migrations, Dockerfiles, Terraform, every `package.json` and lockfile, Makefiles, test-runner configs, git hooks, `wrangler.*`, `AGENTS.md`.
9. CI on the exact head commit: nothing failing or pending, and (with `requireChecks`) at least one passing GitHub Actions check run. Commit statuses never count as a pass, because anyone with a token can post one.
10. With `requireAiReview`, an independent model (`reviewModel`) reviews the title, description and diff, treating them as untrusted data. Any conflicting, unparseable, or missing verdict is a rejection.

Try the gates on a real PR without merging: `pd gates owner/repo 54` runs all of them, including the AI review, even for a repo that is not allowlisted.

To enable a repo, add it to the allowlist in `~/.config/pi-durable/policy.json`:

```json
{ "automerge": { "repos": ["you/your-repo"] } }
```

The file is read live, so no restart is needed. The allowlist is empty by default, which means nothing auto-merges anywhere. Only set the keys you want to override; the rest keep their defaults.

## Safeguards

**The sandbox (structural).** Every agent shell command runs through `bin/agent-shell`, which is bash inside bubblewrap:

- Credentials and daemon state are hidden behind empty tmpfs mounts: `~/.ssh`, `~/.config/pi-durable`, `~/.config/gh`, `~/.local/share/pi-durable`, `~/.claude*`, `~/.pi`, cloud CLI configs, `~/.npmrc`, `~/.netrc`, `~/.git-credentials`, and `/run/user` (so agents can't reach other local sockets).
- `$HOME` is read-only except the writable roots (`~/proj` by default), `/tmp`, and package caches. This repo, the daemon's own code and guard, is read-only even though it sits under `~/proj`, so agents can't edit their own rules or add shell-startup persistence.
- A private PID namespace: other processes, including the daemon and its environment, are invisible.
- The network stays on for package installs and docs. Agents have no credentials to use it against your accounts.
- If bubblewrap is missing, agent commands refuse to run unless `PD_ALLOW_UNSANDBOXED=1` is set for the daemon.

**The guard (defense in depth).** Every tool call also passes a pattern-based guard first; blocks are returned to the agent and audited. It blocks `sudo`, destructive deletes, disk tools, running downloaded code, force/mirror/delete pushes, pushes to anything but `origin` `pd/…`, git aliases and remote changes, `--no-verify`, all `gh` writes (`pr merge|review|edit`, `api` with any method other than GET, `api graphql`, `alias`, `config`, `auth`, repo administration), publishing, touching the daemon, and secret paths named directly or by directory fragment. `read`, `write`, and `edit` resolve symlinks before checking, are confined to the writable roots, and never touch `.env` files or `.git` internals.

**The audit log.** Blocks, pushes, PRs, merges, refusals, gate dry runs, loop events, and daemon errors are appended to `~/.local/share/pi-durable/audit.jsonl` (mode 600). `pd audit` shows the latest.

### Limits

- `read`, `write`, `edit`, and `web_fetch` run inside the daemon, not the sandbox; they are covered by the guard's path checks only.
- The sandbox is Linux-only (bubblewrap). On macOS there is no equivalent yet.
- On private repos without GitHub Pro, branch protection and rulesets are unavailable, so `pr_merge`'s gates are the only thing standing between an agent's PR and the deploy branch. On repos where you can, also enable branch protection on the deploy branch (require PRs and passing CI) so GitHub enforces it server-side.

## Policy file reference

`~/.config/pi-durable/policy.json` is created with defaults on first start and re-read on every use. Partial files are fine; `automerge` and `loops` merge key by key with the defaults. If the file fails to parse, the defaults are used.

| Field | Default | Meaning |
| --- | --- | --- |
| `model` | `anthropic/claude-opus-5-5` | Default model for new sessions (`provider/modelId`) |
| `reviewModel` | `anthropic/claude-opus-5-5` | Model for the AI review gate |
| `searchModel` | `anthropic/claude-opus-5-5` | Model that runs `web_search` |
| `thinkingLevel` | `medium` | `off`, `minimal`, `low`, `medium`, or `high` |
| `writableRoots` | `~/proj`, `/tmp` | Where `write`/`edit` are allowed and what the sandbox mounts writable (restart to apply to the sandbox) |
| `automerge.repos` | `[]` | `owner/repo` allowlist for `pr_merge` |
| `automerge.baseBranches` | `{}` | `owner/repo` → branch PRs target, when the GitHub default is not the deploy branch |
| `automerge.branchPrefix` | `pd/` | Required prefix for agent branches and PR heads |
| `automerge.maxChangedLines` | `600` | Additions plus deletions limit |
| `automerge.maxChangedFiles` | `25` | Changed file limit |
| `automerge.protectedPaths` | see below | Globs no automated PR may touch |
| `automerge.requireChecks` | `true` | Need at least one passing CI check |
| `automerge.requireAiReview` | `true` | Need independent model approval |
| `automerge.mergeMethod` | `squash` | `squash`, `merge`, or `rebase` |
| `loops.defaultBudgetUsd` | `5` | Per-loop spend cap |
| `loops.defaultIntervalMinutes` | `60` | Time between iterations |
| `loops.defaultMaxIterations` | `20` | Iteration cap |

Default `protectedPaths`: see gate 8 above and `DEFAULT_POLICY` in `src/config.ts`. In globs, `**` spans directories and `*` stays within one. Setting `protectedPaths` replaces the list, it does not extend it.

`model`, `thinkingLevel`, and `writableRoots` apply to new sessions and to guard checks as they happen. Change a running session's model with `/model` in `pd attach`.

## Troubleshooting

- **Logs:** `tail -f ~/.local/share/pi-durable/pdd.log`
- **"pdd is not running":** `pdd-up`, then `pd doctor`.
- **Restart after changing code or secrets:** `pdd-up stop && pdd-up`. Every committed step survives the restart.
- **Parked tasks:** if a task cannot make progress it is parked and listed by `pd status` under "Parked tasks" with its id and reason. Fix the cause, then `pd retry <taskId>`.
- **Credit balance errors:** if the Anthropic account runs out of credit, model requests fail with a 400 and the message that triggered them is marked unanswered (an attached session shows `[unanswered: ...]`). Nothing is lost: add credit and send the message again. A loop iteration that fails this way is recorded in the loop's note, and the loop tries again at its next interval.
- **Missing API key:** `pd status` prints a red warning and the daemon logs one at startup. Set `ANTHROPIC_API_KEY` in `~/.config/pi-durable/env` and restart the service (secrets are read at startup; the policy file is not).
- **A PR will not merge:** run `pd audit` or read the comment `pr_merge` left on the PR; it lists every gate that failed.
