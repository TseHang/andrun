# &run Code Workspace UI — Implementation Checklist

**Status**: ✅ Approved (Henry, 2026-10-02)
**Date**: 2026-10-02
**Architecture**: `docs/architecture/web-codex-architecture-decision.md` → Phase 3
**Design**: Claude Design canvas, page "v3 aligned", boards 1–5 (Home, Code session running, Approval gate, Done, States and errors): https://claude.ai/artifact/TZezwBinDXnfySoDgTwquD. Page "v2 prototype" is the earlier pass the G-rows below were found in.
**Also read**: `docs/limits.md` (the UI must not promise more than it lists), product spec §3, §5, §8

## Goal
As a coder who opens the &run URL, I want to start a Code run, watch every step, read the diff and approve or send it back, so that I stay in control of what the agent did without reading raw JSON.
Phase 2 already streams a correct event log. This slice draws the v2 design over it and closes the places where the design shows something the backend does not provide.

## Design vs. contract
The design was drawn ahead of the code. Each row is a difference found by reading the v2 boards against the ADR and `src/`, and what this slice does about it.

### Needs a backend change (in this slice)
| # | The design shows | What exists today | Resolution |
|---|---|---|---|
| G1 | Home: `TseHang/andrun-demo at 0df6f53` before any session exists; header: "Step 4 of 30" | Repo and SHA are Worker `vars`; no route returns them. `maxSteps` is in `src/core/config.ts` only. | New `GET /config` (P3-c). |
| G2 | Home: a model menu where a model can be picked | The model is fixed per mode in `defaultConfig.models`. `POST /sessions` takes no model, and the session row stores none. ADR D19 says "MVP: one model per mode from config". | `POST /sessions` accepts an optional `model` from a list of four (P3-d). This amends D19 (Henry, 2026-10-02). |
| G3 | "Your changes are on a fresh checkout" as a calm notice, separate from "The sandbox was lost" | Both are `error{source:"sandbox"}`. The restore note is told apart only by its English text. | Export the note's text from `src/session/protocol.ts`; the UI matches on that constant (P3-e). No new event type. |
| G8 | Step rows: `read_file … 214 B`, `list_files … 3 files` | The tool layer knows both numbers, but the event carries only the result text, cut to 2,000 characters. GitHub cannot supply them: it does not see the sandbox's working copy. | The final `tool_output` gets an optional `meta: {bytes?, files?}` (P3-n). Every row also shows its duration (from event `ts`); commands show the exit code; edits show `+n −m`. |
| G10 | Running: "Sandbox: Running" | The Durable Object knows (`container.running`, today only under `debug` in `GET /sessions/:id`). No event reports it, and an idle stop emits nothing. | `GET /sessions/:id` returns `sandboxRunning` as a real field (P3-o). The UI reads it; it is not pushed. |

### Not available in Phase 3 (the UI changes, the backend does not)
| # | The design shows | Why it cannot be shown yet | Resolution |
|---|---|---|---|
| G4 | "Approve and open PR", `agent/7f3a-1 → main`, "Nothing is pushed until you approve", "Done · PR #12", the `pr_opened` card | GitHub is Phase 4. Approving only moves the session to `done` (`limits.md` L6). | The button says "Approve". No branch label. After approval: "Approved. Nothing was pushed: pull requests are not connected yet." Home footnote: "Runs in a sandbox with no network access". |
| G5 | Sidebar item "Pull requests 3" | Phase 4. | Not rendered. |
| G6 | Mode switch Code / Review / Task | `POST /sessions` accepts only `mode:"code"`; `getProfile("task")` throws. | Review and Task are shown disabled ("Not available yet") and are enabled by the phase that builds them (Henry, 2026-10-02). |
| G7 | Sidebar and Home rows: "Failed · sandbox lost" | The index row has `status` only. | The row shows the status alone. |
| G9 | Gate: "npm test passed, 2 of 2" | The sandbox knows a command's exit code and its text output. A count would mean parsing each test runner's output format, which does not hold for any repo. | "Last command: `npm test` · exit 0", taken from the last `run_command`. No count. |
| G11 | Restore card: "shut down after 15 idle minutes … 1 changed file was written back" | The reason for the loss and the count are not in the event. | The server's note is shown as it is, including the list of files not restored. |
| G12 | Status card: "A new message moves Done, Failed and Budget exceeded back to Running" | After `budget_exceeded` a new turn stops again at once (`limits.md` C2). | The composer is disabled in `budget_exceeded` and says to start a new session. |
| G13 | "Stop and redirect" on the 3-failures gate | Nothing stops a run. A reject sends the comment and the loop continues. | The button says "Redirect" and focuses the comment field. |

