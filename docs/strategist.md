# Product strategist and venture scout: a factory that never runs out of ideas

Owner decisions, made by the general on Tony's behalf (2026-11-01). Tony said: "make your own decision on all that".

## Problem (evidence from the audit log, 2026-10-29 to 11-01)

- 41 loop reports ended `idle`. Product and design loops (L31, L32, L37, L39, L40) went dormant in the same minute they started: "Roadmap fully ticked", "backlog exhausted", "no evidence-backed small change".
- The product-gardener prompt tells them to stop: "If no worthwhile small change is supported by evidence, do no code work and report that." The design prompt says "do not invent a new one".
- The biggest wins (pixel-art overhaul L18, succulents readability L17) came from owner-written briefs. Execution works. Direction is what is missing.
- Owner decisions got lost. tonyjmartinez#38 was titled "needs-decision:" but had no `needs-decision` label, so `pd brief` never showed it. Hardwood-box waited two days on BALLDONTLIE_API_KEY, which only existed in loop notes.

## Principle

Idle is never a final state. When a builder runs out of work, that triggers ideation. Ideas flow without stopping. Only one-way doors wait for Tony.

```
venture scout (portfolio)  -> pitches for NEW projects -> Tony approves -> pd factory
product strategist (repo)  -> IDEAS.md bank -> ROADMAP.md (two-way, auto) / proposal issue (big bets, Tony)
product + design loops     -> build the roadmap; when it is empty, wake the strategist instead of going dormant
devils-advocate            -> audits the strategist's outcomes too (outcomes lens)
```

All roles use Sonnet. pi never runs Opus.

## Slice 1: escalations must reach Tony (prerequisite)

1. `friction_file` applies the `needs-decision` label whenever the agent says a decision is needed, and the `proposal` label for strategist proposals. Never rely on the title alone.
2. `loop_report` gets an optional structured `needsOwner: { ask: string; options?: string[]; recommendation?: string }`. `pd brief` lists every active or dormant loop whose latest report has `needsOwner`, whether the loop is idle, dormant or blocked.
3. `pd brief` drops loops that are paused *by the user* from NEEDS A GENERAL. Tony paused them, so they are not a decision. Only loops paused or failed by the system stay.
4. `pd brief` gets a PROPOSALS section: open issues labelled `proposal` across owners, with the age and default-by time. Phone notify once per new proposal (reuse notify.ts).
Tests for each.

## Slice 2: the `product-strategist` preset

New preset and kind `strategy`, modelled on src/devil.ts (rotating lenses, pure helpers, tested without a daemon). New file src/strategist.ts.

**Wake rule** (in loopgate, no model call when not needed). Wake when any of these is true:
- the session's product loop reported `idle` or went dormant;
- ROADMAP.md has fewer than 3 unchecked items that no open PR claims (reuse the skip-claimed logic from #21);
- a roadmap milestone was fully merged since the last run (run a retro);
- 24h have passed since the last strategist run and there are new merges;
- a `proposal` issue reached its default-by time.
Otherwise skip. At most one strategist run per repo per 6h unless the product loop is starving.

**Inputs:** README, the repo's current direction (set with `pd direct`, landed in #26; the strategist's anchor, read first and never contradicted without a proposal), ROADMAP.md, docs/IDEAS.md, LOG, the last ~30 merged PR titles, open issues, builder idle notes, `pd mem` (including `taste:<repo>` entries), and the live product. Chromium works, so it should screenshot or play the product at 390px and desktop. It may use web_fetch briefly for genre or competitor teardowns (at most 3 fetches).

**Lenses** (rotate one per run, recorded so it never repeats the last 3):
1. Persona walkthrough: a first-time visitor/player, a returning one, a phone user. Use the product in the browser and write down every moment of confusion, boredom or delight.
2. Genre teardown: what the best products in this genre do that this one does not.
3. Delight: what would make someone show this to a friend.
4. Subtraction: what to remove or merge to make the core sharper.
5. 10x / moonshot: what the product looks like if it were 10x better. Find the first small step toward that.
6. Cross-pollination: what a sibling factory repo learned that applies here.
7. Content and depth: more missions, plants, characters, data, pages. Where depth is cheap and valuable.
8. Enablers: what is newly possible (browser, an API, a new asset pipeline) that unlocks a feature.
9. Retro: did the last milestone deliver what it intended? What does that say about what comes next?

**Method:** generate at least 10 raw ideas, then critique them. Every idea must cite concrete evidence (a screenshot observation, a PR, an idle note, a line in a doc). Drop any idea that duplicates an idea in IDEAS.md or a rejected one. Keep the best 3 to 5 and always include one bold option.

