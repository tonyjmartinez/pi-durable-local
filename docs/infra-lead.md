# Infrastructure lead

The infra-lead preset inspects repositories with active or paused loops. It gathers recent base-branch workflow results, agent PR check rollups, CI worker coverage and pipeline audit events without calling a model. Unchanged evidence skips the model for up to 12 hours. Near the existing pacing allowance it yields unless a base is red; global queue and budget gates still apply.

The pipeline-scorecard memory appears near the top of pd brief with author and age. It is recorded evidence, not a deployment guarantee. Missing runs, unreadable CI and unreadable PR checks remain explicit; the lead must inspect actual workflows and deployment evidence before claiming a deploy path is covered. A green completed workflow alone does not prove a current in-progress deployment succeeded.

## Operator setup after review and deployment

Use an existing dedicated factory session or create one in an isolated factory checkout using normal pd new procedures. Then opt in with `pd loop start <session> --preset infra-lead`. The preset checks hourly, uses high queue priority (2), and has a $5 total allowance under the existing global rate gates. Installing this code does not start a loop or change policy. Pause or stop it with normal pd loop commands.

The lead has two deferred tools (load via tool_search): pipeline_evidence and ci_dispatch. Dispatch can start a fixed ci-health preset or resume a system-paused ci-health loop, at most three successful actions per rolling 24 hours. The quota is stored transactionally with loop/task creation, independently of audit truncation. Caller authority, target identity, budget and repository duplicates are rechecked at commit. Human pauses and budget-review cuts are preserved. Resumes retain normal pd resume semantics (a fresh worker budget window); dispatch never changes a configured loop budget or priority.

Workflow/secrets/branch-protection changes go to a general or Tony as a concrete proposal. The infra lead cannot merge, approve, modify policy or weaken tests. It must use the existing gates; it is not an alternate deployment path.

## Developer setup

In a fresh isolated Ubuntu worktree, initialize the configured Node with `source ~/.nvm/nvm.sh; nvm use --silent default`, then run `npm ci --no-audit --no-fund`. Install dependencies in each worktree instead of sharing a writable node_modules. No new credentials or special environment variables are needed for the isolated tests. Existing gh authentication is used for real read-only evidence gathering; never copy credentials into the checkout.

Run `npm run typecheck` and `npm test` before opening a PR. A focused pass is `node --test test/infra.test.ts test/infra-tools.test.ts test/brief.test.ts test/queue.test.ts test/loopgate.test.ts`. The tool tests isolate PD_DATA_DIR/PD_CONFIG_DIR and use an in-memory harness: they create no live workers and spend no API money. The broader suite also uses fake gh scripts; allow roughly a minute on this host. Treat an actual failure as evidence, not permission to relax a gate.
