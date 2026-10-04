# Conversational Flow — Implementation Checklist

**Status**: ✅ Approved
**Date**: 2026-10-04
**Architecture**: `docs/architecture/web-codex-architecture-decision.md` (D2 loop, D3 approval, D4 modes, D7 events). This slice adds revisions A21–A23.

## Goal
As a developer using &run, I want the agent to stop and wait when it asks me something or proposes options, so that I can discuss and choose before it writes code. A pull request is where a session can end, not what every turn must produce.

Today a text reply with no tool call is answered by the harness itself ("Please call a tool or finish…", `src/core/agent.ts:202-213`), so a model that asks "which one do you want?" is told to carry on and picks for the user. Session `0f69e7af` did exactly this.

## Scope
**In**
- Code mode: a model reply with no tool call ends the turn. The session waits for the user (new status `awaiting_input`). No automatic nudge.
- New tool `ask_user` (Code mode only): one question with 2–4 options. The session waits; the user picks an option or types an answer; the answer goes back to the model as the tool's result.
- `finish` stays the only way to a pull request, and its meaning in the prompt changes from "how every task ends" to "the work is ready for a pull request".
- Code prompt: answer or propose in text when the request is a question, open-ended, or has several reasonable approaches, and do not edit files before the user has chosen; do clear tasks directly.
- UI: status "Waiting for you"; a question card with option buttons and a free-text answer; an "Open pull request" button while waiting with changes present.
- Review mode: a text reply with no tool call goes straight to the "ready to post" gate. Same gate as today, one model call sooner (today it is nudged first).
- Eval: runs end correctly under the new flow; new case `discuss-first`.

**Out**
- Markdown rendering, the agent's visual identity, the "working" indicator, usage line format, moving the plan card — next slice (UI).
- Stop button — next slice (UI). Named here because it pairs with the working indicator.
- Collapsible diffs, collapsible side panel, HTML preview — the slice after.
- `ask_user` in Review mode — a review is one pass; not needed yet.
- More than one question per `ask_user` call, multi-select options — add when a real need shows up.
- A separate "plan mode" toggle that blocks write tools — the prompt rule comes first; a hard block is a later decision if the prompt is not enough.
- Opening a pull request without a `finish` call (a backend path that needs its own title and summary) — the button sends a message instead (CF-f).
- Running the real-model eval — needs Henry's OK each time.

## Technical Notes
| Area | Change | Files |
|---|---|---|
| Events | Modify: `Status` gains `awaiting_input`; new event `question { id, question, options: { label, description? }[] }` | `src/core/events.ts` |
| Types | Modify: `ToolName` gains `ask_user`; `ModeProfile.onTextReply: "wait" \| "finish"`; `PendingApproval` gains `kind: "question"`; `RunOutcome` gains `awaiting_input`; `AgentState.nudged` removed | `src/core/types.ts` |
| Loop | Modify: remove `NUDGE`; text-only reply → `wait` returns `awaiting_input`, `finish` pauses with `implicit_finish`; `ask_user` pauses with a `question`; `resume` answers it | `src/core/agent.ts` |
| Tools | Modify: `ask_user` spec and argument validation | `src/core/tools.ts` |
| Modes / prompts / policy | Modify: Code tools gain `ask_user`, `onTextReply: "wait"`; Review `onTextReply: "finish"`; prompt text; `ask_user` is always allowed | `src/core/modes.ts`, `src/core/prompts.ts`, `src/core/policy.ts` |
| Session | Modify: a `message` frame answers an open question; approve/reject frames are refused for a question; `nudged` no longer read | `src/session/engine.ts`, `src/session/store.ts`, `src/session/protocol.ts` |
| Web | Modify: reducer (`question`, status), status label, composer; Create: `QuestionCard.tsx` | `web/src/state/reducer.ts`, `web/src/components/{StatusLabel,Composer,SessionPage,Timeline}.tsx`, `web/src/components/QuestionCard.tsx` |
| Eval | Modify: outcome handling, `expect_reply`; Create: case `discuss-first` | `eval/run.ts`, `eval/cases/discuss-first.yaml` |
| Test support | Modify: fake model plays text-only turns (`[chat]`) and an `ask_user` turn (`[choose]`) | `test/support/fake-sse-server.ts` |
| Docs | Modify: revisions A21–A23 | `docs/architecture/web-codex-architecture-decision.md` |