### In the contract but not drawn (the UI must still handle it)
| # | Behavior in the code | Resolution |
|---|---|---|
| G14 | A `reject` frame needs a non-empty comment. "Don't run" has none. | "Don't run" sends `"Do not run this command."` unless the user typed a comment. At a finish gate, Send is disabled until there is text. |
| G15 | Gates not drawn: `apply_patch` that deletes files; finish with reason "the agent stopped without calling finish". | One approval bar shows the server's `reason` and the open call (P3-h). |
| G16 | `approval_required` has no `callId` and no args. | The command or patch shown at a gate is the last `tool_call` that has no result yet. |
| G17 | Every failed tool call also emits `error{source:"tool"}`. | Shown inside that step's row, not as a banner. |
| G18 | For `run_command`, the final `result` chunk repeats the output that was already streamed. | The row shows the streamed chunks; the `result` text is used only for tools that do not stream. |
| G19 | A redirect typed while running is queued in memory; its `message` event is emitted only when it is injected. If the run reaches a gate first, the text is applied as Reject + comment (`limits.md` F4). | A pending bubble ("Queued for the next step") is shown until the matching event arrives. It is not kept across a reload. |
| G20 | After Approve or Reject, `approval_resolved` can come up to ~11 s later when the sandbox is rebuilt (`limits.md` F5). | The bar goes to a sending state on click and leaves it on `approval_resolved` or a `rejected` frame. |
| G21 | A file changed only by a command gets no `file_changed` event (`limits.md` L3). The gate's `diffSummary` still counts it. | The Changes panel lists it with its counts and "Changed by a command. Diff not available." Fixing this belongs to Phase 4, which needs the content anyway. |
| G22 | The token budget (400k per session) also ends a run. Only the step limit is drawn. | The budget card shows the server's message for either limit. |
| G23 | Product spec §3: "a suggested task is pre-filled". The design has an empty field. | The field is empty, with the placeholder "Start your work, ship new feature!". The product is meant for any repo and any kind of change, not only fixing tests, so no task is suggested (Henry, 2026-10-02). This drops the spec's pre-filled task. |
| G24 | Product spec §5: `approval_resolved` is an inline marker. Not drawn. | "Approved" marker; a rejection is shown as a user bubble with the comment. |

Sample data in the boards that does not match the real repo (128k context window, the `<=` bug, ¥ amounts) is illustration only; the UI shows what the events carry.

## Scope
**In**
- A Vite + React 19 + TypeScript + Tailwind v4 SPA in `web/`, built to `dist/` and served as Worker static assets (D13)
- Screens from boards 1–4: Home (composer, model menu, recent sessions), session view (header, timeline, Changes panel, composer, approval bar), every state and error on board 4 that Phase 2 can produce
- Sidebar session list, delete with confirm (D16, D18)
- Reconnect with `lastSeq`, and a visible reconnecting state (D7)
- Backend additions G1–G3, G8 and G10, and nothing else in `src/`
- The &run wordmark as outlined SVG plus a PNG, and a favicon (the logo export Henry asked for)
- Playwright E2E against `wrangler dev` + the fake model
- Deploy and runtime checks of spec tests A, C and D in the browser

**Out**
- Pull requests page, review screens, My PR, `pr_opened` / `review_*` rendering (boards 5–9) → Phase 4
- Task mode → Phase 5
- Dark mode. Colors are CSS variables so it can be added later; no dark theme is built or tested.
- Layouts under 1024 px wide. The design is a 1440 px desktop layout.
- Syntax highlighting, a file tree, manual editing (product spec §9)
- A stop button. Delete is the only way to stop a run, as in the design.
- Fixing G21, F1–F5 or any other item in `docs/limits.md`
- Adding or renaming events, changing the client frames or the loop. The one contract change is the optional `meta` field of G8.
- Resolving the commit at session start instead of the pinned `DEMO_SHA` → Phase 4 (see the notes at the end)

