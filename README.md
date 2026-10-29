# pi-durable-local

Durable coding-agent sessions that keep running on your machine, built on `pi-durable`.

One daemon, `pdd`, owns a pi-durable SQLite store at `~/.local/share/pi-durable/state.sqlite`. A small client, `pd`, talks to it over a Unix socket (`~/.local/share/pi-durable/pdd.sock`, mode 0600). Everything lives in the daemon:

- **Named sessions.** Each is a long-running agent conversation with its own working directory and purpose. They survive restarts and crashes; the daemon resumes from the last committed step.
- **Shared memory.** One durable document that every session reads in its system prompt (project-scoped entries only where they apply) and writes through `memory_save`, `memory_search`, and `memory_forget`.
- **Cross-session messaging.** `sessions_list` and `session_send` let sessions hand work to each other.
- **Loops.** A session can be woken on an interval to push a goal forward, within a dollar budget and an iteration cap.
- **Safeguards.** A tool-call guard, a scrubbed shell environment, an audit log, and a gated `pr_merge` tool that is the only way an agent merges anything.
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

Agents cannot run `gh pr merge`. They call the `pr_merge` tool with `repo` (owner/repo) and PR number, which checks every gate below. If any fails, the PR stays open, a comment listing the reasons is posted on it, and the refusal is audited. If all pass, it merges with the configured method, deletes the branch, and pins the merge to the reviewed head commit (`--match-head-commit`).

1. The repo is in `automerge.repos`.
2. The PR is open and not a draft.
3. The base branch is the repo's default branch.
4. The head branch starts with `automerge.branchPrefix`.
5. GitHub reports the PR as mergeable.
6. No reviewer has requested changes.
7. Added plus deleted lines are at most `maxChangedLines`.
8. Changed files are at most `maxChangedFiles`.
9. No changed file matches `protectedPaths`.
10. No check is failing or cancelled.
11. No check is still pending.
12. If `requireChecks` is true, at least one check passed. A repo with no CI is never auto-merged.
13. If `requireAiReview` is true and everything above passed, an independent model (`reviewModel`) reads the PR title, body, and diff (clipped at 200,000 characters) and must approve. Any doubt, unparseable reply, or missing model counts as a rejection.

To enable a repo, add it to the allowlist in `~/.config/pi-durable/policy.json`:

```json
{ "automerge": { "repos": ["you/your-repo"] } }
```

The file is read live, so no restart is needed. The allowlist is empty by default, which means nothing auto-merges anywhere. Only set the keys you want to override; the rest keep their defaults.

## Safeguards

Every tool call in every session passes through the guard before it runs. Blocked calls are returned to the agent as a refusal and written to the audit log.

- **Bash rules.** Blocks: `sudo`; recursive deletes of `/` or a home directory; disk formatting and writes to block devices; fork bombs; piping downloads into a shell or interpreter; `chmod 777 /`; force pushes (except `--force-with-lease`), `--mirror`/`--all`/`--delete`/`--tags` pushes, and remote branch deletion; `--no-verify`; global git config changes; `gh pr merge` and merge API calls; repo administration (`gh repo delete/archive/rename/edit`, `gh secret`, `gh auth`, ssh/gpg keys, releases, workflows, rulesets); mutating `gh api` calls; publishing packages or images; controlling the `pi-durable` service or killing node; editing crontab.
- **Pushes.** `git push` must name a branch explicitly, and that branch must start with the work prefix. Bare `git push`, `HEAD`, and `main` are refused.
- **Secret paths.** No read or write of `~/.ssh`, `~/.config/pi-durable`, `~/.config/gh`, `~/.pi/agent/auth.json`, `~/.aws`, `~/.gnupg`, `~/.npmrc`, `~/.netrc`, `~/.git-credentials`, or `gh auth token`. Reading `.env` files with common tools is blocked.
- **Writes.** `write` and `edit` only inside `writableRoots` (default `~/proj` and `/tmp`), never `.env` files (`.env.example` is fine), never `.git` internals.
- **Scrubbed environment.** The daemon loads the env file into its own process for the model providers. Agent shells get the daemon's environment minus any variable whose name contains KEY, TOKEN, SECRET, PASSWORD, CREDENTIAL, or AUTH. `gh` keeps its own login in `~/.config/gh`.
- **Audit log.** Blocks, merges, refusals, merge errors, loop events, and daemon-reported errors are appended to `~/.local/share/pi-durable/audit.jsonl`. `pd audit` shows the last 200 entries.

