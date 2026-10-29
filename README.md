# pi-durable-local

A small, portable software factory: durable coding-agent sessions that keep running on your machine, built on `pi-durable`. Agents take work from idea to merged PR inside a sandbox, under budgets and merge gates you control. Clone it onto any Linux or WSL box, run `scripts/install.sh`, add one API key, and it runs locally.

One daemon, `pdd`, owns a pi-durable SQLite store at `~/.local/share/pi-durable/state.sqlite`. A small client, `pd`, talks to it over a Unix socket (`~/.local/share/pi-durable/pdd.sock`, mode 0600). Everything lives in the daemon:

- **Named sessions.** Each is a long-running agent conversation with its own working directory and purpose. They survive restarts and crashes; the daemon resumes from the last committed step.
- **A model ladder.** Sessions run on Sonnet; cheap work is delegated to Haiku subagents; Opus is reserved for review and a few audited big decisions.
- **A ship loop.** Agents open PRs from a template, and a deterministic state machine (`pr_tick`) says what to do next, runs an independent review, and merges low and medium risk changes that pass every gate. Anything riskier waits for you.
- **Loops.** A session can be woken on an interval to push a goal forward, within a dollar budget and an iteration cap. A gate decides in code, before any model runs, whether a tick is worth it.
- **Shared memory.** One durable document that every session reads in its system prompt and writes through `memory_save`, `memory_search`, and `memory_forget`.
- **Cross-session messaging.** `sessions_list` and `session_send` let sessions hand work to each other.
- **Safeguards.** Every agent shell runs in a bubblewrap sandbox with no credentials. The daemon pushes and opens PRs on the agents' behalf, and an audit log records every decision.
- **Phone notifications and a friction log.** The daemon tells you when something needs you, and agents file the papercuts that slowed them down as GitHub issues that other agents fix.
- **Web access.** `web_search` (Anthropic server-side search) and `web_fetch` (public http(s) only; private and local addresses are blocked).
- **A local web UI.** `pd ui` serves a small page on 127.0.0.1 for watching and steering sessions from a phone or desktop.

Why one process: pi-durable has no cross-process locking on its store. Two processes opening the same SQLite file would corrupt each other's state, so exactly one daemon opens it and everything else goes through the socket.

## Install

Requires Linux or WSL, Node 24 or newer, `git`, and the GitHub CLI `gh`. Bubblewrap (`bwrap`) is needed to sandbox agent shells; without it agent commands refuse to run (see Safeguards).

```sh
git clone <this repo> ~/proj/pi-durable-local && cd ~/proj/pi-durable-local
scripts/install.sh              # add --autostart to also start the daemon at login
```

`scripts/install.sh` is idempotent. It checks the requirements (warning when `gh` or a working `bwrap` is missing), runs `npm ci`, links `pd` and `pdd-up` into `~/.local/bin`, and creates `~/.config/pi-durable/env` (mode 0600, `ANTHROPIC_API_KEY=` blank) if it does not exist. It never prints secrets and only edits `~/.profile` when you pass `--autostart`. `PD_BIN_DIR` and `PD_CONFIG_DIR` override the install locations.

Then:

```sh
$EDITOR ~/.config/pi-durable/env     # set ANTHROPIC_API_KEY=sk-ant-...
gh auth login --git-protocol ssh --web
pdd-up                               # start the daemon under a restart loop (pdd-up stop to stop it)
pd doctor
```

Only `ANTHROPIC_API_KEY` is required. Web search uses Anthropic's server-side search, so there is no search key.

Why not systemd: on WSL, WSLg mounts its own tmpfs over `/run/user/$UID`, which hides the systemd user bus, so `systemctl --user` cannot connect. `bin/pdd-up` is a small supervisor instead: it runs the daemon in its own process group and restarts it 5 seconds after any exit. `pd` also starts it on demand when the socket is missing. A unit file is kept in `systemd/` for machines where the user bus works; its Node path is specific to the author's machine, so edit it before use.

`pd doctor` checks: the API key, the policy file, the supervisor, login autostart, the socket, the store, that the agent sandbox really hides `~/.ssh` and makes `$HOME` read-only, `gh` login, and the auto-merge allowlist.