## Technical Notes
| Area | Change | Files |
|---|---|---|
| Web app | Create: entry, router (`/`, `/s/:id`), API client, WebSocket client with reconnect | `web/index.html`, `web/src/main.tsx`, `web/src/app.tsx`, `web/src/api.ts`, `web/src/socket.ts` |
| State | Create: a pure `reduce(state, frame)` from events to a view model, plus formatters and a unified-diff parser. No React or DOM imports, so it runs under Node Vitest. | `web/src/state/reducer.ts`, `web/src/state/view.ts`, `web/src/state/diff.ts`, `web/src/state/format.ts` |
| Components | Create: Sidebar, Home, Composer, ModelMenu, SessionHeader, Timeline, StepGroup, ChangesPanel, DiffView, ApprovalBar, Notice, DeleteDialog | `web/src/components/*.tsx` |
| Styles | Create: Tailwind v4 with the v2 tokens as CSS variables (accent `#cf4a12`, accent text `#c54611`, text `#1d1d1f`, secondary `#6e6e73`, sidebar `#f5f5f7`, failed `#8f1d1d`, done `#2e8b3d`, diff add / del). System font stack. | `web/src/styles.css` |
| Brand | Create: wordmark as SVG outlines (no web font request), PNG export, favicon | `web/public/logo.svg`, `web/public/logo.png`, `web/public/favicon.svg` |
| Worker | Modify: `GET /config`; `POST /sessions` accepts `model` | `src/worker/router.ts`, `src/worker/types.ts`, `src/worker/index.ts` |
| Session | Modify: store and use the session's model; export `RESTORED_NOTE`; `sandboxRunning` in the snapshot | `src/session/engine.ts`, `src/session/store.ts`, `src/session/ports.ts`, `src/session/protocol.ts`, `src/worker/session-do.ts` |
| Core | Modify: `selectableModels` list; optional `meta` on the final `tool_output` of `read_file` and `list_files` | `src/core/config.ts`, `src/core/events.ts`, `src/core/tools.ts`, `src/core/agent.ts` |
| Config | Modify: assets `directory: "./dist"`, `not_found_handling: "single-page-application"`, `run_worker_first: ["/sessions", "/sessions/*", "/config"]`; scripts `build`, `dev:web`, `e2e` | `wrangler.jsonc`, `package.json`, `vite.config.ts`, `tsconfig.web.json` |
| Debug page | Move: the Phase 2 page stays reachable at `/debug.html` | `public/index.html` → `web/public/debug.html` |
| Test support | Modify: fake model marker `[ask]` (first turn runs `rm -rf tmp`, which is not allowlisted) | `test/support/fake-sse-server.ts` |
| Tests | Create: recorded event logs, reducer tests, E2E specs | `test/fixtures/events/*.jsonl`, `test/web/*.test.ts`, `e2e/*.spec.ts`, `playwright.config.ts` |
| Docs | Modify: README status and run instructions, `docs/limits.md` (G19, G21), ADR notes for D13 and D19 | `README.md`, `docs/limits.md`, `docs/architecture/web-codex-architecture-decision.md` |

Key Decisions: D6, D7, D13, D16, D17, D18, D19 (inherited).

Slice-level decisions:
- **P3-a. The view is a pure reduction of the event stream.** `reduce` takes `ServerFrame`s in order and returns the whole session view. A reload (`lastSeq=0`) and a live session go through the same function. `GET /sessions/:id` is used to tell 404 from "exists" and for the sandbox state (P3-o).
- **P3-b. Page URLs do not share a path with the API.** Pages are `/` and `/s/:id`; the API stays at `/sessions…`. With `not_found_handling: "single-page-application"`, a navigation that matches no file gets `index.html` without invoking the Worker, and `run_worker_first` sends the API paths to the Worker whatever the request's `Sec-Fetch-Mode` is (Cloudflare docs, Static Assets › Single Page Application, checked 2026-10-02).
- **P3-c. `GET /config`** → `200 {repo, sha, models: [{id, contextWindow}], defaultModel, maxSteps, maxTokens, maxTaskChars}`. No secret and no base URL.
- **P3-d. Model per session.** `POST /sessions {mode:"code", task, model?}`. `model` must be one of `selectableModels` (`deepseek-ai/deepseek-v4-flash`, `deepseek-ai/deepseek-v4-pro`, `moonshotai/kimi-k2.7-code`, `zai-org/glm-5.3`); otherwise `400`. Omitted → the config default. The id is stored in the session row and replaces `profile.model` for every run segment. A session created before this change has no stored model and uses the default. The menu shows the id without its vendor prefix, and a disabled "Auto · Not available yet" row (D19).
- **P3-e. Restore note.** `RESTORED_NOTE` moves to `protocol.ts`. An `error{source:"sandbox"}` whose message starts with it is a notice; any other `error` with source `model`, `sandbox` or `budget` is a failure card; source `tool` is inline (G17).
- **P3-f. Timeline order is `seq` order.** Items: user bubble, assistant text, a group of consecutive step rows, notice or failure card, approval marker. A step row shows the tool name and its main argument (`command`, `path`, or the patched paths). Rows are collapsed, except the one that is running and a command that exited non-zero.
- **P3-g. Diffs are rendered by our own component**, a unified view with old and new line numbers, as drawn. This is the D13 "decided in Phase 3" choice: the diffs are small, the design has no highlighting, and it avoids a dependency. The latest `file_changed` per path replaces the earlier one (the event carries the full diff against the baseline).
- **P3-h. One approval bar.** Title: "Approval required · {tool}". Body: the server's `reason`, and the open call's command or patch paths when there is one (G16). Primary button: "Approve" for finish, "Run once" for an open `run_command`, "Apply" for an open `apply_patch`, "Let it continue" when no call is open (3 failures). Secondary: Send (finish), "Don't run" / "Don't apply" (G14), "Redirect" (G13).
- **P3-i. Test-path warning.** If a changed path matches `(^|/)(tests?|__tests__)/` or `\.(test|spec)\.[cm]?[jt]sx?$`, "This change edits a test" is shown above the diff with the paths.
- **P3-j. Session list.** Fetched on load, after create and delete, when the window regains focus, and every 5 s while the tab is visible. The open session's row follows its own `status` events.
- **P3-k. Reconnect.** A socket that closes without code 1000 is reopened with `lastSeq` = the highest `seq` seen, after 0.5 s, doubling to 8 s. Frames with `seq` ≤ that value are ignored. Unfinished streamed text is dropped on reconnect; the persisted `message` replaces it.
- **P3-l. Tests.** Reducer, formatters and diff parser: Vitest in Node. Backend additions: the existing router and engine tests. Screens: Playwright against `vite build` + `wrangler dev` + `pnpm fake-model` (needs Docker, no cost). There is no jsdom component layer.
- **P3-n. Tool result numbers.** The `tool_output` with `stream:"result"` may carry `meta`: `{bytes}` for `read_file` (UTF-8 size of the whole file, before any cut) and `{files}` for `list_files` (number of paths, before any cut). The field is optional, so stored events and the eval's JSONL stay valid. Nothing is sent to the model.
- **P3-o. Sandbox state.** `SessionSnapshot` gets `sandboxRunning: boolean`. The UI reads it when a session is opened, when the window regains focus, and after each `status` event, and shows "Running" or "Stopped · starts again with your next message". It is not polled on a timer, so an idle session can still hibernate.
- **P3-m. Local dev.** `pnpm dev` (wrangler, :8787) and `pnpm dev:web` (Vite, proxying `/sessions` including WebSocket and `/config` to :8787). This is the ADR's stated fallback; `@cloudflare/vite-plugin` with containers stays unverified and unused.