**Outputs (no product code):**
- `docs/IDEAS.md`: the idea bank. Each entry: id, title, lens, evidence, user problem, bet, size (S/M/L), door (two-way/one-way), score (impact × confidence ÷ effort, plus novelty), status (new/roadmapped/proposed/rejected/shipped). Kept to the top 40 open ideas; older ones are archived under a fold.
- `ROADMAP.md`: two-way ideas promoted straight into the "next" list (cap 5 unclaimed items). Group them into a named milestone when they form one.
- Proposal issues for big bets (new feature direction, art or brand direction, scope changes, anything public or legal, a direction change): 2 to 3 options, a recommendation, door, a default-by 24h from now (two-way only), labels `needs-decision` + `proposal`. At most 1 open proposal per repo, so Tony is never flooded.
- All of it in one docs-only PR per run (`pd/strategy-<date>`), which auto-merges like other low-risk docs.

**Default adoption:** on wake, for each `proposal` past its default-by with no owner comment and door two-way, adopt the recommendation. Move it into ROADMAP.md, comment "Adopted the recommendation by default after 24h; reply to reverse", and close the issue. One-way proposals never auto-adopt. They stay in the brief.

**Taste memory:** when Tony comments on or closes a proposal, or edits ROADMAP/IDEAS by hand, record a `taste:<repo>` fact in `pd mem` (what he chose, what he rejected, why if he said why). Strategist runs read these first.

**Thinking:** the strategist may use thinkingLevel `medium`, overriding the global `low`. This is the one role where deeper thinking pays off.

## Slice 3: builders never go dormant while ideas exist

- product-gardener prompt: replace "If no worthwhile small change is supported by evidence, do no code work and report that" with: take the next unclaimed ROADMAP item; if there is none, take the top two-way idea in docs/IDEAS.md; if that is empty, report `idle` with `wantsIdeas: true`. That wakes the strategist (slice 2 wake rule) instead of leaving the loop dormant.
- design-polish prompt: keep following the established direction, but when the a11y and token checklist is clean, take a screenshot and critique it against the direction or art doc. File the best design idea into IDEAS.md (lens: delight / genre) instead of idling. Proposing a *new* direction is allowed as a proposal issue.
- A loop goes dormant only when the strategist also has nothing it can do without Tony. Then the brief must show exactly what it is waiting on (needsOwner).

## Slice 4: spikes (prototypes to react to)

- The strategist (and venture scout) may build a throwaway prototype on `pd/spike-<slug>`, opened as a **draft** PR with screenshots described in the body and linked from the proposal.
- pr_tick never merges a `pd/spike-*` branch or a draft PR (a test proves it). Spikes are closed when the proposal is decided. If adopted, the product loop builds it properly.
- Cap: one open spike per repo.

## Slice 5: the venture scout (new projects)

A portfolio-level preset (`venture`, one instance, not per repo) that proposes new projects entirely.
- **Wakes:** weekly, plus whenever at least half of the active project loops are dormant or idle.
- **Inputs:** the list of Tony's repos (gh repo list, read-only), `pd mem` (owner decisions, taste), what each existing project is, and what the factory is good at (Astro static sites, canvas games, Cloudflare Workers, data snapshot sites). Plus lenses: a remix of two existing projects; a tool the factory itself wishes it had; an idea from one of Tony's interests (games, plants, NBA stats, AI agents, his portfolio); a "weekend-sized" game; a useful public utility.
- **Output:** 3 pitches per run as markdown files in `~/proj/pd-ventures/pitches/<date>-<slug>.md`. Each has: one-line hook, who it is for, why Tony, a first milestone of about 5 PRs, risks (legal/data/licensing), and a cost guess. For the top pitch, a spike prototype in `~/proj/pd-ventures/spikes/<slug>/` (local only, no remote, no repo creation) with a screenshot.
- `pd brief` gets a PITCHES section. `pd pitch approve <slug>` is human/general-only. It runs `gh repo create tonyjmartinez/<slug> --private`, seeds it from the spike plus a first direction taken from the pitch (`pd direct`), then `pd factory` with the product-gardener and strategist presets. Agents never create repos. `pd pitch reject <slug> "why"` records taste.
- Approving a pitch is a one-way, outward-facing action. It always waits for Tony.

## Budget

Ideation is cheap but must fit the $10/day cap. The strategist gets at most $0.60 per run, and strategist plus venture share at most 20% of the daily cap. Builders keep priority, as product loops do today.

## Non-goals

No changes to merge gates, protected paths or the push guard. Nothing outward-facing without Tony: no repo creation, no public announcements, no new domains.