## Daily use

```
pd factory <owner/repo> ["goal"] [--base main] [--every 60] [--max 24] [--budget 5] [--name n]
                                          clone, create a session, and (with a goal) start a loop
pd status                                 sessions, loops, spend, parked tasks
pd new <name> --cwd <dir> [--purpose "..."] [--model provider/id]
pd attach <name>                          live view and chat
pd send <name> "message" [--steer]        fire and forget
pd rm <name>                              remove a session (its history stays in the store)
pd ui [--rotate]                          local web UI on 127.0.0.1:7777 (PD_UI_PORT); prints a login link
pd tmux [names...]                        tmux session "pd": status window plus one window per session

pd loop start <session> "goal" [--every 60] [--max 24] [--budget 5]
pd loop start <session> --preset keep-tests-tight|docs-freshness|legacy-reaper|friction-sweep
pd loop ls | pause <id> | resume <id> | stop <id>
pd loop set <id> [--every 60] [--max 24] [--budget 5]

pd mem [search words]                     shared memory
pd mem add "topic" "fact" [--project <dir>]
pd mem rm <id>

pd gates <owner/repo> <pr>                dry-run pr_tick (including the AI review); never merges
pd approve <owner/repo> <pr>              approve a parked PR's current head commit
pd audit                                  safety decisions and merges
pd retry <taskId>                         rerun a parked task
pd doctor                                 check setup
```

`pd` with no arguments is `pd status`. Session names are letters, digits, `.`, `_`, `-` (max 41 characters). Without `--cwd`, `pd new` uses your current directory.

`pd factory owner/repo` is the quick path to a working project: it clones `git@github.com:owner/repo.git` into the first writable root (`~/proj/<repo>` by default) with git hooks disabled, creates a session named after the repo, and, if you pass a goal, starts a loop. `--base` records the branch PRs should target in the policy when the GitHub default is not the deploy branch. It does not add the repo to the auto-merge allowlist; do that yourself (see Policy).

Inside `pd attach`, plain text is sent as a message (queued if the agent is busy). Slash commands:

- `/steer <msg>` interrupts the current run with a message
- `/abort` aborts the current run
- `/reset [note]` resets context, optionally with a handoff note
- `/compact` compacts context
- `/model <provider/id>` switches model
- `/quit` (or Ctrl-C) detaches

Detaching never stops the agent. Sessions also see the project's `AGENTS.md` or `CLAUDE.md` (first 12,000 characters) in their prompt.

### The web UI

`pd ui` starts `bin/pd-ui`, which listens on 127.0.0.1 only (port `PD_UI_PORT`, default 7777) and prints a login link with a random token. The token lives in `~/.local/share/pi-durable/ui-token` (mode 0600); `pd ui --rotate` deletes it so old links stop working. The page shows sessions with a busy indicator, cost and model, a live transcript with send, steer and abort, the loops (start, pause, resume, stop), shared memory, and the audit log. It is one self-contained page with no external scripts, laid out for a phone.

It is a proxy to the daemon's socket, not a second owner of the store: only an allowlist of daemon routes is reachable, every request needs the token, writes also need the token as a header (a cookie alone is refused), and the `Host` and `Origin` headers are checked. The Host check blocks DNS rebinding, but the UI is still meant for the local machine: to reach it from a phone, use an SSH tunnel or a private network, not a public interface.

## The model ladder

| Role | Policy key | Default |
| --- | --- | --- |
| Session (the agent you attach to) | `model` | `anthropic/claude-sonnet-5-5` |
| Subagent tier `fast` (default) | `subagentModel` | `anthropic/claude-haiku-5-5` |
| Subagent tier `plan` | `planModel` | `anthropic/claude-sonnet-5-5` |
| Subagent tier `deep` | `deepModel` | `anthropic/claude-opus-5-5` |
| Independent PR reviewer | `reviewModel` | `anthropic/claude-opus-5-5` |
| `web_search` | `searchModel` | `anthropic/claude-opus-5-5` |

