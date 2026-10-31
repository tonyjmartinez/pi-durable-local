# pi-durable-local

A small, portable software factory: durable coding-agent sessions that keep running on your machine, built on `pi-durable`. Agents take work from idea to merged PR inside a sandbox, under budgets and merge gates you control. Clone it onto any Linux or WSL box, run `scripts/install.sh`, add one API key, and it runs locally.

One daemon, `pdd`, owns a pi-durable SQLite store at `~/.local/share/pi-durable/state.sqlite`. A small client, `pd`, talks to it over a Unix socket (`~/.local/share/pi-durable/pdd.sock`, mode 0600). Everything lives in the daemon:

- **Named sessions.** Each is a long-running agent conversation with its own working directory and purpose. They survive restarts and crashes; the daemon resumes from the last committed step.
- **A chain of command.** The generals are Opus Claude Code sessions outside pi: you and the agents you drive over Remote Control set goals, approve parked PRs and answer escalations. Pi is the cheap workforce: every reasoning role (sessions, planning, design decisions, the merge review) runs on Sonnet, and Haiku only does tool work (web search and `fast` subagents). Pi never runs Opus. Iterations start with fresh context, keep command output bounded, and are prompted to stop after 12 substantive turns.
- **A ship loop.** Agents open PRs from a template, and a deterministic state machine (`pr_tick`) says what to do next, runs an independent review, and merges low and medium risk changes that pass every gate. Anything riskier waits for you.
- **Loops.** A session can be woken on an interval to push a goal forward, within a dollar budget and an iteration cap. A gate decides in code, before any model runs, whether a tick is worth it.
- **Shared memory.** One durable document that every session reads in its system prompt and writes through `memory_save`, `memory_search`, and `memory_forget`.
- **Cross-session messaging.** `sessions_list` and `session_send` let sessions hand work to each other.
- **Safeguards.** Every agent shell runs in a bubblewrap sandbox with no credentials. The daemon pushes and opens PRs on the agents' behalf, and an audit log records every decision.
- **Phone notifications and a friction log.** The daemon tells you when something needs you, and agents file the papercuts that slowed them down as GitHub issues that other agents fix.
- **Web access.** `web_search` (Anthropic server-side search) and `web_fetch` (public http(s) only; private and local addresses are blocked).
- **A local web UI.** `pd ui` serves a small page on 127.0.0.1 for watching and steering sessions from a phone or desktop.

Why one process: pi-durable has no cross-process locking on its store. Two processes opening the same SQLite file would corrupt each other's state, so exactly one daemon opens it and everything else goes through the socket. The daemon enforces this itself: at startup it connects to the socket first, and if another daemon answers it exits before touching the store, so a stray `npm run daemon` cannot corrupt a running one.

## Install

Requires Linux or WSL, Node 24 or newer, `git`, and the GitHub CLI `gh`. Bubblewrap (`bwrap`) is needed to sandbox agent shells; without it agent commands refuse to run (see Safeguards).

```sh
git clone <this repo> ~/proj/pi-durable-local && cd ~/proj/pi-durable-local
scripts/install.sh              # add --autostart to also start the daemon at login
```

`scripts/install.sh` is idempotent, and skips `npm ci` while the daemon is running so it cannot pull `node_modules` out from under it. It checks the requirements (warning when `gh` or a working `bwrap` is missing), runs `npm ci`, links `pd` and `pdd-up` into `~/.local/bin`, and creates `~/.config/pi-durable/env` (mode 0600, `ANTHROPIC_API_KEY=` blank) if it does not exist. It never prints secrets and only edits `~/.profile` when you pass `--autostart`. `PD_BIN_DIR` and `PD_CONFIG_DIR` override the install locations. CI (`.github/workflows/ci.yml`) runs the typecheck and tests on every PR.

Then:

```sh
$EDITOR ~/.config/pi-durable/env     # set ANTHROPIC_API_KEY=sk-ant-...
gh auth login --git-protocol ssh --web
pdd-up                               # start the daemon under a restart loop (pdd-up stop to stop it)
pd doctor
```