Data flow: browser → `GET /config`, `GET /sessions`, `POST /sessions` → WebSocket `/sessions/:id/ws?lastSeq=N` → `reduce` → React. The web app imports types and constants only from `src/core/events.ts` and `src/session/protocol.ts`.

New dependencies: `react`, `react-dom`, `vite`, `@vitejs/plugin-react`, `tailwindcss`, `@tailwindcss/vite`, `@playwright/test` (dev), a router (decided during build; a hand-written two-route switch is acceptable).

## Acceptance Scenarios

### S1: A recorded run reduces to the drawn session view
**Given** `test/fixtures/events/happy.jsonl`, the persisted events of one fake-model run up to the gate (recorded with `pnpm smoke`)
**When** the frames are reduced in order
**Then**
- The timeline is: user bubble "make the failing test pass"; a step group whose first row is `sandbox_setup` with "ready in … s"; rows `run_command npm test` (exit 1), `read_file src/sum.js`, `apply_patch src/sum.js` (`+1 −1`), `run_command npm test` (exit 0); assistant texts in their `seq` position.
- Every row has a duration equal to the `ts` difference between its `tool_call` and its last `tool_output`.
- The view's status is `awaiting_approval`, and the gate holds the approval id, tool `finish`, the summary and the diff summary.
- The header values are: step = the highest `stepId` number, context = the last `usage` event's `context_tokens` / `context_window`, cost = the sum of `usage.cost`.

**Test**: Unit — `test/web/reducer.test.ts` › "a recorded run reduces to timeline, gate and header totals"

### S2: Streamed text and replay give the same result
**Given** the live frames of one assistant turn: `message_delta` × n with id `m1`, then `message{id:"m1"}`
**When** they are reduced live, and separately only the persisted frames are reduced (no deltas)
**Then** while streaming, the view has one assistant item `m1` marked streaming whose text is the deltas joined; after `message`, both paths give the same single item, not streaming, with the message text. A delta for an id that already has a final message is ignored.
**Test**: Unit — `test/web/reducer.test.ts` › "deltas build one message and replay without deltas matches"

### S3: Command output is shown once, in order
**Given** a `run_command` call with three `stdout` chunks, one `stderr` chunk, and a final `result` chunk with `exitCode: 1`
**When** they are reduced
**Then** the row's output is the four chunks in `seq` order with the `stderr` one marked; the `result` text is not appended; the row shows "exit 1" in the failed color and is expanded. With `exitCode: null` the row shows "timed out". A `read_file` row uses the `result` chunk as its output.
**Test**: Unit — `test/web/reducer.test.ts` › "command rows show streamed chunks once; non-stream tools show the result"