### Limits

The bash guard is pattern matching on the command text. It is best effort, not a sandbox. A determined or confused agent can write a command that no pattern anticipates (a script file that does the forbidden thing, an encoded command, an unusual tool). Treat the guard as a seatbelt that catches common mistakes.

The real backstops are structural:

- No secrets are in the agent's environment, and the guard blocks the files that hold them (this is also pattern based, but the secrets are not in the shell to begin with).
- Pushes go only to `pd/` branches, so main is never written directly by the agent.
- Merges happen only through the gated `pr_merge` tool.

Add GitHub branch protection on `main` for every repo agents work in: require pull requests and require passing CI. That makes the server enforce what the guard only checks locally. Agents run as your user with your `gh` login, so anything that login can do is within reach of a guard bypass; use a repo-scoped or limited token if you want a smaller blast radius.

## Policy file reference

`~/.config/pi-durable/policy.json` is created with defaults on first start and re-read on every use. Partial files are fine; `automerge` and `loops` merge key by key with the defaults. If the file fails to parse, the defaults are used.

| Field | Default | Meaning |
| --- | --- | --- |
| `model` | `anthropic/claude-opus-5-5` | Default model for new sessions (`provider/modelId`) |
| `reviewModel` | `anthropic/claude-opus-5-5` | Model for the AI review gate |
| `searchModel` | `anthropic/claude-opus-5-5` | Model that runs `web_search` |
| `thinkingLevel` | `medium` | `off`, `minimal`, `low`, `medium`, or `high` |
| `writableRoots` | `~/proj`, `/tmp` | Where `write` and `edit` are allowed |
| `automerge.repos` | `[]` | `owner/repo` allowlist for `pr_merge` |
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

Default `protectedPaths`: `.github/**`, `**/.env*`, `**/*.pem`, `**/*.key`, `**/secrets/**`, `**/migrations/**`, `**/Dockerfile`, `**/*.tf`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `CODEOWNERS`, `.pi/**`, `AGENTS.md`. In globs, `**` spans directories and `*` stays within one. Setting `protectedPaths` replaces the list, it does not extend it.

`model`, `thinkingLevel`, and `writableRoots` apply to new sessions and to guard checks as they happen. Change a running session's model with `/model` in `pd attach`.

## Troubleshooting

- **Logs:** `tail -f ~/.local/share/pi-durable/pdd.log`
- **"pdd is not running":** `pdd-up`, then `pd doctor`.
- **Restart after changing code or secrets:** `pdd-up stop && pdd-up`. Every committed step survives the restart.
- **Parked tasks:** if a task cannot make progress it is parked and listed by `pd status` under "Parked tasks" with its id and reason. Fix the cause, then `pd retry <taskId>`.
- **Credit balance errors:** if the Anthropic account runs out of credit, model requests fail with a 400 and the message that triggered them is marked unanswered (an attached session shows `[unanswered: ...]`). Nothing is lost: add credit and send the message again. A loop iteration that fails this way is recorded in the loop's note, and the loop tries again at its next interval.
- **Missing API key:** `pd status` prints a red warning and the daemon logs one at startup. Set `ANTHROPIC_API_KEY` in `~/.config/pi-durable/env` and restart the service (secrets are read at startup; the policy file is not).
- **A PR will not merge:** run `pd audit` or read the comment `pr_merge` left on the PR; it lists every gate that failed.
