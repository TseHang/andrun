# Session UI (slices B + C) — Implementation Checklist

**Status**: ✅ Built — Passing (298 unit/API/render tests, 33 E2E). Approved (Henry, 2026-10-04: UI-c, scripts in preview, Stop in Review all OK)
**Date**: 2026-10-04
**Architecture**: `docs/architecture/web-codex-architecture-decision.md` (D7 event contract, D8 `changes` table, A21–A23 conversational flow). Follows `conversational-flow` (slice A, PR #6).

## Goal
As a user watching a Code session, I want the conversation to read like a conversation, to see what the agent is doing and be able to stop it, and to fold away or preview what it changed, so that I can follow and steer a run without reading raw text and long diffs.

Slice A made the agent wait for the user. This slice fixes the screen around it: the six problems Henry found in the live session, minus the flow itself.

## Scope
**In**

B — conversation
- Agent replies and agent questions render as markdown (`react-markdown` + `remark-gfm`). Raw HTML in a reply is shown as text, never as elements.
- Each agent reply has a small `&` marker on its left. User messages stay plain text in the bubble on the right.
- The usage line under a reply reads `5.4k in · 6.0k out · 34.3s`. No model name.
- While the session is `running`, the bottom of the timeline shows three animated dots and what the agent is doing now.
- A Stop button in the composer while the session is `running`. Stopping keeps the files changed so far and leaves the session at `Waiting for you`.
- Wording for a message sent while the agent runs says when the agent will read it.
- The plan card moves from the top of the Changes panel to just above the composer.

C — changes panel
- Each file card in Changes can be collapsed and expanded.
- The Changes panel can be hidden and shown; the choice is remembered in `localStorage`.
- An `.html` / `.htm` file in Changes has a Preview button that shows the file in an isolated `<iframe sandbox>`.
- `GET /sessions/:id/files?path=…` returns the saved content of a changed file.

**Out**
- Preview of a running app (opening a port on the sandbox) — needs the egress work; Henry agreed to the single-file version first.
- Preview of files other than `.html` / `.htm`, and of files the session did not change.
- Loading a previewed page's relative assets (`./style.css`, `./app.js`). Only what is inside the one file runs.
- Markdown in user messages, in the approval bar's summary, and in review findings.
- Syntax highlighting in code blocks.
- Stop at an approval gate or while a question is open (nothing is running there).
- Changes to the Review layout (findings panel, tabs). Review gets markdown, the marker, the usage line, the indicator and Stop because it shares `Timeline` and `Composer`; nothing else.
- Remembering which file cards are collapsed across reloads.
- The model rewriting `index.html` several times in the live session — cause still unknown, not a UI problem.
- Fixing the E2E specs from slice A that have never run (`e2e/conversation.spec.ts`).

## Technical Notes
| Area | Change | Files |
|---|---|---|
| Event contract | Add `{ type: "stopped" }` | `src/core/events.ts` |
| Core loop | A stop ends the turn cleanly instead of failing | `src/core/agent.ts`, `src/core/types.ts` |
| Protocol | Client frame `{ type: "stop" }` | `src/session/protocol.ts`, `src/session/frames.ts` |
| Engine | Handle `stop`; `fileContent(path)` from the `changes` table | `src/session/engine.ts`, `src/session/store.ts` |
| Worker | Route `GET /sessions/:id/files`; RPC on the DO | `src/worker/router.ts`, `src/worker/session-do.ts`, `src/worker/types.ts` |
| Web state | `stopped` → timeline notice; `activityLabel(view)`; `usageLine(usage)`; `isPreviewable(path)` | `web/src/state/reducer.ts`, `web/src/state/format.ts` |
| Web components | Create `Markdown.tsx`, `Activity.tsx`, `HtmlPreview.tsx`; modify the rest | `web/src/components/{Timeline,Composer,PlanCard,ChangesPanel,SessionPage}.tsx`, `web/src/api.ts`, `web/src/styles.css` |
| Fake model | Markers `[md]` (turn 0 is a markdown text reply) and `[html]` (writes `index.html`, then a text reply) | `test/support/fake-sse-server.ts` |
| Test setup | Component render tests in Node with `react-dom/server` (`renderToStaticMarkup`), no browser: include `test/**/*.test.tsx` in vitest and typecheck | `vitest.config.ts`, a tsconfig that covers `test/web/*.tsx` |

**Key Decisions**

Inherited: D7 (every event the UI renders is in `events.ts`; replay gives the same screen as live), D8 (`changes` holds the content of every changed file up to 1 MB), A21–A23 (a text reply waits at `awaiting_input`).

New in this slice:
- **UI-a — Stop is an abort with a reason, and ends at `awaiting_input`.** The engine aborts the run's `AbortController` with a stop reason. The core treats that reason differently from "session deleted": it emits `stopped`, sets `awaiting_input`, checkpoints, and does not destroy the sandbox. Today any abort ends as `failed` and destroys the sandbox; that stays for deletion only.
- **UI-b — A stopped transcript stays valid.** A model call cut off by Stop adds no assistant message. A tool call cut off by Stop gets a result, and tool calls of the same turn that did not start get `{"error":"stopped by the user"}`, so the next request is accepted by the provider.
- **UI-c — Preview reads the `changes` table, not the live sandbox.** This replaces the "new API that reads a file from the sandbox" from the discussion. Reason: the sandbox is destroyed when a session is done and stops after 15 idle minutes, but the saved content is always there, and reading it does not wake a container. Cost: only changed files up to 1 MB can be previewed, and the content is as of the last save (a save follows every file edit and every pause).
- **UI-d — The file API returns JSON, never `text/html`.** Serving agent-written HTML from the app's own origin would let it run as the app. The page puts the content in `<iframe sandbox="allow-scripts" srcdoc=…>`: scripts run, in an opaque origin, with no access to the app's page, storage or cookies.
- **UI-e — Plan card is open by default** above the composer, with a toggle to fold it to one line (`Plan · 2 of 5 done`). Henry's complaint was that the plan was not visible, so it does not start folded. Its list scrolls inside the card when it is taller than 40% of the window.
- **UI-f — Component tests render to a string in Node.** Docker image builds hang on this machine, so E2E may not run locally. Render tests give durable proof for what a component shows; clicks and `localStorage` are still E2E.

New dependencies: `react-markdown`, `remark-gfm` (approved by Henry). No `rehype-raw`.

Data flow, Stop: Composer → `{type:"stop"}` frame → `engine.handleFrame` → `controller.abort(STOP)` → core returns at its next check → `stopped` event + `status: awaiting_input` → reducer adds a notice.
Data flow, Preview: Preview button → `GET /sessions/:id/files?path=` → `SessionDO.fileContent` → `store.changes()` → `{ path, content }` → `srcdoc`.

## Acceptance Scenarios

### S1: An agent reply renders as markdown
**Given** an assistant timeline item whose text has a `## Heading`, a bullet list, `**bold**`, `` `inline code` ``, a fenced code block, a GFM table and a link `[docs](https://example.com)`
**When** the timeline renders
**Then** the output has an `h2`, `ul > li`, `strong`, `code`, `pre > code`, `table` and an `a` with `href="https://example.com"`, `target="_blank"` and `rel="noreferrer"`; none of the markdown markers (`##`, `**`, backticks) are shown as text
**Test**: Unit — `test/web/render.test.tsx` › "an agent reply renders markdown"

### S2: Raw HTML in a reply is not rendered
**Given** an assistant item whose text is `<script>alert(1)</script> <img src=x onerror=alert(1)> done`
**When** the timeline renders
**Then** the output contains no `<script` and no `<img` element; the word `done` is shown
**Test**: Unit — `test/web/render.test.tsx` › "raw HTML in a reply is not rendered as elements"

### S3: Agent replies carry the marker; user messages stay plain
**Given** a timeline with a user item `**fix** it` and an assistant item `Done.`
**When** the timeline renders
**Then** the assistant item has a marker with the text `&` and `aria-label="&run"` before the reply; the user item shows the literal text `**fix** it` with no `strong` element and no marker
**Test**: Unit — `test/web/render.test.tsx` › "agent replies have the & marker; user messages are plain text"

### S4: The usage line is short
**Given** usage `{ model: "deepseek/deepseek-v4-flash", tokensIn: 5432, tokensOut: 6012, latencyMs: 34310 }`
**When** `usageLine(usage)` is called
**Then** it returns `5.4k in · 6.0k out · 34.3s`; for `{ tokensIn: 812, tokensOut: 95, latencyMs: 940 }` it returns `812 in · 95 out · 0.9s`; the model name is not in either
**Test**: Unit — `test/web/format.test.ts` › "usage line"

### S5: The activity label says what the agent is doing
**Given** a view in each of these states
**When** `activityLabel(view)` is called
**Then** it returns
- `Thinking` — running, last item is a user message or a finished step
- `Writing a reply` — the last assistant item is streaming
- `Starting sandbox` — an open `sandbox_setup` row
- `Running npm test` — an open `run_command` row with that command
- `Editing src/sum.js` — an open `write_file` or `apply_patch` row for that path
- `Reading src/sum.js` — an open `read_file` row
- `Working` — any other open row
- `null` — status is not `running`

A command longer than 60 characters is cut with `…`.
**Test**: Unit — `test/web/format.test.ts` › "activity label"

### S6: The indicator is at the bottom of the timeline only while running
**Given** a view with status `running` and an open `run_command` row `npm test`
**When** the timeline renders
**Then** after the last item there is one element with `role="status"` and the text `Running npm test`, with three dot elements marked `aria-hidden`
**And given** the same view with status `awaiting_input`, **then** there is no such element
**Test**: Unit — `test/web/render.test.tsx` › "the activity indicator shows only while running"

### S7: Stop during a model call ends the turn and waits
**Given** a Code session that is running, its model call not yet returned, and one file already changed in an earlier step
**When** a client sends `{ "type": "stop" }`
**Then** the events end with `stopped` and `status: awaiting_input`; there is no `error` event; the snapshot status is `awaiting_input`; the sandbox is still running; the changed file is still in the changes; no assistant message was added for the cut-off call
**Test**: API — `test/session/engine.test.ts` › "stop during a model call ends the turn at awaiting_input and keeps the changes"

### S8: Stop during a command, with more tool calls queued in the same turn
**Given** a running session whose model turn called `run_command` (still running) and then `write_file`
**When** a client sends `{ "type": "stop" }`
**Then** the command is aborted (its final `tool_output` has `exitCode: null`); `write_file` does not run and the file is not written; both calls have a tool message in the transcript; the session is at `awaiting_input` after a `stopped` event
**Test**: API — `test/session/engine.test.ts` › "stop aborts the running command and answers the calls that did not start"

### S9: A message after Stop continues the session
**Given** the session of S8, stopped
**When** a client sends `{ "type": "message", "text": "use reduce instead" }`
**Then** the session runs again; the model request has the new user message last and every assistant tool call in it is followed by a tool message
**Test**: API — `test/session/engine.test.ts` › "a message after a stop starts a new turn on a valid transcript"

### S10: Stop is refused when nothing is running
**Given** a session at `awaiting_input`, at `awaiting_approval`, or `done`
**When** a client sends `{ "type": "stop" }`
**Then** the client gets `{ "type": "rejected", "reason": "The agent is not running." }`; no event is added and the status does not change
**Test**: API — `test/session/engine.test.ts` › "stop is refused when the agent is not running"

### S11: A stopped run shows a notice, live and on replay
**Given** a view that is running with a streaming assistant item and an open step row
**When** the reducer gets `stopped` and then `status: awaiting_input`
**Then** the timeline ends with a notice titled `Stopped` with the message `Changes so far are kept. Send a message to continue.`; the open row is closed and no item is streaming; `activityLabel` is `null`
**Test**: Unit — `test/web/reducer.test.ts` › "stopped closes open rows and adds a notice"

### S12: The composer shows Stop only while running, and says when a message is read
**Given** the composer rendered with `running = true`
**Then** it has a button named `Stop`, and the hint `The agent reads your message after its current step`
**And given** `running = false`, **then** there is no `Stop` button and no such hint
**And** a user item with `pending: true` shows `Queued · read after the current step` under the bubble
**Test**: Unit — `test/web/render.test.tsx` › "the composer shows Stop and the queue hint only while running"

### S13: Stop from the browser
**Given** a Code session started with `[slow] make the failing test pass`, open in the browser and running
**When** the user clicks `Stop`
**Then** the status label becomes `Waiting for you`; the timeline shows the `Stopped` notice; the indicator and the `Stop` button are gone; after a reload the same notice is shown
**Test**: E2E — `e2e/session-ui.spec.ts` › "Stop ends the run and the session waits"

### S14: The plan card sits above the composer
**Given** a Code session started with `[plan] make the failing test pass`, at its approval gate
**When** the page is shown
**Then** the `Plan` region is inside the floating bar, above the approval bar (its bottom edge is above the bar's top edge), and is not inside the Changes panel; it lists the three steps; clicking its header folds it to one line reading `Plan · 2 of 3 done` and clicking again shows the steps
**Test**: E2E — `e2e/plan.spec.ts` › "the plan is shown, kept across a reload, and unfinished steps are named at the gate" (its position checks change), and Unit — `test/web/render.test.tsx` › "the plan card lists its steps and counts the completed ones"

### S15: A file card collapses
**Given** a Code session with one changed file, its diff shown
**When** the user clicks the file's header
**Then** the diff lines are hidden, the header (path and `+N −M`) stays, and the header button has `aria-expanded="false"`; clicking again shows the diff
**Test**: E2E — `e2e/session-ui.spec.ts` › "a file card collapses and expands"

### S16: The Changes panel hides, and stays hidden after a reload
**Given** a Code session with one changed file
**When** the user clicks `Hide changes`
**Then** the Changes panel is gone, the timeline takes the width, and a button `Show changes` with the file count (`1`) is in the session header area; after a reload the panel is still hidden; clicking `Show changes` brings it back with the diff
**Test**: E2E — `e2e/session-ui.spec.ts` › "the Changes panel hides and the choice survives a reload"

### S17: The file API returns saved content
**Given** a session that changed `index.html` (content `<h1>Hi</h1>`) and deleted `old.txt`
**When** `GET /sessions/:id/files?path=index.html` is called
**Then** the response is 200, `content-type: application/json`, body `{ "path": "index.html", "content": "<h1>Hi</h1>" }`
**And** `path=old.txt` (deleted), `path=README.md` (not changed), a missing `path`, and an unknown session id each return 404 with `{ "error": … }`
**Test**: API — `test/worker/router.test.ts` › "reads a changed file's saved content", and `test/session/engine.test.ts` › "fileContent returns saved content and null for deleted, skipped or unchanged paths"

### S18: Previewing an HTML file
**Given** a Code session started with `[html] make a page`, waiting, with `index.html` in Changes
**When** the user clicks `Preview` on the `index.html` card
**Then** the card shows an `iframe` titled `Preview of index.html` whose `sandbox` attribute is exactly `allow-scripts` and whose document shows the page's heading; the button now reads `Diff`, and clicking it shows the diff again
**And** a card for a `.js` file has no `Preview` button
**Test**: E2E — `e2e/session-ui.spec.ts` › "an HTML file can be previewed in a sandboxed frame", and Unit — `test/web/format.test.ts` › "previewable paths"

## Edge Cases
- [x] A reply that is still streaming with an unclosed code fence renders without throwing, and the cursor is still shown — **Test**: `test/web/render.test.tsx` › "a streaming reply with an unclosed code fence renders"
- [~] deferred — styles are in place (`overflow-x-auto`, `break-words`), not looked at with long content A very long line in a code block scrolls inside the block; a long URL wraps; the timeline column does not grow wider — **Runtime check**: browser, 1440 px and 900 px wide
- [x] A link with a `javascript:` URL is not rendered as a working link — **Test**: `test/web/render.test.tsx` › "a javascript: link has no href"
- [x] An agent question (`question` item) renders as markdown too — **Test**: `test/web/render.test.tsx` › "an agent reply renders markdown" (second case)
- [x] Two Stop frames in a row: the second is refused, one `stopped` event — **Test**: `test/session/engine.test.ts` › "stop is refused when the agent is not running" (second case)
- [x] Stop with a message already queued: the run stops, then the queued message starts a new turn — **Test**: `test/session/engine.test.ts` › "a message queued before a stop starts the next turn"
- [x] Stop arrives as the run ends by itself (finish approved, PR being opened): nothing is aborted, no `stopped` event, the run's own outcome stands — **Test**: `test/core/agent.test.ts` › "an abort after the last check does not change the outcome"
- [x] Deleting a session still ends the run as before (no `stopped` event) — **Test**: existing delete tests in `test/session/engine.test.ts` stay green
- [x] The `stop` frame is validated: extra fields ignored, unknown types still refused — **Test**: `test/session/protocol.test.ts` › "parses a stop frame"
- [x] File API: `path` with `..` or a leading `/` is a plain lookup miss → 404, never a file read — **Test**: `test/worker/router.test.ts` › "reads a changed file's saved content" (traversal cases)
- [x] File API: a file over 1 MB or binary (stored as skipped) → 404; the card shows `Preview not available for this file` after the click — **Test**: `test/session/engine.test.ts` › "fileContent returns saved content and null…"; message is a **Runtime check**
- [~] deferred — the refetch on a new diff is implemented, not exercised Preview content changes while the preview is open (the agent edits the file again): the preview reloads when the file's diff changes — **Runtime check**: browser with the fake model
- [x] (E2E asserts `window.parent.document` is blocked) Script in the previewed page cannot read the app: `window.parent.document` throws inside the frame — **Runtime check**: browser console, plus the `sandbox` attribute assertion in S18
- [~] deferred — guarded with try/catch, not exercised `localStorage` is unavailable (private mode): the panel starts shown and the toggle still works for the visit — **Runtime check**: browser
- [~] deferred — not walked Panel hidden while an approval gate opens: the gate bar still shows the file list, the panel stays hidden — **Runtime check**: browser
- [~] deferred — relies on the existing global rule, not checked under emulation `prefers-reduced-motion`: the dots do not animate (existing global rule covers new animations) — **Runtime check**: browser emulation
- [~] deferred — `max-h-[40vh]` is set, not tried with a long plan Plan card taller than 40% of the window scrolls inside itself and does not cover the composer — **Runtime check**: browser with a 10-step plan
- [x] Existing E2E that locate the plan in the Changes panel or read the old usage line still pass after their selectors are updated — **Test**: `e2e/plan.spec.ts`, `e2e/code-run.spec.ts`

Not applicable: auth (the app has none); rate limiting on the file route (it reads SQLite only, like `GET /sessions/:id`, which has no limiter); migrations (no schema change; `stopped` is a new event type and old logs replay unchanged).

## Open Questions
- [ ] **Preview reads saved changes, not the live sandbox (UI-c).** This differs from what we discussed. Limits: changed files only, up to 1 MB, relative assets do not load. — decide by: Henry (approval)
- [ ] **Stop also shows in Review sessions**, because Review uses the same composer. A stopped review waits at `Waiting for you` and continues on the next message. If you would rather keep Stop to Code sessions, say so. — decide by: Henry (approval)
- [ ] **Preview runs the page's scripts** (`sandbox="allow-scripts"`), isolated from the app. A script in the page can still make network requests from the viewer's browser. The alternative is no scripts, which shows a static page only (a game or an interactive demo would not work). — decide by: Henry (approval)
- [ ] The marker is the character `&` in the accent color, not the logo image. — decide by: during build (change if it looks wrong on screen)
- [ ] E2E needs the sandbox image, and `docker buildx build` hung on this machine twice. If it hangs again, unit, render and API tests are the proof and the four E2E scenarios (S13, S15, S16, S18) plus the runtime checks are reported as not run. — decide by: during build
- [ ] A weak model may reply "I will now do X" and stop (known from slice A). Not addressed here. — decide by: later slice

## Build Progress
| # | Unit | Proves | Status |
|---|---|---|---|
| 0 | Acceptance tests, test setup for render tests, fake-model markers, the two dependencies | all scenarios fail for the right reason | ✅ done |
| 1 | Backend: `stopped` event, `stop` frame, core + engine stop; `fileContent`, DO RPC, `GET /sessions/:id/files` | S7–S10, S17, stop and file edge cases | ✅ done |
| 2 | Web state + conversation: reducer `stopped`, `usageLine`, `activityLabel`, `isPreviewable`; Markdown, marker, usage line, indicator, Stop, hints, plan card above the composer | S1–S6, S11, S12, S14 (render) | ✅ done |
| 3 | Changes panel: collapsible file cards, hide/show panel, HTML preview | S15, S16, S18 (E2E only) | ✅ done |
| 4 | E2E run and runtime check | S13–S16, S18, runtime edge cases | ✅ done (some runtime checks deferred, see notes) |

### Build notes
- The edge case "Stop arrives as the run ends by itself" is tested at the engine, where it can happen: `test/session/engine.test.ts` › "a stop that arrives while an approved finish is being published does not undo it". The core test is instead `test/core/agent.test.ts` › "a stop ends the turn waiting for the user, not as a failure".
- `e2e/home.spec.ts` read the model name from the usage line to show the chosen model was used. The line no longer has it; the spec keeps its check of the create request's `model` and now matches the new line format.
- One E2E was added beyond the list: `e2e/session-ui.spec.ts` › "an agent reply is rendered as markdown, with the & marker".
- Test fixed after unit 2: "raw HTML in a reply is not rendered as elements" forbade the string `onclick=` anywhere in the output, which also forbids showing the HTML as text (what S2 asks for). It now forbids a `div` element carrying `onclick` and checks the tags are shown escaped. The implementer's tag-stripping plugin, written to satisfy the wrong assertion, was removed.
- Added after the commit security check: a markdown image in a reply would be fetched by the browser on render, so a reply could send data out in the image URL. Images are rendered as links (`test/web/render.test.tsx` › "an image in a reply is a link, never loaded by the page").
- `e2e/conversation.spec.ts` (slice A) ran for the first time and failed 5 of 5 on one assertion: the user bubbles also include the task. The expected lists now start with the task; all 5 pass. This was listed as Out; it was fixed because the suite could not be green otherwise and the cause was the test.
- E2E ran with a scratch Docker config that has no `credsStore`: `docker-credential-desktop` does not answer on this machine, which is what hung the image build before. Command: `DOCKER_CONFIG=<dir with {} config.json and a cli-plugins link> DOCKER_HOST=unix://$HOME/.docker/run/docker.sock pnpm e2e`.
- Runtime walk: screenshots at 1440 px of the markdown reply, running with a queued message, stopped, plan at the gate, HTML preview, and the hidden panel; no console errors.
- Known: a message queued before Stop starts a new turn right after the stop (tested, intended). The streaming cursor sits on its own line under a markdown reply.
- Follow-up offered, not done: a CSP in the preview document to block network requests from previewed pages (breaks pages that load libraries from a CDN).