### S4: The Changes panel follows `file_changed` and the gate's summary
**Given** two `file_changed` events for `src/sum.js` and one for `test/empty.test.js`, then `approval_required` whose `diffSummary` also lists `coverage/out.json` (2 additions)
**When** they are reduced
**Then**
- The panel lists three files. `src/sum.js` shows the second diff only. Totals are the sum of the per-file counts.
- `coverage/out.json` has its counts and the text "Changed by a command. Diff not available."
- A test-path warning names `test/empty.test.js`. With no test path in the changes there is no warning.
- The diff parser gives each line its old and new line numbers, and handles a new file and a deleted file.

**Test**: Unit — `test/web/reducer.test.ts` › "changes keep the latest diff per path and flag test paths"; `test/web/diff.test.ts` › "parses hunks, new files and deletions"

### S5: Every kind of gate gets the right bar
**Given** four event sequences that end in `approval_required`: finish; `run_command` with command `rm -rf tmp` and no result yet; `apply_patch` deleting `src/old.js` with no result yet; `read_file` after three failed results
**When** each is reduced
**Then** the gate view has, in order: primary "Approve" with Send; "Run once" / "Don't run" with the command text; "Apply" / "Don't apply" with the path; "Let it continue" / "Redirect". Each shows the server's `reason`. After `approval_resolved{approved:true}` the gate is cleared and the timeline has an "Approved" marker; after `approved:false` with a comment, the timeline has a user bubble with that comment.
**Test**: Unit — `test/web/reducer.test.ts` › "gate variants and resolution markers"

### S6: Errors are sorted into inline, notice and failure
**Given** events: `error{source:"tool"}` after a failed `read_file`; `error{source:"sandbox"}` starting with `RESTORED_NOTE` and naming `data/big.json`; `error{source:"sandbox", message:"the sandbox was lost"}` then `status(failed)`; `error{source:"model"}` then `status(failed)`; `error{source:"budget", message:"step limit reached (30)"}` then `status(budget_exceeded)`
**When** each is reduced
**Then** the tool error is on its step row and nowhere else; the restore note is a notice titled "Your changes are on a fresh checkout" with the server's sentence about `data/big.json`; the other three are failure cards titled "The sandbox was lost", "ai& did not answer" and "Limit reached", each with the server's message. The composer is enabled after `failed` and disabled after `budget_exceeded`.
**Test**: Unit — `test/web/reducer.test.ts` › "errors become inline rows, notices or failure cards"

### S7: `GET /config` returns what the UI needs and nothing secret
**Given** the router with `DEMO_REPO`, `DEMO_SHA` and an ai& key in its environment
**When** `GET /config` is called
**Then** it returns `200` with `repo`, `sha`, the four selectable models with their context windows, `defaultModel`, `maxSteps: 30`, `maxTokens: 400000`, `maxTaskChars: 4000`. The body contains neither the key nor the base URL. It is not rate limited.
**Test**: API — `test/worker/router.test.ts` › "config lists repo, models and limits without secrets"

### S8: A session runs on the model it was created with
**Given** the router and an engine over an empty store with a scripted model that records each request
**When** a session is created with `model:"deepseek-ai/deepseek-v4-pro"`; with no `model`; with `model:"openai/gpt-oss-120b"`; and when an engine is built over a store created without a model column
**Then**
- Pro: `201`; every model request of that session, including after a reject and after a rebuilt engine, uses `deepseek-ai/deepseek-v4-pro`, and `usage` events carry it.
- No model: the config default is used.
- Not on the list: `400` with an error that names `model`; no session is created.
- Old store: the session resumes on the default model without an error.

**Test**: API — `test/worker/router.test.ts` › "validates the model on create"; Integration — `test/session/engine.test.ts` › "a session keeps its model across segments and engines"

### S9: Spec test A in the browser
**Given** the built app on `wrangler dev` with the fake model, and the Home page open
**When** the user types "make the failing test pass", clicks Run, waits for the gate, and clicks Approve
**Then**
- The URL becomes `/s/<id>`. Within 2 s a "sandbox_setup" row is visible. Rows for `npm test`, `read_file`, `apply_patch` and `npm test` appear, and "Running the tests first." is visible as assistant text.
- At the gate: the header says "Awaiting approval"; the Changes panel shows `src/sum.js` with one removed and one added line; the bar shows "Approval required · finish", the agent's summary, and "Approve". No text on the page mentions a pull request or a branch.
- After Approve: the header says "Done", the bar is gone, and the note "Approved. Nothing was pushed: pull requests are not connected yet." is visible. The sidebar row for the session says "Done".