Only `ANTHROPIC_API_KEY` is required. Web search uses Anthropic's server-side search, so there is no search key.

Why not systemd: on WSL, WSLg mounts its own tmpfs over `/run/user/$UID`, which hides the systemd user bus, so `systemctl --user` cannot connect. `bin/pdd-up` is a small supervisor instead: it runs the daemon in its own process group and restarts it 5 seconds after any exit. `pd` also starts it on demand when the socket is missing. A unit file is kept in `systemd/` for machines where the user bus works; its Node path is specific to the author's machine, so edit it before use.

`pd doctor` checks: the API key, the policy file, the supervisor, login autostart, the socket, the store, that the agent sandbox really hides `~/.ssh` and makes `$HOME` read-only, `gh` login, whether phone notifications are configured (`PD_NOTIFY_URL`, with the setup steps if not), and the auto-merge allowlist.

## Daily use

```
pd factory <owner/repo> ["goal"] [--preset product-gardener] [--base main] [--merge] [--name n]
                                          clone, create a session, and (with a goal or preset) start a loop
pd status                                 sessions, loops, spend, parked tasks
pd brief                                  for generals: what needs a decision, then the workforce
pd new <name> --cwd <dir> [--purpose "..."] [--model provider/id]
pd attach <name>                          live view and chat
pd send <name> "message" [--steer]        fire and forget
pd rm <name>                              remove a session (its history stays in the store)
pd ui [--rotate]                          local web UI on 127.0.0.1:7777 (PD_UI_PORT); prints a login link
pd tmux [names...]                        tmux session "pd": status window plus one window per session

pd loop start <session> "goal" [--every 30] [--max 17520] [--budget 100]
pd loop start <session> --preset product-gardener|keep-tests-tight|docs-freshness|legacy-reaper|friction-sweep|code-quality|ci-health
pd loop ls | pause <id> | resume <id> | stop <id>
pd loop set <id> [--every 30] [--max 17520] [--budget 100]

pd mem [search words]                     shared memory
pd mem add "topic" "fact" [--project <dir>]
pd mem rm <id>

pd gates <owner/repo> <pr>                dry-run pr_tick (including the AI review); never merges
pd approve <owner/repo> <pr> <sha7>       approve a parked PR at the commit you reviewed (from the park comment)
pd audit                                  safety decisions and merges
pd retry <taskId>                         rerun a parked task
pd doctor                                 check setup
```

`pd` with no arguments is `pd status`. Session names are letters, digits, `.`, `_`, `-` (max 41 characters). Without `--cwd`, `pd new` uses your current directory.

`pd factory owner/repo` is the quick path to a working project: it clones `git@github.com:owner/repo.git` into the first writable root (`~/proj/<repo>` by default) with git hooks disabled, creates a session named after the repo, and, if you pass a goal or --preset product-gardener, starts a loop. The preset chooses one evidence-based product or developer-experience improvement per half-hour iteration; --merge remains a separate explicit opt-in. `--base` records the branch PRs should target in the policy when the GitHub default is not the deploy branch. `--merge` adds the repo to `automerge.repos`, which allows gated merges there; the command you typed is the approval, and it is audited as `automerge_enabled`. Without `--merge`, PRs in the repo park as `no-merge-authority` until you add it yourself (see Policy).

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

## Chain of command

The generals are Tony and the Opus Claude Code sessions he drives over Remote Control. They sit outside pi, set goals (`pd factory`, `pd loop start`), approve parked PRs, answer `needs-decision` issues, and do what workers cannot: open a real browser, check the live site, add CI, supply secrets. Pi's sessions are the workforce: Sonnet for every reasoning role, with Haiku for tool work.