**Key Decisions**

Inherited: D2 (plain loop, approval is a return value), D3 (policy decides allow/ask/deny), D4 (modes are data), D7 (events are the UI contract).

New in this slice:

| ID | Decision | Reason |
|---|---|---|
| CF-a | In Code mode a reply with no tool call ends the turn with outcome `awaiting_input` and status `awaiting_input`. No message is added on the model's behalf. | This is how Claude Code and Codex end a turn. The nudge is what made the model answer its own question. |
| CF-b | `awaiting_input` is a new status, shown as "Waiting for you". `idle` keeps meaning "created, not started"; `done` keeps meaning "finish was approved". | The sidebar must show which sessions need the user. Reusing `idle` or `done` would hide that. |
| CF-c | `ask_user({ question, options })`: `question` is a non-empty string; `options` is 2–4 items of `{ label, description? }`, labels unique and non-empty. Invalid arguments are a normal tool error. The user can always type an answer instead of picking. | Small and enough for "pick one of these". |
| CF-d | An open question is a `PendingApproval` of kind `question` holding the call and the calls after it. The answer is the tool's result (`{"answer": "…"}`), then the remaining calls run, then the loop continues. | Every tool call needs exactly one tool message; this reuses the pause/resume path the gates already use (D2). |
| CF-e | The answer arrives as an ordinary `message` frame. It is shown as a user message, and it resets the turn's cost and token counters like any user message. Approve/reject frames are refused while a question is open. | One input path. The per-turn limit guards unattended runs, and an answer means the user is present. |
| CF-f | "Open pull request" sends the message `Open a pull request for these changes.`; the model then calls `finish`, and the existing gate opens the PR. | No second path to a PR. Costs one model call. |
| CF-g | Review mode: `onTextReply: "finish"`. A text-only reply pauses at the `implicit_finish` gate at once. `implicit_finish` is no longer reachable in Code mode. | Keeps Review's flow and gate unchanged, and removes the nudge everywhere. |
| CF-h | The `nudged` column stays in the `session` table and is always written as 0. | Deployed Durable Objects already have the column as NOT NULL; dropping it needs a migration for no gain. |
| CF-i | Eval: a Code case ends at `finished` or `awaiting_input`; both count, and the case's checks decide pass or fail. An `ask_user` is answered once per question with `No one is available to answer. Use your best judgment and continue.` (within the existing auto-resume limit). A case with `expect_reply: true` passes when the run ends at `awaiting_input` with no changed files; a question there is not auto-answered. | Evals run with nobody present. `expect_reply` tests the behavior this slice exists for. |

**Data flow**: model reply → loop returns `awaiting_input` (text) or pauses with a `question` (tool) → session saves state, status `awaiting_input` → user's `message` frame → new turn (text) or `resume` with the answer (question).

**New dependencies**: none.

**Existing tests that change meaning** (rewritten, not deleted): `test/core/agent.test.ts` › "text-only turn nudges then gates"; store tests that set `nudged`.

## Acceptance Scenarios

### S1: A text reply ends the turn and waits
**Given** a Code session and a model whose first reply is the text "Three ideas: A, B, C. Which one?" with no tool call
**When** the run starts
**Then** the model is called exactly once; the outcome is `awaiting_input`; the last event is `status: awaiting_input`; no user message was added to the transcript; `pending` is null; no `approval_required` event exists.
**Test**: Unit — `test/core/agent.test.ts` › "a text reply ends the turn and waits for the user"

### S2: The user's reply continues the same conversation
**Given** a session at `awaiting_input` after the reply in S1
**When** the client sends `{ type: "message", text: "B" }`
**Then** status becomes `running`; the next model request ends with the assistant's text followed by the user message "B"; the turn's cost and token counters start from zero; the run continues to its next outcome.
**Test**: API — `test/session/engine.test.ts` › "a message after a text reply starts the next turn"

### S3: `ask_user` pauses with a question
**Given** a Code session and a model that calls `ask_user({ question: "Which game?", options: [{ label: "Mental math", description: "Uses sum()" }, { label: "Guess the number" }] })` followed in the same reply by `list_files`
**When** the run reaches that call
**Then** a `question` event carries the question and both options; status is `awaiting_input`; the outcome is `awaiting_input`; `list_files` has not run; no tool message for `ask_user` exists yet.
**Test**: Unit — `test/core/agent.test.ts` › "ask_user pauses with a question"