**Test**: E2E — `e2e/code-run.spec.ts` › "run, watch, approve"

### S10: Spec test C in the browser
**Given** a session at the gate (as in S9)
**When** the user types "also add a test for the empty array case" in the bar and clicks Send
**Then** the bar shows a sending state, then disappears; a user bubble with the comment is in the timeline; the header goes to "Running", then "Awaiting approval" again; the Changes panel now lists `test/empty.test.js` as a new file with the warning "This change edits a test".
**Test**: E2E — `e2e/code-run.spec.ts` › "reject with a comment loops back to the gate"

### S11: Spec test D in the browser
**Given** a session created with the task "[slow] make the failing test pass", while its first command is running
**When** `POST /sessions/:id/debug/kill-sandbox` is called, and afterwards the user sends "continue"
**Then**
- A failure card "The sandbox was lost" is visible, the header and the sidebar row say "Failed", and no spinner remains on the page.
- After the message: a second `sandbox_setup` row appears, the header says "Running", and the run reaches the gate.

Separately, with the task "[fail] x": a failure card "ai& did not answer" and "Failed" are shown.
**Test**: E2E — `e2e/failures.spec.ts` › "a killed sandbox and a failing model end in a visible failure"

### S12: A reload and a dropped socket lose nothing
**Given** a session that is running
**When** the page is reloaded mid-run; and separately the WebSocket is closed from the test while the run continues
**Then** after the reload the timeline shows the same rows as before and keeps growing. After the drop, "Reconnecting" is visible, then the timeline continues with no duplicated and no missing row compared with `GET`-ing the full replay, and the session reaches the gate.
**Test**: E2E — `e2e/reconnect.spec.ts` › "reload and reconnect replay from lastSeq"

### S13: A redirect typed while running is shown as queued, then as sent
**Given** a running "[slow]" session
**When** the user types "also rename the helper" in the composer and clicks Send
**Then** a bubble with that text and "Queued for the next step" appears at once; when the agent's next step starts, the label is gone and the bubble stays in the timeline exactly once.
**Test**: E2E — `e2e/code-run.spec.ts` › "a redirect is queued and then injected"; Unit — `test/web/reducer.test.ts` › "a pending message is resolved by its message or by a rejection with the same comment"

### S14: A command outside the allowlist asks first
**Given** a session created with the task "[ask] clean up"
**When** the gate appears, and the user clicks "Don't run"; and in a second session clicks "Run once"
**Then** the bar shows "Approval required · run_command", the command `rm -rf tmp`, and the reason "command not in allowlist: rm". After "Don't run" the run continues without the command having an exit code. After "Run once" the row shows an exit code.
**Test**: E2E — `e2e/gates.spec.ts` › "a command gate can be refused or run once"

### S15: The model menu sets the session's model
**Given** the Home page
**When** the user opens the model menu, picks `deepseek-v4-pro`, and clicks Run
**Then** the menu lists four models with a check on the current one, and "Auto" is disabled with "Not available yet". The `POST /sessions` body has `model:"deepseek-ai/deepseek-v4-pro"`. In the session, the meta line under an assistant turn reads `deepseek-v4-pro · … in · … out · … s`. Review and Task in the mode switch cannot be selected.
**Test**: E2E — `e2e/home.spec.ts` › "the picked model is sent and shown"

### S16: Create errors are shown on Home
**Given** the Home page, with `POST /sessions` answered by the test as `429` (`Retry-After: 60`), then `503`, then `400`
**When** the user clicks Run each time
**Then** the page shows "Too many new sessions. Try again in 60 seconds.", then "New sessions are turned off. Existing sessions still work.", then the server's error text. The task text is kept, and the URL stays `/`. The field shows the placeholder "Start your work, ship new feature!" when empty. Run is disabled while the field is empty, and the field does not accept more than 4,000 characters.
**Test**: E2E — `e2e/home.spec.ts` › "429, 503 and 400 are shown without losing the task"

### S17: Sessions can be listed, opened and deleted
**Given** two sessions, one at the gate and one done
**When** the user opens Home, clicks the first in the sidebar, chooses Delete from the "…" menu and confirms; then opens `/s/<deleted id>` and `/s/not-a-uuid`
**Then** both sessions are listed newest first with title, status and relative time. The confirm dialog says the run stops and the sandbox and history are removed. After confirming, the page is Home and the row is gone. Both URLs show "Session not found" with a link to Home. A second tab that had the session open shows "This session was deleted".
**Test**: E2E — `e2e/sessions.spec.ts` › "list, open, delete, and not found"