A session delegates with the `subagent` tool: one focused, self-contained task to a cheaper model that works in the same directory under the same sandbox. `fast` is for research, scoped implementation, tests and diagnosing checks; `plan` is for product decisions and deciding what to build next; `deep` is for a big swing or a design decision and requires a `why`, which is written to the audit log with the model used. Subagents cannot push, open or merge PRs, or message other sessions; their parent does that. Their spend counts toward the parent's loop budget.

## The ship loop

Agents never hold GitHub credentials. They commit locally and call tools that the daemon runs with its own login.

**Getting code to GitHub.**
- `git_sync` refreshes the daemon's read-only mirror of the repo's GitHub branches and tells the agent which `git fetch` to run from the mirror, since the agent cannot fetch from GitHub itself.
- `git_push` pushes a work branch. The daemon fetches the branch from the agent's repo into a bare mirror it owns (`~/.local/share/pi-durable/mirrors/<session>.git`), then pushes from the mirror to the remote recorded when the session was created. It never runs git with agent-controlled config or hooks. Branches must start with the work-branch prefix (`pd/` by default).
- `pr_create` pushes and opens a PR against the repo's deploy branch. The description must fill the PR template or the call is refused with the template in the error. `pr_edit` replaces the title or body of the agent's own open work-branch PR. `pr_status` and `pr_list` read PRs and CI.

**The PR template** (`src/prtemplate.ts`) has these fields: Intent, Door (`two-way` or `one-way`), Cleanup, Why, Testing (the commands actually run and their results, and what could not be verified), and a System recap with Risk (`low`, `medium`, `high`) and Touches (an area and whether the change `composes`, `extends`, or `adds`).