### S4: The answer is the tool's result
**Given** the paused session from S3
**When** the client sends `{ type: "message", text: "Mental math" }`
**Then** a user `message` event "Mental math" is emitted; the transcript has a tool message for the `ask_user` call with content `{"answer":"Mental math"}`; `list_files` runs next; the following model request contains both tool results; the transcript is valid (every tool call answered once).
**Test**: API — `test/session/engine.test.ts` › "a message answers an open question and the turn continues"

### S5: `ask_user` rejects bad arguments
**Given** a Code session
**When** the model calls `ask_user` with one option, with five options, with two options sharing a label, or with an empty question
**Then** each call gets a tool error naming the problem; no `question` event is emitted; the run keeps going; three such errors in a row reach the existing strikes gate.
**Test**: Unit — `test/core/tools.test.ts` › "ask_user validates its question and options"

### S6: `ask_user` belongs to Code
**Given** the Code and Review profiles
**When** their tool lists are read and a Review run's model calls `ask_user`
**Then** Code's tools include `ask_user` and Review's do not; the Review call is answered `unknown tool: ask_user`; the policy allows `ask_user` in Code mode without asking.
**Test**: Unit — `test/core/modes.test.ts` › "ask_user is a Code tool only"

### S7: Review goes to its gate without a nudge
**Given** a Review session whose model reports one finding and then replies with text only ("One finding.")
**When** the run reaches that reply
**Then** the model is not called again; the outcome is `awaiting_approval` with pending kind `implicit_finish`, reason "posting requires your decision" and summary "One finding."; no user message was added.
**Test**: Unit — `test/core/agent.test.ts` › "a text reply in a review goes to the post gate"

### S8: The prompt tells the agent to discuss first
**Given** `CODE_SYSTEM_PROMPT`
**When** it is read
**Then** it says: a reply without a tool call ends the turn and the user answers; for a question, an open-ended request or several reasonable approaches, reply or use `ask_user` and do not edit files before the user has chosen; do a clear task directly; call `finish` only when the work is ready for a pull request. It still contains no eval fixture name.
**Test**: Unit — `test/core/modes.test.ts` › "the code prompt covers discussion, ask_user and finish"

### S9: Waiting is visible, and the question can be answered with a click
**Given** the fake model with a `[choose]` task (an `ask_user` with two options, then the normal script)
**When** the user starts the session
**Then** the header and the sidebar show "Waiting for you"; a question card shows the question, two option buttons with their descriptions, and a text field; the question also appears in the timeline.
**When** the user clicks the first option
**Then** the option's label appears as a user message; the card is replaced; the run continues to the finish gate.
**Test**: E2E — `e2e/conversation.spec.ts` › "a question is answered by picking an option"

### S10: A typed answer works too
**Given** the same `[choose]` session with the question card open
**When** the user types "Neither, make it tic-tac-toe" in the card's field and sends it
**Then** that text appears as a user message and the run continues.
**Test**: E2E — `e2e/conversation.spec.ts` › "a question is answered with typed text"

### S11: A text reply waits, and the user replies in the composer
**Given** the fake model with a `[chat]` task (a text-only reply, then the normal script after the next user message)
**When** the user starts the session
**Then** the status is "Waiting for you"; no approval bar is shown; the composer's placeholder is "Reply to the agent".
**When** the user sends "Go with the first one"
**Then** the run continues and reaches the finish gate; approving it opens the pull request as before.
**Test**: E2E — `e2e/conversation.spec.ts` › "a text reply waits for the user, then the run goes on to a pull request"

### S12: Open pull request from a waiting session
**Given** a Code session at `awaiting_input` with at least one changed file
**When** the user clicks "Open pull request"
**Then** the message "Open a pull request for these changes." is sent and shown as a user message. With no changed files the button is not shown.
**Test**: E2E — `e2e/conversation.spec.ts` › "Open pull request asks the agent to finish"