`pd brief` is the one read a general needs. It lists what only a general can act on (parked PRs with their review verdict and the exact `pd approve` command, paused or failed loops with `pd loop resume`, open `needs-decision` issues across the owner's repos), then the last day's merges and a line per active loop. It is plain text, so a general can read it in one tool call. Workers know the chain of command: they decide reversible things themselves, and when they report `blocked`, the note is a single concrete ask.

## The model ladder

| Role | Policy key | Default |
| --- | --- | --- |
| Session (the agent you attach to) | `model` | `anthropic/claude-sonnet-5-5` |
| Subagent tier `fast` (default) | `subagentModel` | `anthropic/claude-haiku-5-5` |
| Subagent tier `plan` | `planModel` | `anthropic/claude-sonnet-5-5` |
| Subagent tier `deep` | `deepModel` | `anthropic/claude-sonnet-5-5` |
| Independent PR reviewer | `reviewModel` | `anthropic/claude-sonnet-5-5` |
| `web_search` | `searchModel` | `anthropic/claude-haiku-5-5` |

A session delegates with the `subagent` tool: one focused, self-contained task to a cheaper model that works in the same directory under the same sandbox. `fast` is for research, scoped implementation, tests and diagnosing checks; `plan` is for product decisions and deciding what to build next; `deep` is for a big swing or a design decision and requires a `why`, which is written to the audit log with the model used. Subagents cannot push, open or merge PRs, or message other sessions; their parent does that. Their spend counts toward the parent's loop budget.

## The ship loop

Agents never hold GitHub credentials. They commit locally and call tools that the daemon runs with its own login.

**Getting code to GitHub.**
- `git_sync` refreshes the daemon's read-only mirror of the repo's GitHub branches and tells the agent which `git fetch` to run from the mirror, since the agent cannot fetch from GitHub itself.
- `git_push` pushes a work branch. The daemon fetches the branch from the agent's repo into a bare mirror it owns (`~/.local/share/pi-durable/mirrors/<session>.git`), then pushes from the mirror to the remote recorded when the session was created. It never runs git with agent-controlled config or hooks. Branches must start with the work-branch prefix (`pd/` by default), and each branch belongs to the first session that pushes it: another session cannot push or force-push it, so one session cannot rewrite another's PR head. The daemon refuses any push whose diff against the base branch touches `.github/` (audited as `push_refused`), because GitHub runs a workflow file from a pushed branch with the repository's secrets before any review or merge. Agents write a proposed workflow to `docs/proposed-ci/<name>.yml` instead and ask you to install it.
- `pr_create` pushes and opens a PR against the repo's deploy branch. The description must fill the PR template or the call is refused with the template in the error. `pr_edit` replaces the title or body of the agent's own open work-branch PR. `pr_status` and `pr_list` read PRs and CI. `issue_list` and `issue_view` read issues (the text is untrusted), and `issue_close` closes a friction-labelled issue with a comment; it refuses any other issue.

**The PR template** (`src/prtemplate.ts`) has these fields: Intent, Door (`two-way` or `one-way`), Cleanup, Why, Testing (the commands actually run and their results, and what could not be verified), and a System recap with Risk (`low`, `medium`, `high`) and Touches (an area and whether the change `composes`, `extends`, or `adds`).

**`pr_tick` is the only way anything merges.** The agent calls `pr_tick <number>` and does the single action it returns, pushes, and ticks again. The daemon gathers the facts itself from GitHub (CI for the exact head commit, conflicts, review decision, the diff's size and paths, the PR template) and a pure function, `decidePr` in `src/prtick.ts`, picks the next action in this order:

1. Merged: `done` (or `stop` if closed unmerged).
2. Draft: `mark-ready`. Conflicts: `resolve-conflicts`. Behind its base: `update-branch`.
3. A failing or cancelled check: `fix-ci`, unless every failing check comes from outside GitHub Actions (see CI below), in which case `park-human`. A pending check: `wait-ci`.
4. No passing check at all (with `requireChecks`): `park-human`.
5. A reviewer requested changes, there are unresolved review threads (read by the daemon through a read-only GraphQL query), or the independent review rejected this head: `address-review`. If the threads cannot be read, or there are more than 100, the PR parks for a human instead of being treated as having none.
6. Unless a human approved this head: a one-way door, any reason in the PR's "needs a human" list, or a high risk tier: `park-human`.
7. The repo is not in `automerge.repos`, or the head branch lacks the prefix: `no-merge-authority`.
8. No review of this head and description yet: the daemon runs the independent review itself, then decides again.
9. Otherwise: merge.

A PR that would park for a human, and has at least one passing check, is reviewed too, so the review result is attached when it parks. PRs the factory does not own (from a fork, by another author, or on a branch outside the work prefix) are never reviewed, so they cost nothing.

The reasons that always park a PR for a human are: it comes from a fork; its author is not the daemon's own GitHub account; it does not target the deploy branch; it changes more than `maxChangedFiles` files or `maxChangedLines` lines; it touches a protected path (checked on both sides of a rename); its description is missing template fields; its Testing section says nothing was run; or it declares no Door, which counts as one-way.

**Risk tiers.** The diff earns a floor: high for a protected path or more than 400 changed lines; medium for more than 100 lines, a test changed alongside the code it tests, or a config file changed; otherwise low. The agent's declared Risk can only raise it. Low and medium PRs may auto-merge; high always waits for you. Every PR gets the independent review, including one that parks for a human: if it would park and CI has at least one passing check, the daemon reviews it first, so you see the verdict with the park.

**CI.** Only GitHub Actions check runs on the exact head commit count as a pass. Commit statuses and check runs from other apps can block a PR but never pass it, because anyone with a token can post one. Each check name carries its source (`name [app-slug]` for another app's check run, `context [commit status]` for a status). If the only failing checks are from outside GitHub Actions, such as a Cloudflare build that fails on every branch, the agent is not asked to fix them: the PR parks for you with those check names listed. It stays blocked and is never ignored. A failing Actions check next to an external one is still the agent's to fix. All pages of check runs are read, not just the first 100. For 90 seconds after the daemon pushes a commit, the tick adds a synthetic pending check, because right after a push only the fastest workflow may have registered and its green must not be mistaken for all of CI.

**The independent review.** A separate model call (`reviewModel`, Sonnet by default) reads the title, description and diff and replies with a JSON verdict. It is told to treat all three as untrusted data written by the agent under review. The PR text is placed inside a random per-call delimiter the PR cannot forge. The diff is fetched for the exact head commit being keyed (a compare against the base), and if the head, title or description changes while the review runs, the tick fails and reviews again, so a verdict can never be stored for a commit it did not read. A diff over 200,000 characters is rejected as too large to review, never truncated. Conflicting verdicts are a rejection. A reply with no verdict at all is a failed review: the tick errors, nothing is cached, and the next tick retries. The verdict is cached per exact head commit plus a hash of the title and description, so it runs once per state of the PR and runs again after any push or `pr_edit`.

**The merge.** A squash merge (or the configured method) pinned to the head commit that was checked (`--match-head-commit`), with the branch deleted. If the branch moved after the check, the merge fails and the next tick starts over.

**Parking and approving.** When a PR parks, the daemon records it in the audit log and sends a notification, and (for `park-human`) comments on the PR with the reasons and the review verdict. This happens once per head commit and description: a record of parked PRs (keyed like the review cache) stops repeat notifications and comments while the PR sits unchanged, and a push or an edit parks it afresh. The comment and the notification show the short SHA of the head that was reviewed. To approve it, read the PR and run `pd approve owner/repo 54 <sha7>` with that SHA. The command is refused if you omit the SHA, or if the PR's head has moved since (a 409 that tells you to review the new commit), so you can only approve a commit you saw. The approval is pinned to that head, so a later push needs a new one. Approval lifts the human-only limits (risk tier, one-way door, the needs-a-human reasons); it never skips CI, the review, or merge authority.

`pr_merge` is kept for older prompts and behaves exactly like `pr_tick`. To see what the ship loop would do to a real PR without merging, run `pd gates owner/repo 54`: it runs everything, including the AI review, even for a repo that is not allowlisted.

The state machine's `decide()` design, and the idea of one deterministic next action per tick, come from Kent C. Dodds's autopilot system.

## Loops

```sh
pd loop start myproj "Get the test suite green and the docs current" --every 30 --max 10 --budget 3
```

Defaults come from the policy: 30 minutes between iterations, up to 17,520 iterations (a year at that cadence), at most 100 USD per loop, and a shared 1 USD rolling daily cap across all loops.

The half-hour factory uses a shared $1 rolling daily scheduler allowance. `loops.dailyBudgetSince` optionally starts a fresh allowance at an epoch-millisecond timestamp when changing cost policy; it excludes older charges from the scheduler gate only, preserves recorded spending, and does not reset itself. A single running iteration can overshoot the allowance. The 12-turn instruction is a prompt target, not a hard stop.

Product loops now run every 30 minutes. A busy session is checked again in five minutes without submitting another iteration. `loop_report` accepts a compact optional `nextTask` (up to 1,200 characters); fresh iterations receive it so they can implement one bounded slice without replanning the whole project. The shared rolling daily allowance remains $1 and can delay model work once exhausted. Small slices and short handoffs aim to reduce context costs; more subagent calls are not assumed to save money.

Injected project memory is limited to 6,000 characters; records longer than 1,200 characters appear as excerpts with a prompt to retrieve full details using `memory_search`. Stored memory is unchanged. `pd cost` flags long iterations (40+ assistant turns), large individual shell results (over 20,000 characters), and repeated review-bearing calls for the same PR. These are diagnostics, not hard token or spend limits.

Tool execution itself uses ordinary code. Agent decisions, planning, design decisions and independent reviews use Sonnet by default; search and `fast` subagents use Haiku. Web search is bounded to one request, at most two server searches and 4,096 output tokens; paused or token-limited answers are explicitly marked incomplete. Fetch known URLs with `web_fetch` to avoid an additional search-model call.

Lifecycle: `active` while scheduled; `paused` when you pause it, when the budget is reached, or when the agent reports `blocked`; `done` when the goal is achieved, the iteration cap is reached, or you stop it; `failed` if the session disappears. `pd loop resume <id>` reactivates a paused loop with a fresh budget window (subagent spend included); resuming a loop that is already active is refused, unless it is dormant (see below), in which case resume wakes it. A crash in the middle of an iteration resumes that same iteration, waiting on the same submission, instead of starting another. Loops run in the background, so they do not mark the session as busy.

Each iteration orients to memory, Git status, open PRs, CI and prior notes, then chooses one small product improvement. Agents make routine, reversible product decisions themselves and record their reasoning; they ask Tony only for material risks or facts only he can provide. They finish any open PR first with pr_tick; otherwise they implement on a fresh branch, verify the change, open at most one PR, save handoff context, and finish with loop_report (continue, idle, done, or blocked).

### Dormant loops

A loop that has run out of work goes to sleep instead of paying for empty iterations. It happens two ways. The agent reports `idle` (nothing worthwhile left right now), or the daemon sees 3 completed iterations in a row that changed nothing on GitHub. "Nothing" means the same base-branch head, the same open agent PR heads, and the same open issues before and after the iteration. A dormant loop stays `active` (shown as `dormant` in `pd status`), and every 6 hours the gate looks at GitHub without any model call. It wakes when the work fingerprint changes: a new commit on the base branch, a new or updated agent PR, or a new or edited issue. `pd loop resume <id>` wakes it by hand. The audit log records `loop_dormant` and `loop_wake`.

### Product judgment and pi add-ons

Agents choose routine, reversible product improvements from each repository's goals and evidence, then record their reasoning. Human input remains a gate for one-way or materially risky decisions, safety-policy changes, and facts only the owner can provide. This deliberately adapts [KCD's autopilot guidance](https://github.com/kentcdodds/kcd-skills), which keeps product decisions with the human, to the autonomy you requested.

Use repository instruction files for always-needed conventions and focused skills for workflows that are only sometimes needed. This factory calls pi-durable directly; pi-coding-agent add-ons are not automatically compatible. Treat pi packages and extensions as executable code: inspect and pin third-party sources, and install only when a concrete need justifies the extra cost and maintenance. See the official pi documentation for [skills](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md), [extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md), and [packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md).

### The skip gate

Before waking a model, the loop checks GitHub through the daemon's own `gh` (a handful of API calls, no model) and `shouldWake` in `src/loopgate.ts` decides whether the tick is worth it. If not, it records a `loop_skip` audit event, counts a skipped tick, and tries again at a suggested time. An idle repo costs nothing.

- Any loop waits, without a model call, when the agent has open PRs and every one is still running checks (recheck in 5 minutes).
- A `goal` loop (the default) otherwise always wakes.
- A `cleanup` loop wakes on its first run, and afterwards only when the base branch has a new commit since the last run and that commit is within the idle window (`skipIfIdleHours`, default 24).
- A `friction-sweep` loop wakes only when the repo has open issues labelled `friction` that an agent may act on; issues labelled `needs-decision` or `friction-skipped` do not count.
- A `code-quality` loop follows the cleanup rules, and also waits while another awake goal loop (the product loop) works on the same repo, so the two never edit the same files.
- A `ci-health` loop wakes only when the base branch's newest run of a workflow failed, or a workflow failed in more than 20% of its last 10 runs (flaky). It remembers the CI state it last worked on, so the same red commit is not retried every hour.
- Both maintenance kinds yield to product loops once today's spend passes 70% of `dailyBudgetUsd`. A red base branch is the exception.
- A dormant loop wakes only when the repo's work fingerprint has changed since it went to sleep, checked every 6 hours.
- If the gate cannot read the repo, the loop wakes anyway.

### Presets

`pd loop start <session> --preset <name>` starts the product-gardener loop, one of four cleanup automations, or one of two maintenance loops. Each has a brief that tells the agent what to do and to open at most one PR per iteration, or none if there is nothing to do:

| Preset | Kind | Every | What it does |
| --- | --- | --- | --- |
| `product-gardener` | goal | every 30 minutes | chooses one small, evidence-based user or developer value improvement for any repository |
| `keep-tests-tight` | cleanup | daily | removes or rewrites redundant, flaky and implementation-coupled tests while keeping behavior covered |
| `docs-freshness` | cleanup | daily | fixes `AGENTS.md`, README and decision records that recent commits made stale |
| `legacy-reaper` | cleanup | weekly | removes provably dead code, expired flags and finished Cleanup issues |
| `friction-sweep` | friction-sweep | daily | fixes open `friction` issues, highest priority first |
| `code-quality` | code-quality | daily | one behavior-preserving simplification: duplication, overgrown functions, lint and type errors; $5 budget |
| `ci-health` | ci-health | hourly check | fixes a red base branch or a flaky test at its cause; $5 budget |

The `ci-health` loop cannot change CI configuration: `.github/` and test-runner configs are protected, and pushes touching `.github/` are refused. GitHub runs a workflow from a pushed branch, with the repo's secrets, before anyone reviews it. When a fix really is a CI change, the agent writes a proposal to `docs/proposed-ci/` for a human.

Every PR, from any session, is parked for a human if its diff weakens tests: a new `.skip`, `.only`, `xit`, `test.todo`, test-runner retries, `--passWithNoTests`, or a lowered coverage threshold. Maintenance PRs (branches `pd/quality-*` and `pd/ci-*`) also may not delete tests or assertions, or add `@ts-ignore`, `eslint-disable` and the like.

Start a new repository with the generic product loop using `pd factory owner/repo --preset product-gardener`; add `--merge` only when you want gated PRs eligible for automatic merge.

Presets are subject to the same merge gates as any other work. The weekly reaper uses a 7-day idle window; the daily ones use 24 hours.

## Friction log

When something costs an agent real time (a confusing tool, a missing script, a flaky check, a rule that blocked legitimate work), it calls `friction_file`. The issue has what happened, what was wanted, how to reproduce, the cost, what was already tried, and the relevant files, plus a priority from `P0` to `P3` and, when a human must decide, a `needs-decision` label. Agents search the open `friction` issues first and comment on a near-duplicate instead of filing a new one. Credentials in the text are redacted before anything leaves the machine.

`scope: "project"` files on the session's own repo. `scope: "factory"` files on the factory's own repo, taken from this checkout's `origin` remote, so a fork files on the fork (it falls back to `tonyjmartinez/pi-durable-local` if the remote cannot be read).

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
| `reviewModel` | `anthropic/claude-sonnet-5-5` | Model for the independent review |
| `searchModel` | `anthropic/claude-haiku-5-5` | Model that runs `web_search` |
| `subagentModel` | `anthropic/claude-haiku-5-5` | Subagent tier `fast` |
| `planModel` | `anthropic/claude-sonnet-5-5` | Subagent tier `plan` |
| `deepModel` | `anthropic/claude-sonnet-5-5` | Subagent tier `deep` (needs a `why`) |
| `thinkingLevel` | `low` | `off`, `minimal`, `low`, `medium`, or `high` |
| `writableRoots` | `~/proj`, `/tmp` | Where `write`/`edit` are allowed and what the sandbox mounts writable (restart to apply to the sandbox) |
| `automerge.repos` | `[]` | `owner/repo` allowlist for merging |
| `automerge.baseBranches` | `{}` | `owner/repo` to branch PRs target, when the GitHub default is not the deploy branch |
| `automerge.branchPrefix` | `pd/` | Required prefix for agent branches and PR heads |
| `automerge.maxChangedLines` | `600` | Additions plus deletions; over it, the PR parks |
| `automerge.maxChangedFiles` | `25` | Changed files; over it, the PR parks |
| `automerge.protectedPaths` | see below | Globs no automated PR may touch |
| `automerge.requireChecks` | `true` | Need at least one passing GitHub Actions check |
| `automerge.mergeMethod` | `squash` | `squash`, `merge`, or `rebase` |
| `loops.defaultBudgetUsd` | `100` | Per-loop spend cap |
| `loops.dailyBudgetUsd` | `1` | Shared spend cap across all loops in any 24 hours |
| `loops.defaultIntervalMinutes` | `30` | Time between iterations (half an hour) |
| `loops.defaultMaxIterations` | `17520` | Iteration cap (one year at the default cadence) |

Default `protectedPaths`: CI config (`.github`, GitLab, CircleCI), env and key files, `secrets` and `migrations` directories, Dockerfiles, Terraform, dependency manifests and lockfiles for Node (`package.json`, npm, pnpm, yarn and bun lockfiles), Rust (`Cargo.toml`, `Cargo.lock`), Go (`go.mod`, `go.sum`), Python (`requirements*.txt`, `pyproject.toml`, `poetry.lock`, `uv.lock`), Ruby (`Gemfile`, `Gemfile.lock`), PHP (`composer.json`) and JVM (`build.gradle*`, `pom.xml`), Makefiles, test-runner configs, git hooks, `wrangler.*`, `CODEOWNERS`, `.pi`, and `AGENTS.md`. The exact list is `DEFAULT_POLICY` in `src/config.ts`. In globs, `**` spans directories and `*` stays within one. Setting `protectedPaths` replaces the list, it does not extend it.

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

**Web fetches.** `web_fetch` runs in the daemon, outside the sandbox, so it is restricted on its own. It accepts only http and https. Before contacting any host it resolves the name and refuses it if any resulting address is loopback, private, link-local, carrier-grade NAT, multicast, reserved, or an IPv4-mapped IPv6 form of one of those; it also refuses `localhost` and names ending in `.local`, `.internal`, or `.localhost`. Redirects are followed by hand, at most 5, and every hop is checked the same way before it is contacted. Responses are read to at most 2 MB, and a request times out after 30 seconds.

### Limits

- The guard is regex-based and best effort, not a sandbox. With bubblewrap present it is a second layer; without it, it is the only layer.
- `read`, `write`, and `edit` run inside the daemon, not the sandbox; they are covered by the guard's path checks only. `web_fetch` also runs there, with the network checks above.
- The sandbox is Linux-only (bubblewrap). On macOS there is no equivalent yet.
- The review model can be wrong. Merging low and medium risk changes after one model's approval is a deliberate trade for speed; the protected-path list, size limits, CI requirement and risk tiers exist to keep the changes that reach that point small and boring.
- Commit statuses and checks from other apps never count as passing CI, so a repo whose only CI is an external app will park every PR. A failing external check also parks the PR, and there is no way to tell the factory to ignore a known-bad one: you have to fix that check or merge by hand.

### Residual risks

Known gaps that are accepted for now:

- **CI runs agent-written code.** A PR's CI jobs execute whatever the agent wrote, and the factory cannot stop that. Agents cannot push workflow files, but a `pull_request` workflow you installed still runs their code. Keep deploy and other high-value secrets out of `pull_request` jobs: put them in GitHub environments with required reviewers, and give pull-request workflows read-only tokens and no secrets.
- **DNS lookup to connect gap in `web_fetch`.** The check resolves the hostname and then the request resolves it again, so a name that changes its answer between the two (DNS rebinding) can get past the address check. Closing it needs a connection that is pinned to the checked address.
- **The mirror fetch reads the agent's repo.** `git_push` fetches the branch from the agent's working repository, and the git process that serves that fetch reads the repo's own config. Hooks, ssh commands and global config are disabled, and no way to run a command through it is known, but the fetch is not sandboxed.
- **Shared memory is shared.** Every session reads shared memory in its system prompt and any session, including a subagent that has read web pages, can write to it, so one poisoned page could plant instructions for all sessions. Review `pd mem` now and then.
- **The `deep` subagent tier is advisory.** It needs a `why`, which is audited, but nothing checks that the reason is good.
- **The audit log is not rotated.** `pd audit`, the web UI and the friction sweep read only the tail, so it stays fast, but the file grows without limit.
- **A loop iteration has no time limit.** The budget is checked between iterations, so one iteration, including its subagents, can spend more than the budget before the loop pauses.

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
- **"pdd is already running" when starting the daemon by hand:** that is the guard working; use `pdd-up stop` first, or just use the daemon that is running.
- **A push was refused:** the `pd audit` entry `push_refused` lists the paths. A work branch may not change anything under `.github/`; ask the agent to put the proposal in `docs/proposed-ci/` and install it yourself.
- **`pd approve` says the head moved:** the agent pushed after the park comment. Read the new commit and approve with its short SHA.
- **Restart after changing code or secrets:** `pdd-up stop && pdd-up`. Every committed step survives the restart. The policy file and `PD_NOTIFY_URL` are re-read without a restart.
- **Parked tasks:** if a task cannot make progress it is parked and listed by `pd status` under "Parked tasks" with its id and reason. Fix the cause, then `pd retry <taskId>`.
- **Credit balance errors:** if the Anthropic account runs out of credit, model requests fail with a 400 and the message that triggered them is marked unanswered (an attached session shows `[unanswered: ...]`). Nothing is lost: add credit and send the message again. A loop iteration that fails this way is recorded in the loop's note, and the loop tries again at its next interval. Credits bought in the Claude app do not apply to the API; the key needs API credits.
- **Missing API key:** `pd status` prints a red warning and the daemon logs one at startup. Set `ANTHROPIC_API_KEY` in `~/.config/pi-durable/env` and restart (secrets are read at startup).
- **A PR will not merge:** run `pd gates owner/repo <pr>`, or read the comment `pr_tick` left on the PR and `pd audit`; they list what is in the way. `no-merge-authority` means the repo is not in `automerge.repos`.
- **No notifications:** check `PD_NOTIFY_URL` is in the env file and test the URL with `curl`. A rate-limited duplicate is silent by design.
- **Agent commands refuse to run:** bubblewrap is missing or cannot create a sandbox. Install it (`sudo apt install bubblewrap`); on Ubuntu 24.04 and later, user namespaces may be restricted by AppArmor.

## Credits

The autopilot ideas behind this factory, including the PR template, risk tiers, the one-action-per-tick ship loop, the friction log, and the cleanup automations that skip idle repos, come from Kent C. Dodds's [kcd-skills](https://github.com/kentcdodds/kcd-skills) and his "How I Put My Codebase on Autopilot" video. `decidePr` in `src/prtick.ts` is a port of `decide()` from kcd-skills' `ship-pr.mjs`, used under the MIT License (see the header of that file). Built on `pi-durable`.