### S18: File sizes and file counts reach the step rows
**Given** a loop run with a scripted model that calls `read_file` on a 5,000-byte file containing multi-byte characters, and `list_files` on a repo of 3 files
**When** the events are collected and reduced
**Then** the final `tool_output` of `read_file` has `meta.bytes` equal to the file's UTF-8 size (not the length of the cut text), and the one of `list_files` has `meta.files: 3`. The rows show "5.0 kB" and "3 files". A stored event without `meta` shows the duration only. The tool message sent to the model is unchanged.
**Test**: Unit — `test/core/agent.test.ts` › "read_file and list_files results carry their size and count"; `test/web/reducer.test.ts` › "rows show meta when present"

### S19: The sandbox state is reported and shown
**Given** an engine with a session at the gate and its fake container running; then the container destroyed
**When** `snapshot()` is called before and after
**Then** `sandboxRunning` is `true`, then `false`. In the browser, the session's info block shows "Running" at the gate, and after Approve (the container is destroyed on `done`) it shows "Stopped · starts again with your next message".
**Test**: Integration — `test/session/engine.test.ts` › "the snapshot reports whether the sandbox is running"; E2E — `e2e/code-run.spec.ts` › "run, watch, approve"

### S20: The deployed URL passes A, C and D with the real model
**Given** the Worker deployed with the built app
**When** test A, then C, then D (kill through the debug route) are done by hand in the browser
**Then** the outcomes of S9, S10 and S11 hold with `deepseek-v4-flash`. The wordmark renders with no request to a font host. The built files in `dist/` contain neither `AIAND_API_KEY`'s value nor the string `api.aiand.com`.
**Test**: Runtime — deployed URL, about 3 real sessions. Needs Henry's OK before it is run (Open Questions).

## Edge Cases
- [ ] Unknown or later-phase events (`pr_opened`, `review_finding`, `review_posted`, `artifact`) do not break the reducer; they are ignored. — **Test**: `test/web/reducer.test.ts` › "unknown events are ignored"
- [ ] A frame with `seq` at or below the highest seen is ignored; persisted `seq` gaps are accepted. — **Test**: `test/web/reducer.test.ts` › "duplicate and gapped seq"
- [ ] A `rejected` frame (the server refused a client frame) clears the bar's sending state and shows its reason; it adds nothing to the timeline. — **Test**: `test/web/reducer.test.ts` › "a refused frame is shown, not stored"
- [ ] A `file_changed` diff that ends with the store's elision marker is rendered up to the marker with "Diff too large to show in full". — **Test**: `test/web/diff.test.ts` › "elided diff"
- [ ] Output of 1 MB in one row: the row's output box scrolls inside a fixed height and the page stays responsive. — **Runtime check**: a fake-model run of `yes | head -c 1000000` equivalent, by hand
- [ ] The timeline follows new rows only while the user is at the bottom; scrolling up stops it. — **Test**: `e2e/code-run.spec.ts` › "scroll position is kept when the user scrolled up"
- [ ] Delete answered with `429` shows "Too many requests. Try again in 60 seconds." and the session stays. — **Test**: `e2e/sessions.spec.ts` › "delete rate limit"
- [ ] The session list request fails (network): the sidebar keeps the last list and shows "Could not refresh". — **Test**: `e2e/sessions.spec.ts` › "list failure keeps the last list"
- [ ] Keyboard: Cmd/Ctrl+Enter runs or sends from a text field; the model menu and delete dialog close on Escape and return focus; every control has a visible focus ring. — **Test**: `e2e/home.spec.ts` › "keyboard"
- [ ] `prefers-reduced-motion`: spinners and the streaming cursor do not animate. — **Runtime check**: by hand with the OS setting
- [ ] Accent text on white is at least 4.5:1 (`#c54611`), and white on the accent fill is at least 4.5:1. — **Test**: `test/web/format.test.ts` › "token contrast"
- [ ] `/debug.html` still works. — **Runtime check**: open it locally and create a session
- [ ] `pnpm test`, `pnpm typecheck` (now also `tsconfig.web.json`), `pnpm lint` and `pnpm e2e` pass. — **Runtime check**: before the PR

Not applicable:
- Auth / PII: no users (spec D3).
- GitHub errors: no GitHub calls in this slice.
- Mobile layout: out of scope above.

