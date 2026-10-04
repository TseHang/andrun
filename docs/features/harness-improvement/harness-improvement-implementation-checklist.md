# &run Harness improvement, Slice A: plan, general Code mode, stronger Review — Implementation Checklist

**Status**: ✅ Built — Passing (2026-10-04; approved by Henry the same day)
**Date**: 2026-10-04
**Branch**: `feature/harness-improvement`
**Architecture**: `docs/architecture/web-codex-architecture-decision.md` (D2, D4, D7, D12, D17; A10, A13 unchanged)
**Brief**: `docs/features/harness-improvement/harness-improvement-brief.md` v3 (items 1–5)
**Also read**: `docs/limits.md` (C1, C2, G9, L1)

## Goal
As a user, I want to give &run any coding task in the repo (a feature, a refactor, a new page), see the agent's plan while it works, and get a review that reports only verified problems, so that &run is useful beyond fixing a failing test.
Today the prompt, the tools and the eval all assume "run the tests, fix, run again".

## Decisions for this slice
Confirmed by Henry on 2026-10-04, including HI-d (sessions stay open), HI-h (cost limit per turn) and HI-j (commands run without asking).

- **HI-a. Plan tool.** `update_plan` with `plan: [{step, status}]`, `status` one of `pending | in_progress | completed`. Each call replaces the whole plan. An empty list clears it. The result is the text `Plan updated`. "At most one step in progress" is in the tool description only; the harness does not enforce it. Wrong argument shapes are a tool error fed back to the model, like any other tool.
- **HI-b. Plan event.** New event `{type: "plan_updated", plan: PlanStep[]}`, emitted by the core after a successful call (same path as `review_finding`). No `plan` field in `AgentState`, no per-turn plan message: the plan stays in the assistant message's tool call arguments, which `compactForRequest` never changes.
- **HI-c. Plan in the UI.** The latest plan is a card at the top of the right panel of a Code session, above Changes. An `update_plan` call adds no row to the timeline (like `finish`). At a finish gate with unfinished steps, the approval bar says "N of M plan steps not completed". The harness does not block the finish.
- **HI-d. `onFinish` dispatch, no behavior change.** `engine.ts` picks the finish handler from `profile.onFinish` (`open_pr`, `draft_review`, `answer`). Whether a session takes messages afterwards belongs to the handler: `open_pr` keeps going (round 2 adds a commit, G9), `draft_review` stops after posting. `answer` is a stub that ends the run as `done`; Task mode (Slice B) fills it in.
- **HI-e. Repo context message.** After the sandbox is first set up, the host adds one user message after the task: root `AGENTS.md` (capped at 8 KB), the `scripts` of the root `package.json`, and the top-level entries (capped at 50). Built by a platform-free function in `src/core`, used by the engine and the eval. It is not an event, so the timeline does not show it. It is added once per session. In Review mode `AGENTS.md` is left out: the workspace is the pull request's head, so that file is written by the pull request's author (same rule as A13's "material, not instructions").
- **HI-f. `read_file` ranges.** Optional `offset` (1-based line) and `limit` (lines). A file or range larger than the 8 KB cap returns whole lines from the start of the range and ends with a note: which lines are shown, how many the file has, and the `offset` to continue from. This replaces head-plus-tail for `read_file` only; commands keep head-plus-tail.
- **HI-g. Prompts.** Code: general principles (read before editing; precise in an existing codebase, complete for new files; verify with what the repo has, closest check first; leave tests alone unless asked; do not add a test framework to a repo without one; mention unrelated problems, do not fix them; when to plan). Review: only problems the pull request introduces; verify before reporting; state a concrete failure for each finding; say so when there are none. No file or function names from any eval case.
- **HI-h. One safety limit per turn, in money.** The session token budget and the step limit are removed as stop conditions (`maxSteps` becomes optional and unset by default; eval cases keep `max_steps`; `maxTokens` is removed). A **turn** starts when a session is created or when the user sends a message to a session that is not running, and ends when the agent stops for the user (a finish gate that is approved, a failure, or the limit). Approve and Reject at a gate continue the same turn. Each turn may cost at most `maxTurnCost` = ¥50, summed from the cost of each model call (list price, uncached input, so an overestimate). When a model has no price, the turn is limited to 4,000,000 tokens (input plus output, summed over its calls) instead. At the limit the run stops as `budget_exceeded` with "This turn reached its ¥50 safety limit" and "Send a message to continue."; the composer stays usable and a message starts a new turn with a fresh limit. This closes `limits.md` C2.
- **HI-k. Cost is information.** The header shows `Step N` and the session's total cost. Above ¥10 the cost turns red and gets an info icon whose text is "This session has cost more than ¥10. Smaller tasks cost less: consider splitting the work." Nothing stops at ¥10.
- **HI-j. Code mode runs commands without asking.** In Code mode every `run_command` is allowed. The gates that remain are `finish` and a patch that deletes files. Review is unchanged: allowlisted read-only commands run, anything else is denied. Reason: the sandbox has no network and no secrets, is thrown away, and nothing leaves it without Approve.
- **HI-i. Eval cases beyond "fix the test".** Four Code cases (add a feature, refactor, add tests, add a static page) and one Review case on clean code. Two new optional case fields: `expect_changes` (globs; at least one changed file must match each) and `expect_no_findings` (Review). Running them with a real model needs Henry's go-ahead and is not part of this slice's automated checks.

## Scope
**In**
- `update_plan` tool, `plan_updated` event, plan card, unfinished-steps note at the finish gate
- `engine.ts` finish handling dispatched by `profile.onFinish`
- General `CODE_SYSTEM_PROMPT`, stronger `REVIEW_SYSTEM_PROMPT`
- Repo context message (engine and eval)
- `read_file` with `offset` / `limit`
- Step limit and session token budget removed; a ¥50 safety limit per turn; header shows step and total cost, red above ¥10
- Code mode runs any command without asking (HI-j)
- Eval: five new cases with fixtures, `expect_changes`, `expect_no_findings`
- Fake model: a `[plan]` marker that plays a script with `update_plan` calls
- `docs/limits.md` (C1, C2) and the ADR amendments table (D2, D4, D17, spec §6) updated for HI-d, HI-f, HI-h, HI-j

**Out**
- Ending a Code session after Approve — decided against (Henry, 2026-10-04): sessions stay open
- A Stop button for a running session — worth doing, its own slice
- An auto mode for approvals — later (Henry)
- Task mode (empty sandbox, artifacts) — Slice B
- Network: sandbox egress spike and allowlist (Slice C), then wider access or Worker-side tools (Slice D)
- A string-replace edit tool — past eval runs show 2 failed patches in 7; not enough evidence yet
- Running the eval with a real model — costs money; ask Henry first

## Technical Notes
| Area | Change | Files |
|---|---|---|
| Core types | Modify: `ToolName` + `update_plan`; `PlanStep` type; `maxSteps?`; `maxTurnCost`, `maxTurnTokens` replace `maxTokens`; turn counters in `AgentState` | `src/core/types.ts`, `src/core/config.ts` |
| Tools | Modify: `update_plan` spec and execution; `read_file` range; `summarizeCall` | `src/core/tools.ts`, `src/core/context.ts` |
| Events | Modify: `plan_updated` | `src/core/events.ts` |
| Loop | Modify: emit `plan_updated`; step cap only when set; stop at the turn limit | `src/core/agent.ts` |
| Policy | Modify: Code mode allows every command | `src/core/policy.ts` |
| Store | Modify: persist the turn counters without altering the `session` table (P4-p): a one-row table created on first write | `src/session/store.ts` |
| Profiles, prompts | Modify | `src/core/modes.ts`, `src/core/prompts.ts` |
| Repo context | Create | `src/core/repo-context.ts` |
| Engine | Modify: dispatch by `onFinish`; add the context message before the first run; a new turn resets the turn counters | `src/session/engine.ts` |
| Router | Modify: `/config` returns `maxTurnCost` and `costNotice`, no `maxSteps` or `maxTokens` | `src/worker/router.ts` |
| Web | Modify: `view.plan`, plan card, gate note, header cost notice, composer usable after the limit | `web/src/state/reducer.ts`, `web/src/components/ChangesPanel.tsx`, `ApprovalBar.tsx`, `SessionHeader.tsx`, `Composer.tsx`, `web/src/api.ts`; Create `web/src/components/PlanCard.tsx` |
| Eval | Modify runner; Create cases and fixtures | `eval/run.ts`, `eval/cases/*.yaml`, `eval/fixtures/*` |
| Test support | Modify: `[plan]` script; `[ask]` gates on a patch that deletes a file instead of `rm -rf tmp` | `test/support/fake-sse-server.ts` |

Key Decisions: D2 (budgets; replaced by HI-h), spec §6 (approval policy; amended by HI-j), D4 (profiles are data; HI-d makes `onFinish` real), D7 (events are the UI's only source; HI-b), D12 (eval), D17 (compaction; HI-b relies on it, HI-f changes the cap behavior for `read_file`).
Data flow: no new bindings or dependencies; one small SessionDO table for the turn counters. `plan_updated` is stored and replayed like every other event.
Constraint found while reading: `publishChanges` takes the first user message as the pull request's Task (`engine.ts:333`), so the context message must come after the task.

## Acceptance Scenarios

### S1: The agent records a plan and the UI is told
**Given** a Code run whose model calls `update_plan` with three steps, the first `in_progress`
**When** the loop processes the call
**Then** the tool message is `Plan updated`; a `plan_updated` event carries the three steps with their statuses, after the `tool_call` and before the next model turn; no approval is asked; the failure counter is unchanged
**Test**: Unit — `test/core/agent.test.ts` › "update_plan answers 'Plan updated' and emits plan_updated"

### S2: A malformed plan goes back to the model
**Given** `update_plan` called with `plan` not a list, a step without text, or a status outside the three values
**When** the tool runs
**Then** the result is an `invalid arguments` error naming the problem, no `plan_updated` event is emitted, and three such calls in a row pause the run like any other tool
**Test**: Unit — `test/core/tools.test.ts` › "update_plan rejects a malformed plan"

### S3: The plan survives context compaction
**Given** a transcript over 70 % of the context window, with an `update_plan` call older than the last 6 steps
**When** `compactForRequest` builds the request
**Then** the assistant message with the `update_plan` arguments is unchanged, while old tool results are stubs
**Test**: Unit — `test/core/context.test.ts` › "an old update_plan call keeps its plan when tool results are stubbed"

### S4: Code has the plan tool, Review does not
**Given** the Code and Review profiles
**When** each profile's tool specs are listed, and a Review run calls `update_plan`
**Then** Code lists `update_plan`; Review does not, and the call is answered `unknown tool: update_plan`
**Test**: Unit — `test/core/modes.test.ts` › "update_plan is a Code tool only"

### S5: The view holds the latest plan
**Given** an event log with two `plan_updated` events and their `update_plan` tool calls
**When** it is reduced, live and as a replay
**Then** `view.plan` equals the second plan in both cases; the timeline has no row for `update_plan`; a log without `plan_updated` gives `view.plan === null`
**Test**: Unit — `test/web/reducer.test.ts` › "plan_updated replaces the plan and adds no timeline row"

### S6: The plan is visible, survives a reload, and the gate reports unfinished steps
**Given** a Code session started with the `[plan]` task against the fake model (the script plans three steps, completes two, then finishes)
**When** the user watches the run, reloads the page at the finish gate, then approves
**Then** a "Plan" card in the right panel lists three steps, the current one marked in progress and finished ones checked; after the reload the card shows the same steps; the approval bar reads "1 of 3 plan steps not completed"; Approve still opens the pull request
**Test**: E2E — `e2e/plan.spec.ts` › "the plan is shown, kept across a reload, and unfinished steps are named at the gate"

### S7: Finish handling follows `profile.onFinish`, with the behavior unchanged
**Given** a Code session and a Review session, each at its finish gate
**When** Approve is sent to both, the review is then posted, and a message is sent to each
**Then** Code: the pull request opens, the session is `done`, the message starts a new turn and the next Approve adds a commit to the same pull request. Review: Approve is refused with "Choose a verdict and post the review."; after `post_review` the message is refused with "This review was posted. Start a new review from Pull requests." (changed by ADR A24: the message starts a new turn)
**Test**: API — `test/session/engine-github.test.ts` › "finish handling follows the profile's onFinish"

### S8: The model starts with the repo's context
**Given** a Code session on a repo with a root `AGENTS.md`, a `package.json` with `test` and `build` scripts, and directories `src/` and `test/`
**When** the session is created and the first model request is sent
**Then** the request's messages are: system prompt, the task, then one user message that contains the `AGENTS.md` text, both script names with their commands, and the top-level entries; the timeline shows one user bubble (the task); after Approve the pull request body's Task is the task text only
**Test**: API — `test/session/engine.test.ts` › "the first model request carries the repo context after the task"

### S9: The context is added once, and a review does not trust the pull request's AGENTS.md
**Given** (a) a Code session whose sandbox is rebuilt before a second turn; (b) a Review session whose pull request head contains an `AGENTS.md`
**When** each sends its next model request
**Then** (a) the transcript holds exactly one context message; (b) the review's context message has the scripts and top-level entries and none of the `AGENTS.md` text
**Test**: API — `test/session/engine.test.ts` › "the repo context is added once; a review leaves AGENTS.md out"

### S10: A large file can be read in parts
**Given** a 2,000-line file of about 60 KB
**When** `read_file` is called with no range, then with the `offset` its note gives, then with `offset: 1990, limit: 5`
**Then** the first result holds whole lines from line 1, is at most 8 KB, and ends with a note giving the lines shown, the total (2,000) and the next `offset`; the second starts exactly at that line; the third returns lines 1990–1994 and no note; `meta.bytes` is the whole file's size each time; a file under the cap with no range is returned unchanged
**Test**: Unit — `test/core/tools.test.ts` › "read_file returns whole lines with a continuation note, and honors offset and limit"

### S11: The prompts are general
**Given** the Code and Review system prompts
**When** they are read
**Then** Code no longer says to start by running the tests, to rerun the tests after every change, or to never edit tests; it says to verify with what the repo provides, to keep changes within the task, and when to use `update_plan`. Review says to report only problems the pull request introduces and to verify before reporting. Neither contains a path or symbol from `eval/fixtures`
**Test**: Unit — `test/core/modes.test.ts` › "prompts carry general rules and no eval-specific names"

### S12: A turn stops at its cost limit, and a message continues it
**Given** a config with `maxTurnCost: 50` and a priced model, and a scripted model whose every call costs ¥6 and calls `list_files`
**When** the run goes on, then the user sends "continue"
**Then** the run passes step 8 without a step limit and stops as `budget_exceeded` after the call that brings the turn to ¥54, with the error "This turn reached its ¥50 safety limit" and next "Send a message to continue."; the message starts a new turn that runs again and can spend another ¥50; with `maxSteps: 3` set (an eval case) the run still stops with "step limit reached (3)"
**Test**: Unit — `test/core/agent.test.ts` › "a turn stops at its cost limit, not at a step count"; API — `test/session/engine.test.ts` › "a message after the limit starts a new turn with a fresh limit"

### S13: Approve and Reject do not reset the turn; an unpriced model is limited by tokens
**Given** (a) a turn that has cost ¥45 and waits at an approval gate; (b) a model with no price in the config and `maxTurnTokens: 4_000_000`
**When** (a) the user rejects with a comment and the agent makes a ¥6 call; (b) the turn's calls add up to more than 4,000,000 tokens
**Then** (a) the run stops as `budget_exceeded` at ¥51: the gate did not start a new turn; (b) the run stops as `budget_exceeded` with "This turn reached its 4,000,000 token safety limit"
**Test**: Unit — `test/core/agent.test.ts` › "a gate keeps the turn's cost; an unpriced model falls back to a token limit"

### S14: The eval can score tasks that are not "fix the test"
**Given** the case files, with four new Code cases and one Review case on clean code
**When** the runner loads them and runs each against a scripted model
**Then** 11 cases load; a Code case with `expect_changes: ["test/**"]` fails when no test file changed and passes when one did; the clean Review case passes with no findings and fails with one; every new Code case's `check` fails on the untouched fixture and passes on a correct scripted change
**Test**: Unit — `test/eval/runner.test.ts` › "scores feature, refactor, add-tests, static-page and clean-review cases"

### S15: The header shows cost as information
**Given** a Code session whose usage events add up to ¥3, then to ¥12
**When** the header renders
**Then** it reads `Step N` (no "of 30") and `¥3` in the normal color; at ¥12 the cost is red with an info icon whose accessible text is "This session has cost more than ¥10. Smaller tasks cost less: consider splitting the work."; after `budget_exceeded` the composer is enabled with the placeholder "Send a message to continue"; `GET /config` has `maxTurnCost: 50` and `costNotice: 10` and neither `maxSteps` nor `maxTokens`
**Test**: Unit — `test/web/reducer.test.ts` › "the composer stays enabled after the turn limit"; API — `test/worker/router.test.ts` › "config reports the turn cost limit and the cost notice"; E2E — `e2e/code-run.spec.ts` › "the header shows the step and the cost, and marks a cost above the notice"

### S16: Code mode runs commands without asking; Review does not
**Given** the allowlist policy
**When** it decides `mkdir -p site`, `node build.js`, `grep -rn foo src | head`, and `rm -rf tmp` in Code mode and in Review mode, a patch that deletes a file in Code mode, and `finish` in both
**Then** Code: the four commands are `allow`, the deleting patch and `finish` are `ask`. Review: `mkdir`, `node`, the pipe and `rm` are `deny`, `finish` is `ask`
**Test**: Unit — `test/core/policy.test.ts` › "Code mode allows every command; Review keeps the read-only allowlist"; E2E — `e2e/gates.spec.ts` (updated: the `[ask]` task now gates on a patch that deletes a file)

## Edge Cases
- [x] `update_plan` with an empty list clears the plan; the card disappears — **Test**: `test/web/reducer.test.ts` › "an empty plan clears the card" — verified: unit test
- [x] Two steps `in_progress` are accepted and shown as given (HI-a) — **Test**: `test/core/tools.test.ts` › "update_plan does not enforce one step in progress" — verified: unit test
- [x] A follow-up turn replaces the previous turn's plan; all steps completed shows no gate note — **Test**: `test/web/reducer.test.ts` › "the gate note counts unfinished steps of the latest plan" — verified: unit test
- [x] A session stored before this slice (no `plan_updated`, state without the context message) opens and continues; no context message is added to a session already past step 0 — **Test**: `test/session/engine.test.ts` › "a session from before this slice resumes unchanged" — verified: API test
- [x] A repo with no `AGENTS.md` and no `package.json` gets a context message with the top-level entries only; an `AGENTS.md` over 8 KB is cut with the elision marker — **Test**: `test/core/repo-context.test.ts` › "missing files are skipped and a long AGENTS.md is capped" — verified: unit test
- [x] The sandbox fails while the context is read: the run ends as `failed` like any setup failure, with no half-written message — **Test**: `test/session/engine.test.ts` › "a sandbox lost while reading the repo context fails the session" — verified: API test
- [x] `read_file` with `offset` past the end, `offset: 0`, a negative or non-integer `limit` → `invalid arguments`; a single line longer than the cap is cut with the elision marker — **Test**: `test/core/tools.test.ts` › "read_file rejects bad ranges and cuts an over-long line" — verified: unit test
- [x] A Review session's layout has no plan card — **Runtime check**: open a review session in the browser after the build — verified: browser: a review of PR #14 on wrangler dev shows 0 Plan regions
- [x] The engine has no `state.mode === "review"` on a finish path (`decide`, `postReview`, the message refusal) — **Runtime check**: `grep -n 'mode === "review"' src/session/engine.ts` shows only `editFinding` — verified: grep shows only `editFinding` (written as `!==`)
- [x] A session stored before this slice has no turn counters: its next turn starts from zero and is limited like a new one — **Test**: `test/session/store.test.ts` › "a store without turn counters loads as a fresh turn" — verified: unit test
- [x] A message queued while the agent runs (a redirect) does not start a new turn — **Test**: `test/session/engine.test.ts` › "a redirect keeps the running turn's cost" — verified: API test
- [x] The whole flow on `wrangler dev` with the fake model: Code run with a plan, Approve, follow-up message, second Approve; Review run to Post — **Runtime check**: `pnpm e2e` plus a manual pass in the browser — verified: `pnpm e2e` 23/23, plus a headless browser pass with screenshots; no console or network errors

Not applicable: auth (none in &run); new storage or migrations (none); GitHub API changes (none); rate limits (no new route).

## Open Questions
- [x] Keep a Code session open after its pull request — yes (Henry, 2026-10-04).
- [x] Code mode runs commands without asking — yes (Henry, 2026-10-04): HI-j, S16.
- [x] Budget — no session budget; a ¥50 safety limit per turn; cost shown, red above ¥10 (Henry, 2026-10-04): HI-h, HI-k.
- [ ] Plan card position (HI-c): top of the right panel. Decide by: Henry at QA.
- [x] Assumption: HI-f changes what `read_file` returns for files over 8 KB (start plus note instead of head plus tail). Existing tests that assert the old shape are updated. Decide by: during build.
- [x] Assumption: existing tests that rely on a command gate in Code mode (`test/core/agent.test.ts` S3, `test/core/modes.test.ts`, `e2e/gates.spec.ts`) move to a patch that deletes a file or to an injected policy. Decide by: during build.
- [ ] After the build: one real-model eval run (11 cases × 1, deepseek-v4-flash, a few yen) to see whether the new prompt holds on the old cases. Decide by: Henry, before it is run.

## Build Progress
| # | Unit | Proves | Status |
|---|---|---|---|
| 0 | Acceptance tests, fake-model scripts, eval cases and fixtures (commander) | all | ✅ done |
| 1 | Core: `update_plan` tool and `plan_updated` event | S1, S2, S3, S4; edge: two in progress | ✅ done |
| 2 | Core: `read_file` ranges | S10; edge: bad ranges, over-long line | ✅ done |
| 3 | Core: Code mode allows every command | S16 (unit) | ✅ done |
| 4 | Turn cost limit: config, loop, store counters, engine new turn, `/config` | S12, S13, S15 (API); edges: old store, redirect | ✅ done |
| 5 | Repo context: `src/core/repo-context.ts`, engine, eval | S8, S9; edges: old session, missing files, sandbox lost | ✅ done |
| 6 | Engine: finish handling dispatched by `onFinish` | S7; runtime check: grep | ✅ done |
| 7 | Prompts (Code, Review) | S11 | ✅ done |
| 8 | Eval runner: `expect_changes`, `expect_no_findings` | S14 | ✅ done |
| 9 | Web: plan card, gate note, header cost, composer | S5, S6, S15 (web, E2E), S16 (E2E); edges: empty plan, gate note | ✅ done |
| 10 | Docs: `limits.md`, ADR amendments (commander) | Scope | ✅ done |
| 11 | Runtime verification: `pnpm e2e`, browser pass, edge cases | all | ✅ done |

Contracts fixed by the tests (so units agree): `PlanStep` and `plan_updated` in `src/core/events.ts`; `ToolResult.plan`; `AgentState.turnCost` / `turnTokens`; `AgentConfig.maxSteps?`, `maxTurnCost`, `maxTurnTokens`, `costNotice`; `REPO_CONTEXT_HEADER` and `buildRepoContext(sandbox, { agentsMd })` in `src/core/repo-context.ts`; `SessionView.plan`; `planNote(plan)` in `web/src/state/format.ts`; the `read_file` note `[lines A-B of N shown; continue with offset B+1]`.

Build notes (2026-10-04):
- Units 1–3, 4–5, 6–8 and 9 were built by the implementer (four runs); the commander wrote the tests, the eval cases and fixtures, the fake-model scripts and the docs, and made three small fixes itself (below).
- Test fixes, with reasons: `engine.test.ts` "added once" checked transcript validity at a gate, where the pending `finish` call is open by design (assertion removed); `e2e/gates.spec.ts` matched "Apply" and "Don't apply" with one selector (now exact).
- Added after the automated security review of the commits: repo names and commands in the context message stay on one line and are capped (200 chars, 30 scripts), and a review's context says it is the pull request's text; the turn limit is also checked before a model call (a turn over its limit at a gate gets no further call) and counts the request's estimated size when a provider reports no usage. Each has a test. `limits.md` L11 records that Code mode commands run without asking.
- Differences from the text above: the header cost keeps the existing format (`¥3.00`, not `¥3`); the fake model's `[ask]` writes `scratch.txt` and then deletes it with a patch; a `[costly]` marker was added for S15.
- Not verified in a browser: the composer after `budget_exceeded` (it needs about ¥50 of fake usage in one turn); covered by the engine API test and the reducer test.
- Seen during the browser pass, for QA: a follow-up turn that makes no new plan still shows the first turn's plan and its gate note; the in-progress step keeps its spinner while the session waits at a gate.