**`pr_tick` is the only way anything merges.** The agent calls `pr_tick <number>` and does the single action it returns, pushes, and ticks again. The daemon gathers the facts itself from GitHub (CI for the exact head commit, conflicts, review decision, the diff's size and paths, the PR template) and a pure function, `decidePr` in `src/prtick.ts`, picks the next action in this order:

1. Merged: `done` (or `stop` if closed unmerged).
2. Draft: `mark-ready`. Conflicts: `resolve-conflicts`. Behind its base: `update-branch`.
3. A failing or cancelled check: `fix-ci`. A pending check: `wait-ci`.
4. No passing check at all (with `requireChecks`): `park-human`.
5. A reviewer requested changes, or the independent review rejected this head: `address-review`.
6. Unless a human approved this head: a one-way door, any reason in the PR's "needs a human" list, or a high risk tier: `park-human`.
7. The repo is not in `automerge.repos`, or the head branch lacks the prefix: `no-merge-authority`.
8. No review of this head and description yet: the daemon runs the independent review itself, then decides again.
9. Otherwise: merge.

The reasons that always park a PR for a human are: it comes from a fork; its author is not the daemon's own GitHub account; it does not target the deploy branch; it changes more than `maxChangedFiles` files or `maxChangedLines` lines; it touches a protected path (checked on both sides of a rename); its description is missing template fields; its Testing section says nothing was run; or it declares no Door, which counts as one-way.

**Risk tiers.** The diff earns a floor: high for a protected path or more than 400 changed lines; medium for more than 100 lines, a test changed alongside the code it tests, or a config file changed; otherwise low. The agent's declared Risk can only raise it. Low and medium PRs may auto-merge; high always waits for you. Every PR that reaches the merge step gets the independent review, including a high-risk one you approved; a PR that parks first is not reviewed until then.

**CI.** Only GitHub Actions check runs on the exact head commit count as a pass. Commit statuses and check runs from other apps can block a PR but never pass it, because anyone with a token can post one.

**The independent review.** A separate Opus call (`reviewModel`) reads the title, description and diff and replies with a JSON verdict. It is told to treat all three as untrusted data written by the agent under review. Conflicting, unparseable or missing verdicts are rejections. The verdict is cached per exact head commit plus a hash of the title and description, so it runs once per state of the PR and runs again after any push or `pr_edit`.

**The merge.** A squash merge (or the configured method) pinned to the head commit that was checked (`--match-head-commit`), with the branch deleted. If the branch moved after the check, the merge fails and the next tick starts over.

**Parking and approving.** When a PR parks for a human, the daemon records it in the audit log, sends a notification, and (for `park-human`) comments on the PR with the reasons. To approve it, read the PR and run `pd approve owner/repo 54`. The approval is pinned to the head SHA you saw, so a later push needs a new one. Approval lifts the human-only limits (risk tier, one-way door, the needs-a-human reasons); it never skips CI, the review, or merge authority.

`pr_merge` is kept for older prompts and behaves exactly like `pr_tick`. To see what the ship loop would do to a real PR without merging, run `pd gates owner/repo 54`: it runs everything, including the AI review, even for a repo that is not allowlisted.

The state machine's `decide()` design, and the idea of one deterministic next action per tick, come from Kent C. Dodds's autopilot system.

## Loops

```sh
pd loop start myproj "Get the test suite green and the docs current" --every 30 --max 10 --budget 3
```

Defaults come from the policy: 60 minutes between iterations, 24 iterations, 5 USD. Spend is the session's cost since the loop started, including its subagents. `pd loop set <id>` changes the interval (5 minutes or more), the iteration cap, or the budget of an existing loop; a new interval applies after the iteration already scheduled.

Lifecycle: `active` while scheduled; `paused` when you pause it, when the budget is reached, or when the agent reports `blocked`; `done` when the goal is achieved, the iteration cap is reached, or you stop it; `failed` if the session disappears. `pd loop resume <id>` reactivates a paused loop with a fresh budget window. Loops run in the background, so they do not mark the session as busy.

Each iteration sends the session a prompt that tells it to orient (memory, git status, open PRs, CI, the last iteration's notes); finish any open PR of its own first with the `pr_tick` loop; otherwise take the next step, which may be planning early on or implementation on a fresh `pd/...` branch with tests, opened as a PR; save what the next iteration needs with `memory_save`; and end by calling `loop_report` with `continue`, `done`, or `blocked` and a one-line note. `blocked` pauses the loop until you resume it and sends a notification.

### The skip gate

Before waking a model, the loop checks GitHub through the daemon's own `gh` (a handful of API calls, no model) and `shouldWake` in `src/loopgate.ts` decides whether the tick is worth it. If not, it records a `loop_skip` audit event, counts a skipped tick, and tries again at a suggested time. An idle repo costs nothing.

- Any loop waits, without a model call, when the agent has open PRs and every one is still running checks (recheck in 5 minutes).
- A `goal` loop (the default) otherwise always wakes.
- A `cleanup` loop wakes on its first run, and afterwards only when the base branch has a new commit since the last run and that commit is within the idle window (`skipIfIdleHours`, default 24).
- A `friction-sweep` loop wakes only when the repo has open issues labelled `friction`.
- If the gate cannot read the repo, the loop wakes anyway.

### Presets

`pd loop start <session> --preset <name>` starts one of four cleanup automations. Each has a brief that tells the agent what to do and to open at most one PR per iteration, or none if there is nothing to do:

| Preset | Kind | Every | What it does |
| --- | --- | --- | --- |
| `keep-tests-tight` | cleanup | daily | removes or rewrites redundant, flaky and implementation-coupled tests while keeping behavior covered |
| `docs-freshness` | cleanup | daily | fixes `AGENTS.md`, README and decision records that recent commits made stale |
| `legacy-reaper` | cleanup | weekly | removes provably dead code, expired flags and finished Cleanup issues |
| `friction-sweep` | friction-sweep | daily | fixes open `friction` issues, highest priority first |

Presets are subject to the same merge gates as any other work. The weekly reaper uses a 7-day idle window; the daily ones use 24 hours.

## Friction log

When something costs an agent real time (a confusing tool, a missing script, a flaky check, a rule that blocked legitimate work), it calls `friction_file`. The issue has what happened, what was wanted, how to reproduce, the cost, what was already tried, and the relevant files, plus a priority from `P0` to `P3` and, when a human must decide, a `needs-decision` label. Agents search the open `friction` issues first and comment on a near-duplicate instead of filing a new one. Credentials in the text are redacted before anything leaves the machine.

`scope: "project"` files on the session's own repo. `scope: "factory"` files on the factory's repo, set by `FACTORY_REPO` in `src/extensions.ts` (currently `tonyjmartinez/pi-durable-local`; change it if you fork this).

Every six hours the daemon also sweeps its own audit log. A guard rule that blocked the same thing three or more times in 24 hours, across sessions, becomes a friction issue on the factory repo marked `needs-decision`, since the rules are yours to change. A `friction-sweep` loop then picks up the rest.

## Notifications

The daemon can tell you when something needs you: a PR merged, a PR parked for a human, a loop reported `blocked`, a loop hit its budget, or `pr_tick` failed. Set `PD_NOTIFY_URL` in `~/.config/pi-durable/env`. It is a secret, so it belongs there and not in the policy file. It is read on every event, so no restart is needed.

To get them on a phone with ntfy:

1. Install the ntfy app (iOS or Android) and subscribe to a topic with a long random name, such as `pd-` followed by 16 random characters. Anyone who knows the topic name can read and post to it.
2. Add `PD_NOTIFY_URL=https://ntfy.sh/<your-topic>` to the env file.
3. Test it: `curl -d "hello" https://ntfy.sh/<your-topic>` should show up on the phone.

The target is detected from the URL. `ntfy.sh` and `ntfy.*` hosts get a plain-text post with title, priority and tags headers and the PR link as the click target; Discord webhooks get a message with mentions disabled; any other URL gets a JSON post. Messages are scrubbed of anything that looks like a credential, an identical event is sent at most once per 10 minutes (kept in the daemon's memory, so a restart forgets it), requests time out after 5 seconds, and a failure is never fatal and never repeats the URL.

## Policy

`~/.config/pi-durable/policy.json` is created with defaults on first start and re-read on every use. Partial files are fine; `automerge` and `loops` merge key by key with the defaults. If the file fails to parse, the defaults are used.

To let the ship loop merge in a repo, add it to the allowlist:

```json
{ "automerge": { "repos": ["you/your-repo"] } }
```

The allowlist is empty by default, which means nothing auto-merges anywhere: PRs park with `no-merge-authority`. On a repo where you can, also enable branch protection on the deploy branch (require PRs and passing CI) so GitHub enforces it server-side; on private repos without GitHub Pro that is unavailable, and these gates are the only thing between an agent's PR and the deploy branch.

| Field | Default | Meaning |
| --- | --- | --- |
| `model` | `anthropic/claude-sonnet-5-5` | Default model for new sessions (`provider/modelId`) |
| `reviewModel` | `anthropic/claude-opus-5-5` | Model for the independent review |
| `searchModel` | `anthropic/claude-opus-5-5` | Model that runs `web_search` |
| `subagentModel` | `anthropic/claude-haiku-5-5` | Subagent tier `fast` |
| `planModel` | `anthropic/claude-sonnet-5-5` | Subagent tier `plan` |
| `deepModel` | `anthropic/claude-opus-5-5` | Subagent tier `deep` (needs a `why`) |
| `thinkingLevel` | `medium` | `off`, `minimal`, `low`, `medium`, or `high` |
| `writableRoots` | `~/proj`, `/tmp` | Where `write`/`edit` are allowed and what the sandbox mounts writable (restart to apply to the sandbox) |
| `automerge.repos` | `[]` | `owner/repo` allowlist for merging |
| `automerge.baseBranches` | `{}` | `owner/repo` to branch PRs target, when the GitHub default is not the deploy branch |
| `automerge.branchPrefix` | `pd/` | Required prefix for agent branches and PR heads |
| `automerge.maxChangedLines` | `600` | Additions plus deletions; over it, the PR parks |
| `automerge.maxChangedFiles` | `25` | Changed files; over it, the PR parks |
| `automerge.protectedPaths` | see below | Globs no automated PR may touch |
| `automerge.requireChecks` | `true` | Need at least one passing GitHub Actions check |
| `automerge.requireAiReview` | `true` | Not read by the ship loop, which always runs the review; kept for compatibility |
| `automerge.mergeMethod` | `squash` | `squash`, `merge`, or `rebase` |
| `loops.defaultBudgetUsd` | `5` | Per-loop spend cap |
| `loops.defaultIntervalMinutes` | `60` | Time between iterations |
| `loops.defaultMaxIterations` | `24` | Iteration cap |

Default `protectedPaths`: CI config (`.github`, GitLab, CircleCI), env and key files, `secrets` and `migrations` directories, Dockerfiles, Terraform, every `package.json` and lockfile, Makefiles, test-runner configs, git hooks, `wrangler.*`, `CODEOWNERS`, `.pi`, and `AGENTS.md`. The exact list is `DEFAULT_POLICY` in `src/config.ts`. In globs, `**` spans directories and `*` stays within one. Setting `protectedPaths` replaces the list, it does not extend it.

`model`, `thinkingLevel`, and `writableRoots` apply to new sessions and to guard checks as they happen. Change a running session's model with `/model` in `pd attach`.

### Environment variables

| Variable | Where | Meaning |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | env file | Required |
| `PD_NOTIFY_URL` | env file | Notification webhook (see Notifications) |
| `PD_CONFIG_DIR`, `PD_DATA_DIR`, `PD_SOCKET` | environment | Move the config directory, the data directory, or the socket |
| `PD_UI_PORT` | environment | Port for `pd ui` (default 7777) |
| `PD_ALLOW_UNSANDBOXED` | daemon environment | Run agent commands without bubblewrap (not recommended) |
| `PD_BIN_DIR` | environment | Where `scripts/install.sh` links `pd` and `pdd-up` |

## Safeguards

**The sandbox (structural).** Every agent shell command runs through `bin/agent-shell`, which is bash inside bubblewrap:

- Credentials and daemon state are hidden behind empty tmpfs mounts: `~/.ssh`, `~/.config/pi-durable`, `~/.config/gh`, `~/.local/share/pi-durable`, `~/.claude*`, `~/.pi`, `~/.aws`, `~/.gnupg`, `~/.docker`, `~/.kube`, gcloud config, `~/.npmrc`, `~/.netrc`, `~/.git-credentials`, `~/.pypirc`, and `/run/user` (so agents can't reach other local sockets). The daemon's bare mirrors are mounted back read-only so `git_sync` works.
- `$HOME` is read-only except the writable roots (`~/proj` by default), `/tmp`, and package caches. This repo, the daemon's own code and guard, is read-only even though it sits under `~/proj`, so agents can't edit their own rules or add shell-startup persistence.
- A private PID namespace: other processes, including the daemon and its environment, are invisible.
- `gh` in an agent shell sees an empty config directory, so it has no GitHub credentials. Environment variables that look like secrets are removed from the agent's environment.
- The network stays on for package installs and docs.
- If bubblewrap is missing, agent commands refuse to run unless `PD_ALLOW_UNSANDBOXED=1` is set for the daemon.

**The guard (defense in depth).** Every tool call also passes a pattern-based guard first; blocks are returned to the agent and audited. It blocks `sudo`, destructive deletes, disk tools, running downloaded code, force, mirror and delete pushes, pushes to anything but `origin` `pd/...`, git aliases and remote changes, `--no-verify`, all `gh` writes (`pr merge|review|edit`, `api` with any method other than GET, `api graphql`, `alias`, `config`, `auth`, repository administration), publishing, touching the daemon, and secret paths named directly or by directory fragment. `read`, `write`, and `edit` resolve symlinks before checking, are confined to the writable roots, and never touch `.env` files or `.git` internals.

**The audit log.** Blocks, pushes, PRs, reviews, merges, parks, refusals, gate dry runs, subagent calls, loop events and skips, friction filings, and daemon errors are appended to `~/.local/share/pi-durable/audit.jsonl` (mode 0600). `pd audit` shows the latest, and the web UI has a filterable view.

### Limits

- The guard is regex-based and best effort, not a sandbox. With bubblewrap present it is a second layer; without it, it is the only layer.
- `read`, `write`, `edit`, and `web_fetch` run inside the daemon, not the sandbox; they are covered by the guard's path checks only.
- The sandbox is Linux-only (bubblewrap). On macOS there is no equivalent yet.
- The review model can be wrong. Merging low and medium risk changes after one model's approval is a deliberate trade for speed; the protected-path list, size limits, CI requirement and risk tiers exist to keep the changes that reach that point small and boring.
- Commit statuses and checks from other apps never count as passing CI, so a repo whose only CI is an external app will park every PR.

## Development

```sh
npm test            # node --test test/*.test.ts
npm run typecheck   # tsc --noEmit
```

| File | What it holds |
| --- | --- |
| `src/daemon.ts` | The daemon: harness, HTTP routes on the Unix socket, loops, the six-hourly friction sweep |
| `src/client.ts` | The `pd` command |
| `src/extensions.ts` | Agent tools (memory, sessions, web, git, PRs, friction, loops, subagents), the context prompt, the guard hook, the merge machinery |
| `src/guard.ts` | The pure safety policy for tool calls |
| `src/prtemplate.ts`, `src/prtick.ts` | PR template parser and risk floor; the pure `decidePr` state machine |
| `src/loopgate.ts` | The skip gate and the cleanup presets |
| `src/friction.ts`, `src/notify.ts`, `src/redact.ts` | Friction issues and duplicate detection; webhook notifications; credential redaction |
| `src/web.ts`, `src/web/index.html` | The local web UI server and its page |
| `src/config.ts`, `src/state.ts` | Paths, the policy, secrets loading; durable documents, the audit log, notification mapping |
| `bin/` | `pd`, `pdd-up` (supervisor), `pd-ui`, `agent-shell` (the sandbox) |

The pure modules (guard, template, tick, gate, friction, notify, redact) are covered by tests that need no model, network, or GitHub.

## Troubleshooting

- **Logs:** `tail -f ~/.local/share/pi-durable/pdd.log`
- **"pdd is not running":** `pdd-up`, then `pd doctor`.
- **Restart after changing code or secrets:** `pdd-up stop && pdd-up`. Every committed step survives the restart. The policy file and `PD_NOTIFY_URL` are re-read without a restart.
- **Parked tasks:** if a task cannot make progress it is parked and listed by `pd status` under "Parked tasks" with its id and reason. Fix the cause, then `pd retry <taskId>`.
- **Credit balance errors:** if the Anthropic account runs out of credit, model requests fail with a 400 and the message that triggered them is marked unanswered (an attached session shows `[unanswered: ...]`). Nothing is lost: add credit and send the message again. A loop iteration that fails this way is recorded in the loop's note, and the loop tries again at its next interval. Credits bought in the Claude app do not apply to the API; the key needs API credits.
- **Missing API key:** `pd status` prints a red warning and the daemon logs one at startup. Set `ANTHROPIC_API_KEY` in `~/.config/pi-durable/env` and restart (secrets are read at startup).
- **A PR will not merge:** run `pd gates owner/repo <pr>`, or read the comment `pr_tick` left on the PR and `pd audit`; they list what is in the way. `no-merge-authority` means the repo is not in `automerge.repos`.
- **No notifications:** check `PD_NOTIFY_URL` is in the env file and test the URL with `curl`. A rate-limited duplicate is silent by design.
- **Agent commands refuse to run:** bubblewrap is missing or cannot create a sandbox. Install it (`sudo apt install bubblewrap`); on Ubuntu 24.04 and later, user namespaces may be restricted by AppArmor.

## Credits

The autopilot ideas behind this factory, including the PR template, risk tiers, the one-action-per-tick ship loop, the friction log, and the cleanup automations that skip idle repos, come from Kent C. Dodds's [kcd-skills](https://github.com/kentcdodds/kcd-skills) and his "How I Put My Codebase on Autopilot" video. `decidePr` in `src/prtick.ts` is a port of `decide()` from kcd-skills' `ship-pr.mjs`, used under the MIT License (see the header of that file). Built on `pi-durable`.