### S13: Eval handles the new endings
**Given** the eval runner with a scripted model
**When** (a) a Code case's model edits the file and ends with text and no `finish`; (b) a model calls `ask_user`; (c) a case with `expect_reply: true` whose model replies with text and changes nothing; (d) the same case whose model edits a file
**Then** (a) passes if the case's check passes, outcome `awaiting_input`; (b) the question is answered with the fixed text and the run continues; (c) passes; (d) fails. `expect_reply` on a Review case is a validation error.
**Test**: Unit — `test/eval/runner.test.ts` › "runs that end waiting for the user are scored" and "expect_reply passes only a reply with no changes"

### S14: Case `discuss-first` exists
**Given** `eval/cases/discuss-first.yaml` with the task "I want to add a small game to this repo. What would you suggest?" and `expect_reply: true`
**When** the case list is loaded
**Then** the case validates and the list has 12 cases.
**Test**: Unit — `test/eval/runner.test.ts` › "all cases load"

## Edge Cases
- [ ] A message sent while the agent is running, when that run then ends with a text reply: the queued message starts the next turn at once instead of being left unsent — **Test**: `test/session/engine.test.ts` › "a message queued during a run that ends waiting starts the next turn"
- [ ] Two `ask_user` calls in one reply: the second is asked after the first is answered — **Test**: `test/core/agent.test.ts` › "a second question in the same reply waits for the first"
- [ ] An approve or reject frame while a question is open is refused with a reason, and the question stays open — **Test**: `test/session/engine.test.ts` › "approve and reject are refused while a question is open"
- [ ] A reload or reconnect while a question is open shows the same card (replay from stored events; the snapshot status is `awaiting_input`) — **Test**: `e2e/conversation.spec.ts` › "an open question survives a reload"
- [ ] A session saved before this slice (`nudged` set, status `awaiting_approval` with `implicit_finish` pending in Code mode) can still be approved or answered — **Test**: `test/session/engine.test.ts` › "an implicit finish saved by an older version still resolves"
- [ ] The turn limit is reached on the same step as a text reply: the outcome is the limit, not `awaiting_input` — **Test**: `test/core/agent.test.ts` › "the turn limit wins over a text reply"
- [ ] An empty reply (no text, no tool call) also ends the turn; the timeline shows a notice "The agent stopped without a reply." — **Test**: `test/web/reducer.test.ts` › "an empty reply shows a notice"
- [ ] A long option label or description wraps inside the card and does not push the buttons off screen — **Runtime check**: `/qa-web` with a 200-character option
- [ ] The sandbox stops while the session waits; the next message brings it back with the workspace restored (existing behavior, not changed here) — **Runtime check**: wait past the sandbox timeout in `wrangler dev`, then reply

Not applicable: auth and rate limits (no new endpoint; the `message` frame already has both); GitHub (the PR path is unchanged).

## Open Questions
- [ ] Assumption: the status text is "Waiting for you", coloured like "Awaiting approval" in the sidebar so it stands out — decide by: Henry at approval
- [ ] Assumption: "Open pull request" costs one model call (CF-f) instead of a new backend path — decide by: Henry at approval
- [ ] Assumption: weaker models may end a turn early ("I will now do X") and need a "continue" from the user. The prompt tells them not to; no automatic recovery — decide by: Henry at approval
- [ ] Whether the prompt rule is enough to stop edits before the user chooses, or a hard block is needed — decide by: the `discuss-first` eval result (real-model run needs Henry's OK)
- [ ] Exact wording of the new prompt lines — decide by: during build, shown to Henry in the build report

## Build Progress
| # | Unit | Proves | Status |
|---|---|---|---|
| 0 | Acceptance tests (commander) | all | 🔨 in progress |
| 1 | Core: events, types, loop, `ask_user`, modes, prompts, policy | S1, S3, S5, S6, S7, S8; edges: second question, turn limit | ⏳ pending |
| 2 | Session: answer a question, queued message, old saved state, `nudged` column | S2, S4; edges: queued message, approve/reject refused, older implicit finish | ⏳ pending |
| 3 | Eval: new endings, `expect_reply`, case `discuss-first` | S13, S14 | ⏳ pending |
| 4 | Web + fake model: status, question card, composer, Open pull request | S9–S12; edges: reload, empty reply | ⏳ pending |
| 5 | Docs: ADR revisions A21–A23 | — | ⏳ pending |
| 6 | Runtime verification | all | ⏳ pending |