## Open Questions
- [x] **G2 / P3-d: a real model picker**, limited to the four listed models; ADR D19 is amended in this slice. Known cost: `deepseek-v4-pro` is about 6–10× the price of flash, and there is no login (`limits.md` C1). (Henry, 2026-10-02)
- [x] **G4: the Phase 3 wording for Approve** ("Approve", then "Approved. Nothing was pushed: pull requests are not connected yet."), until Phase 4. (Henry, 2026-10-02)
- [x] **G6: Review and Task are shown disabled**, and each is enabled by the phase that builds it. (Henry, 2026-10-02)
- [x] **G23: the task field** shows "Start your work, ship new feature!". It is built as a placeholder in an empty field, not as a task that Run would send: as a task it tells the agent nothing. Say so if you meant a pre-filled task. (Henry, 2026-10-02)
- [x] **G8 / G10**: the optional `meta` on `tool_output` and `sandboxRunning` in the snapshot are in. (Henry, 2026-10-02)
- [ ] **Paid checks**: S20 needs about 3 real sessions on `deepseek-v4-flash` (¥0.1–0.3 each). I will ask right before running it. — decide by: Henry, at deploy time
- [ ] Assumption: Playwright E2E needs Docker running locally, like `pnpm smoke`. There is no CI yet, so E2E is run by hand before the PR. — decide by: during build
- [ ] Assumption: the wordmark is outlined from DM Sans 700 (SIL Open Font License) with the "&" in `#cf4a12`; the PNG is 1024 px wide on a transparent background. — decide by: during build

## Notes for Phase 4 (found while reading boards 5–9; not in this slice)
- **Identities (Henry, 2026-10-02).** There is no login, so everything &run opens is opened by the bot, and "My PRs" are the pull requests the bot opened. Reviews are posted as TseHang (the PAT). Board 8's sample data (TseHang requesting changes on a pull request TseHang wrote) is a drawing default, not the rule. One consequence to plan for: GitHub refuses Approve and Request changes on a pull request written by the reviewing account, so the pull request with the planted bug for spec test E must not be authored by TseHang.
- **Which commit a session starts from.** Review uses the pull request's head SHA (ADR, `pr-head@sha`). Code uses the pinned `DEMO_SHA` today, for two reasons: the demo repo's failing test must still be there after the agent's own fix is merged, and the unauthenticated GitHub API is limited to 60 requests an hour per IP, which a Worker shares with others. For a product that runs on any repo, Code should resolve the default branch's head when the session is created (with the App token) and store it in the session row, which already has a `sha` column and is what a rebuild uses. `DEMO_SHA` then becomes an optional override for the demo.
- **Review sessions never reach `awaiting_approval`.** In `policy.ts`, `finish` asks only in Code mode, so a review ends as `done`. The design shows "Awaiting approval" / "Ready to post" for reviews.
- **Findings are events and cannot be edited.** Edit, Dismiss and Restore need stored state and a way to send it; Post review needs a route. None exists yet.
- **The review brief** fits the code as it is: it becomes the task (the first user message). `POST /sessions` must accept `mode:"review"` and a pull request number.
- **Tab name**: ADR and spec say "Opened by agent"; the design says "My PRs". The spec also lists a search box and "add their own comments", which are not drawn.
- **My PR (board 9)**: reading review comments, replying, "Ask the agent to fix" and round 2 are not in the ADR.
- **G21** (diff for files changed by a command) should be fixed there, since opening a pull request needs those files.

## Build Progress
| # | Unit | Proves | Status |
|---|---|---|---|
| 1 | Backend: `GET /config`, model per session, `RESTORED_NOTE` export, `sandboxRunning`, `meta` on tool results | S7, S8, S18 (core), S19 (engine) | ✅ done |
| 2 | Build setup: `web/` Vite + React + Tailwind, assets as SPA, `/debug.html`, scripts, Playwright config, fake model `[ask]` | build, `/debug.html`, existing tests | ✅ done (wrangler's default `html_handling` answers `/debug.html` with a redirect to `/debug`, which serves the page) |
| 3 | View state: reducer, diff parser, formatters (fixture recorded from the fake model) | S1–S6, S13 (unit), S18 (rows), reducer/diff/contrast edges | ✅ done |
| 4 | Screens: Home, sidebar, session list, delete, not found | S15, S16, S17, list and keyboard edges | ⏳ pending |
| 5 | Screens: session view (timeline, Changes, approval bar, composer, reconnect, sandbox state) | S9–S14, S19 (browser), scroll edge | ⏳ pending |
| 6 | Brand: wordmark SVG outlines, PNG, favicon | S20 (no font request) | ⏳ pending |
| 7 | Docs: README, `limits.md`, ADR notes | — | ⏳ pending |

Test changes during the build:
- `test/worker/router.test.ts`: the fake session snapshot gained `sandboxRunning: false`. The fake was written before P3-o made the field part of `SessionSnapshot`; the meaning of the tests is unchanged.
- `test/web/reducer.test.ts` › "command rows show streamed chunks once…": the expected duration was `1.1 s` (the result's own gap) and is now `1.5 s`. P3-f and S1 define a row's duration as the time from its `tool_call` to its last `tool_output`; the old number contradicted that.
