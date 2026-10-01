# &run SessionDO + Cloudflare Sandbox — Implementation Checklist

**Status**: ✅ Approved (Henry, 2026-10-01)
**Date**: 2026-10-01
**Architecture**: `docs/architecture/web-codex-architecture-decision.md` → Phase 2; `docs/architecture/spike-sandbox-1.0.md` (findings 1–6 are binding)

## Goal
As the builder of &run, I want the Phase 1 loop hosted on Cloudflare behind a public URL, so that a Code run can be started, watched, approved and refreshed from a browser, and Phase 3 only has to draw a UI over an event stream that already works.
This slice proves the three things the core cannot prove alone: state survives a refresh and an evicted Durable Object, the sandbox is isolated, and a lost sandbox is visible instead of a spinner.

## Scope
**In**
- Worker: router, static debug page, rate limit, kill switch, secrets (D14)
- `SessionDO`: one class that is both the session and the container host (D5). SQLite schema (D8), state machine (D6), WebSocket Hibernation API, replay from `lastSeq` (D7), approve / reject / redirect over WS
- `WorkspaceDO`: session index, `GET /sessions`, `DELETE /sessions/:id` (D16, D18)
- `CloudflareSandboxAdapter` implementing `SandboxAdapter`: tarball in, `git init` baseline, streamed exec, abort, idle destroy (D10, D15)
- Sandbox loss: mid-run → `failed` (spec test D); at resume → rebuild from tarball@SHA + `changes` (D11)
- `wrangler.jsonc`, `Dockerfile`, `.dev.vars.example`, deploy to the public URL
- A fake OpenAI-compatible SSE server for zero-cost local runtime checks
- Runtime answers to the two open spike items: hibernation while the container runs, and cold start after 15 idle minutes

**Out**
- The SPA (sidebar, timeline, diff panel, approval bar) → Phase 3. This slice ships one plain HTML debug page that prints raw event JSON.
- Anything GitHub: App, PAT, PR on approve, PR list, Review mode → Phase 4. Approving `finish` here only moves the session to `done`. The repo comes in as a **public** tarball, so no token exists anywhere in this slice.
- Task mode, auto-approve classifier, heterogeneous router → Phase 5 / bonus
- R2, D1, KV → D8 excludes them
- Changing any Key Decision, the §5 event contract, or the loop's control flow

## Technical Notes
| Area | Change | Files |
|---|---|---|
| Config | Create: Worker `andrun`, `SessionDO` (container, `scheduling_policy: durable_object`, SQLite via `exports`), `WorkspaceDO` (SQLite), two `ratelimits` bindings, `assets`, `nodejs_compat`. Pinned `@cloudflare/sandbox@1.0.0`, `wrangler@4.144.0`. No `max_instances` (finding 2). | `wrangler.jsonc`, `Dockerfile`, `.dev.vars.example`, `package.json` |
| Worker | Create: router as a pure `handle(request, env)` function; tarball fetch from `codeload.github.com` | `src/worker/index.ts`, `src/worker/router.ts`, `src/worker/repo.ts`, `src/worker/env.ts` |
| Session logic | Create: `SessionEngine` (state machine, persistence, replay, coalescing, watchdog) over three small ports: `SqlStore`, `SandboxHost`, `broadcast`. No `cloudflare:*` imports, so it runs under Node Vitest. | `src/session/engine.ts`, `src/session/store.ts`, `src/session/coalesce.ts`, `src/session/protocol.ts` |
| DO shells | Create: thin classes that wire `ctx.storage.sql`, `ctx.container`, hibernatable WebSockets and alarms into the engine | `src/worker/session-do.ts`, `src/worker/workspace-do.ts` |
| Sandbox | Create: `CloudflareSandboxAdapter` over `Pick<Container, …>` + `Files` | `src/sandbox/cloudflare-sandbox.ts` |
| Core | Modify (small): add `SandboxLostError` to `types.ts`; `executeTool` rethrows it instead of turning it into a tool result, so `guarded()` ends the run as `failed`. Nothing else in `src/core` changes. | `src/core/types.ts`, `src/core/tools.ts` |
| Lint | Modify: `src/session/**` also bans `cloudflare:*` and `@cloudflare/*` | `eslint.config.js` |
| Debug page | Create: plain HTML + inline JS, system fonts, no build step | `public/index.html` |
| Test doubles | Create: `node:sqlite`-backed `SqlStore`; a fake container that runs argv with `child_process` in a temp dir; fake SSE server | `test/support/node-sql.ts`, `test/support/fake-container.ts`, `test/support/fake-sse-server.ts` |
| Docs | Modify: README status and deploy section; spike doc "Still open" answered | `README.md`, `docs/architecture/spike-sandbox-1.0.md` |

Key Decisions: D5, D6, D7, D8, D10, D11, D14, D15, D16, D18 (inherited), plus D1 and D3 from Phase 1.

Slice-level decisions:
- **P2-a. Session logic is tested in Node, not in workerd.** `@cloudflare/vitest-plugin@1.3.4` needs `vitest ^4.1`, and this repo is on `vitest 5.0.2` (checked on npm, 2026-10-01). Rather than downgrade the test runner, the logic lives in `SessionEngine` behind ports and the DO classes stay thin. What only workerd can prove (hibernation, real container, real WS) is a runtime check.
- **P2-b. HTTP and WS surface.**
  - `POST /sessions` `{mode:"code", task}` → `201 {id}`
  - `GET /sessions` → `200 [{id, mode, title, status, created_at, updated_at}]`, newest first
  - `GET /sessions/:id` → `200 {id, mode, title, status, pending, debug:{bootId, containerRunning}}` or `404`
  - `DELETE /sessions/:id` → `204`
  - `GET /sessions/:id/ws?lastSeq=N` → WebSocket
  - Client → server frames: `{type:"approve", approvalId}`, `{type:"reject", approvalId, comment}`, `{type:"message", text}`
  - Server → client frames: an `AgentEvent`, or `{type:"rejected", reason}` for a frame the server refused (not persisted, no `seq`)
- **P2-c. One wire format.** Persisted and broadcast events are identical except `message_delta`, which is broadcast only. `tool_output` chunks for the same `callId` + `stream` are merged for up to 250 ms and flushed early when any other event arrives, so order is kept. A merged chunk carries the `seq` of its last part. Persisted `seq` values therefore have gaps; replay is "every persisted event with `seq > lastSeq`".
- **P2-d. Sandbox lost mid-run ends the run as `failed`; lost between runs is rebuilt.** This reconciles spec test D with D11. The adapter throws `SandboxLostError` when a call fails and `container.running` is false. At the start of every run segment (create, resume, new turn) the engine checks the container and rebuilds it if needed.
- **P2-e. `changes` is kept current on every `file_changed` event and reconciled against `git diff --name-status <baseline>` whenever a run segment ends.** The row holds the file content (≤ 1 MB) or a deleted marker.
- **P2-f. A run that was in memory when the DO was evicted is reported, not silently resumed.** While `status = running`, an alarm fires every 60 s. If it finds `running` in SQLite but no loop in memory, it emits `error{source:"sandbox", message:"the run was interrupted", next:"send a message to continue"}` and sets `failed`. The next user message starts a new turn from the last checkpoint (D6).
- **P2-g. Host-side steps are shown as ordinary step rows.** Sandbox setup is emitted by the engine as `tool_call{name:"sandbox_setup", summary:"Starting sandbox…"}` followed by `tool_output{stream:"result", chunk:"ready in 10.4 s"}`. This satisfies finding 3 without adding a 14th event type.
- **P2-h. The repo is fixed by configuration.** `DEMO_REPO` (`owner/name`) and `DEMO_SHA` (40 hex) are plain `vars`. `POST /sessions` takes no repo field, so a visitor cannot point the sandbox at another repo.

Data flow: browser → Worker `handle()` → rate limit → `SessionDO` RPC → `SessionEngine` → `runAgent` (core) → `OpenAICompatModelClient` (ai&) and `CloudflareSandboxAdapter` (container). Events: core `emit` → engine (coalesce, `INSERT`) → every WebSocket. Status changes: engine → `WorkspaceDO.upsert` after the local write.

New dependencies: `@cloudflare/sandbox@1.0.0`, `wrangler@4.144.0`, `@cloudflare/workers-types` (dev).
Secrets: `AIAND_API_KEY` (Worker secret / `.dev.vars`). `AIAND_BASE_URL` is a var.

## Acceptance Scenarios

### S1: A created session runs to the approval gate and is persisted
**Given** a `SessionEngine` over an empty `node:sqlite` store, a `ScriptedModelClient` scripted as `run_command("npm test") [fails] → read_file → apply_patch → run_command("npm test") [passes] → finish`, and a `CloudflareSandboxAdapter` over the fake container seeded with the `sum-off-by-one` fixture tarball
**When** `engine.create({mode:"code", task:"make the failing test pass"})` runs to completion of the segment
**Then**
- `session.status` is `awaiting_approval`, and `pending_approval` holds the `finish` call with its `diffSummary` (`src/sum.js`, 1 addition, 1 deletion).
- `events` holds, in `seq` order: `message(user)`, `status(running)`, the `sandbox_setup` step, the tool steps, `file_changed{path:"src/sum.js"}`, `approval_required`, `status(awaiting_approval)`.
- `messages` holds the transcript, and it equals the state the loop returned.
- `changes` has one row, `src/sum.js`, whose content is the fixed file.

**Test**: Integration — `test/session/engine.test.ts` › "create runs to the gate and persists events, transcript and changes"

### S2: A reconnecting client gets exactly the events it missed
**Given** the session from S1, with a client that has seen events up to `seq = k`
**When** it connects with `lastSeq = k`, and separately with `lastSeq = 0` and with `lastSeq` equal to the highest `seq`
**Then**
- `lastSeq = k`: it receives every persisted event with `seq > k`, in order, and nothing with `seq ≤ k`.
- `lastSeq = 0`: it receives the full history, and reducing it gives the same final status and pending approval as a client that was connected all along.
- `lastSeq = max`: it receives nothing until a new event is emitted.
- No replayed frame has `type: "message_delta"`. A client connected live during the run did receive `message_delta` frames.

**Test**: Integration — `test/session/engine.test.ts` › "replay sends only events after lastSeq, never deltas"

### S3: Approve and reject work over the socket
**Given** the session from S1 at the gate with approval id `A`
**When** a client sends, in separate runs: `{type:"approve", approvalId:A}`; `{type:"reject", approvalId:A, comment:"also add a test for the empty array case"}`; `{type:"approve", approvalId:"stale"}`; and `approve` for `A` twice in a row
**Then**
- Approve: events `approval_resolved{approved:true}` then `status(done)`; `pending_approval` is empty; `sandbox.destroy()` was called once.
- Reject: the next model request contains the comment in the `finish` tool result; the scripted model adds a test and calls `finish`; the session is `awaiting_approval` again with a new approval id.
- Stale id: the sender gets `{type:"rejected", reason:"no such pending approval"}`; no event is written; the status is unchanged.
- Double approve: the second frame gets `rejected`; exactly one `approval_resolved` event exists.

**Test**: Integration — `test/session/engine.test.ts` › "approve finishes, reject loops back to the gate, stale and duplicate decisions are refused"

### S4: The pause survives an evicted Durable Object
**Given** the session from S1 at the gate
**When** the engine object is discarded, a new `SessionEngine` is built over the same SQLite store, and a client sends `approve`
**Then** the outcome is the same as S3's approve, and the event `seq` values continue from the stored `next_seq` with no duplicates.
**Test**: Integration — `test/session/engine.test.ts` › "a fresh engine over the same store resumes from the gate"

### S5: Command output is coalesced and stays in order
**Given** a fake clock and a command that writes 40 stdout chunks over 1 s, then exits 0
**When** the run executes
**Then**
- At most 5 `tool_output{stream:"stdout"}` rows are persisted for that call, and their chunks concatenated equal the full output.
- Every one of those rows has a lower `seq` than the final `tool_output{stream:"result", exitCode:0}`.
- Clients receive the same frames that were persisted.

**Test**: Unit — `test/session/coalesce.test.ts` › "merges chunks within 250 ms and flushes before any other event"

### S6: The state machine accepts messages in every state (D6)
**Given** sessions in `done`, `failed`, `budget_exceeded`, `running` and `awaiting_approval`
**When** a client sends `{type:"message", text:"also rename the helper"}`
**Then**
- `done` / `failed` / `budget_exceeded`: a `message(user)` event is written, the status becomes `running`, and the next model request ends with that user message. The same transcript continues.
- `running`: the text is queued, and the next model request (the next step) contains it; one `message(user)` event is written at that point.
- `awaiting_approval`: it is handled as a reject of the pending approval with the text as the comment.
- Every transition wrote exactly one `status` event.

**Test**: Integration — `test/session/engine.test.ts` › "messages start a new turn, queue a redirect, or reject the gate, by state"

### S7: `CloudflareSandboxAdapter` meets the `SandboxAdapter` contract
**Given** the adapter over the fake container (argv run with `child_process` in a temp dir), and the `sum-off-by-one` fixture as a gzipped tarball stream
**When** `setup(tarball)` runs, followed by each port method
**Then**
- `setup` writes the tarball with `Files`, unpacks it with `--strip-components=1`, and records a 40-hex baseline commit.
- `exec("npm test")` returns exit 1 with the test output, and `onOutput` was called before the command finished.
- `writeFile("a/b/c.txt", "x")` succeeds when `a/b` does not exist (`mkdir` recursive first, finding 1).
- `readFile("missing.js")` throws an error whose message starts with `ENOENT`.
- `applyPatch` applies a patch whose hunk line counts are wrong (`--recount`), and returns `{ok:false, stderr}` for a patch that does not apply.
- `listFiles()` excludes `.git`. `diff()` is taken against the baseline, includes a new untracked file, and is still correct after the agent ran `git commit`.
- Every `exec` call the adapter made passed no `env` other than a fixed, secret-free set, and `start` was called with `enableInternet:false`.

**Test**: Integration — `test/sandbox/cloudflare-sandbox.test.ts` › "setup, exec, files, patch, list and diff behave like LocalSandbox"

### S8: Timeouts and aborts are reported as timeouts (finding 5)
**Given** the adapter and the command `sleep 30`
**When** it runs with `timeoutMs: 500`, and separately with an `AbortSignal` aborted after 200 ms
**Then** both return `{exitCode: null, timedOut: true}` in under 2 s. They do not return `exitCode: 137`. The tool result the model sees is `command timed out after …`.
**Test**: Integration — `test/sandbox/cloudflare-sandbox.test.ts` › "abort and timeout map to timedOut, not exit 137"

### S9: A sandbox killed mid-run ends the session as `failed` (spec test D)
**Given** a run in progress whose fake container is destroyed while `run_command` is executing
**When** the adapter's `exec` fails and `container.running` is false
**Then**
- The events are: `error{source:"sandbox"}` with a message that names the lost sandbox, then `status(failed)`.
- The session is `failed`. The transcript is valid: every `tool_call` has a tool message.
- No further model request is made, and the command is not retried.
- Separately, with a model that returns 500 three times: `error{source:"model"}` then `status(failed)` are persisted.

**Test**: Integration — `test/session/engine.test.ts` › "sandbox loss mid-run fails visibly" and "model failure fails visibly"; Unit — `test/core/tools.test.ts` › "SandboxLostError is rethrown, not fed back"

### S10: A sandbox lost between runs is rebuilt (D11)
**Given** the session from S1 at the gate, with the fake container then destroyed (empty workspace on restart)
**When** a client sends `reject` with a comment
**Then**
- Before the model is called, the engine starts the container, loads the tarball at the stored SHA, and replays `changes`.
- `sandbox.diff()` after the rebuild equals the diff that was shown at the gate.
- An `error{source:"sandbox"}` event says the workspace was restored, with `next` saying the run continues. The run then proceeds to the next gate.
- A row in `changes` marked deleted is deleted again in the rebuilt workspace.

**Test**: Integration — `test/session/engine.test.ts` › "rebuilds the workspace from tarball and changes before resuming"

### S11: An interrupted run is reported, not left spinning
**Given** a store whose session row says `running`, and a new engine with no loop in memory (the DO was evicted mid-run)
**When** the watchdog alarm fires
**Then** `error{source:"sandbox", message:"the run was interrupted", next:"send a message to continue"}` and `status(failed)` are persisted and broadcast. A following `{type:"message"}` starts a new turn from the last checkpoint. While a loop is in memory, the alarm changes nothing and re-arms itself.
**Test**: Integration — `test/session/engine.test.ts` › "watchdog fails a running session that has no loop"

### S12: The session index follows status changes (D16)
**Given** a `WorkspaceDO` store and two sessions created one after the other
**When** the first reaches `awaiting_approval` and the second `failed`, and `GET /sessions` is called
**Then**
- It returns both rows, newest first, with `title` = the first 80 characters of the task, and the current `status`.
- Each status transition produced one upsert, made after the SessionDO's own write.
- If an upsert throws, the session's own state is unaffected, and the next transition's upsert brings the row up to date.

**Test**: Integration — `test/session/workspace.test.ts` › "index lists sessions and follows status; a failed upsert heals on the next transition"

### S13: Delete frees everything, and a deleted session is 404 (D18)
**Given** a session at the gate with one WebSocket connected
**When** `DELETE /sessions/:id` is called, then `GET /sessions/:id`, a WebSocket connect, and `GET /sessions`
**Then**
- Delete returns `204`. The loop's signal was aborted, `container.destroy()` was called, the socket was closed with code 1000, and `storage.deleteAll()` ran.
- The index no longer lists the session.
- `GET /sessions/:id`, the WebSocket connect and a second `DELETE` all return `404`, and no `session` row was created by those calls.

**Test**: Integration — `test/session/engine.test.ts` › "delete tears down and later calls 404 without recreating"; API — `test/worker/router.test.ts` › "deleted or unknown sessions are 404"

### S14: Session create and delete are rate limited, and a kill switch stops new runs (D14, finding 2)
**Given** the router with a fake rate limiter that allows 5 creates per minute per IP, and `CF-Connecting-IP: 203.0.113.7`
**When** that IP sends 6 `POST /sessions`, and separately `KILL_SWITCH="1"` is set
**Then**
- Requests 1–5 return `201`. Request 6 returns `429` with `Retry-After: 60` and a JSON `error`; no SessionDO was touched.
- Another IP is not affected. `DELETE` has its own limiter key.
- With the kill switch on, `POST /sessions` returns `503 {error:"new sessions are disabled"}`; `GET` routes and existing sessions still work.

**Test**: API — `test/worker/router.test.ts` › "rate limits create and delete per IP" and "kill switch blocks new sessions only"

### S15: Requests are validated
**Given** the router
**When** it receives: `POST /sessions` with invalid JSON; `mode:"review"`; an empty task; a task of 4,001 characters; a `repo` field; and WS frames that are not JSON or have an unknown `type`
**Then** the HTTP cases return `400` with a JSON `error` naming the field (the `repo` field is ignored, and the session uses `DEMO_REPO`). The WS cases get `{type:"rejected", reason}` and the socket stays open.
**Test**: API — `test/worker/router.test.ts` › "validates the create body"; Unit — `test/session/protocol.test.ts` › "parses client frames and rejects the rest"

### S16: The deployed URL runs a real session end to end
**Given** the Worker deployed to `https://andrun.<subdomain>.workers.dev`, with `AIAND_API_KEY` set as a Worker secret, and the debug page open
**When** a session is created with the task "make the failing test pass", the page is refreshed mid-run, and Approve is clicked at the gate
**Then**
- A "Starting sandbox…" step appears within 2 s of the create call and is followed by its ready time (finding 3).
- Events stream live; after the refresh the page shows the same history and keeps streaming.
- The session stops at the gate with a diff summary; Approve moves it to `done`; `GET /sessions` shows it as `done`.
- Inside the container, `env` lists only `HOME PATH PWD`, and `fetch("https://example.com")` fails (no egress).
- The served page and its response headers contain neither the ai& key nor the base URL's credentials.

**Test**: Runtime — on the deployed URL with the real ai& model (`deepseek-ai/deepseek-v4-flash`). First run locally with `wrangler dev` + Docker against `test/support/fake-sse-server.ts` (no cost). The deployed run needs Henry's OK (see Open Questions).

### S17: Test D on the deployed URL
**Given** a deployed session whose agent is in the middle of `run_command`
**When** `POST /sessions/:id/debug/kill-sandbox` is called (it calls `container.destroy()`)
**Then** within 5 s the debug page shows `error{source:"sandbox"}` and `status: failed`. `GET /sessions` shows `failed`. Sending a message afterwards rebuilds the sandbox and continues.
**Test**: Runtime — deployed URL, with the fake SSE flow repeated locally first.

## Edge Cases
- [ ] The tarball download fails (404, or network error) → `error{source:"sandbox"}` with the HTTP status, then `status(failed)`; no container is left running. **Test**: `test/session/engine.test.ts` › "tarball failure fails the session visibly"
- [ ] The container does not become ready within 60 s → same visible failure. **Test**: `test/sandbox/cloudflare-sandbox.test.ts` › "start timeout throws SandboxLostError"
- [ ] The DO crashed after writing events but before the checkpoint → on load, `next_seq` is `max(stored next_seq, max(events.seq) + 1)`, so no `seq` is reused. **Test**: `test/session/store.test.ts` › "next_seq never collides with stored events"
- [ ] Two tabs on one session → both receive every frame; a decision from one tab resolves the gate for both. **Test**: `test/session/engine.test.ts` › "create runs to the gate…" (every persisted event is broadcast once, in order); fan-out to two sockets is a runtime check
- [ ] A file over 1 MB was changed by a command → it is not stored in `changes`; a rebuild lists it in the restore note as not restored. **Test**: `test/session/engine.test.ts` › "oversized changes are skipped and reported"
- [ ] One event row stays under the 2 MB row limit: `file_changed.diff` is capped at 256 KB with an elision marker. **Test**: `test/session/store.test.ts` › "caps oversized event payloads"
- [ ] `src/session/**` and `src/core/**` have no platform imports. **Test**: `test/core/boundary.test.ts` › "src/core has no platform imports" and "src/session has no platform imports"
- [ ] Unknown routes → `404` JSON; a non-WebSocket request to `/ws` → `426`. **Test**: `test/worker/router.test.ts` › "unknown routes and non-upgrade ws requests"
- [ ] **Open spike item 1**: can the DO hibernate with a WebSocket open while its container is running? **Runtime check**: deployed session at the gate, socket open, no traffic for 5 min. Then `GET /sessions/:id`: a changed `debug.bootId` with the socket still open and `containerRunning: true` means yes. Then approve, to prove the run resumes. Result recorded in `spike-sandbox-1.0.md`.
- [ ] **Open spike item 2**: cold start after a long idle period. **Runtime check**: leave a session at the gate for 16 min, confirm `containerRunning: false` (the 15 min `setInactivityTimeout`, re-armed in the constructor when the container is running), then reject with a comment and record the "ready in … s" value and that S10's rebuild happened. Result recorded in `spike-sandbox-1.0.md`.
- [ ] Containers are destroyed on `done` and `failed`. **Runtime check**: `wrangler containers list` shows no running instance after S16 and S17.
- [ ] `pnpm test`, `pnpm typecheck` and `pnpm lint` pass, including the 53 Phase 1 tests. **Runtime check**: run all three before the PR.

Not applicable:
- Auth / PII: no users (spec D3). Write protection is D14 only (Q1 accepted).
- GitHub errors and rate limits: no GitHub calls with a token in this slice; the public tarball failure case is covered above.
- UI states: the debug page has no states beyond "connected / disconnected".

## Open Questions
- [x] **Demo repo**: public `TseHang/andrun-demo`, pinned at `0df6f53ec8a51785899d574c43db212513347537` (`package.json`, `src/sum.js`, `test/sum.test.js`; `node --test` fails 2 of 2). It is the Phase 4 PR target too. (Henry, 2026-10-01)
- [x] **One Worker, one environment**: Worker `andrun` serves the page, the API and the WebSocket on one origin; `main` is production. There is no preview environment. Before the PR merges, the branch is deployed once by hand with `wrangler deploy` for the runtime checks; this is the deploy that commits the class name `SessionDO` to `scheduling_policy: durable_object` (no rollback). After the merge, Henry connects Workers Builds so that a push to `main` runs `wrangler deploy` (Worker code, assets and container image). (Henry, 2026-10-01)
- [ ] **Paid checks.** S16, S17 and the two spike items need about 4 real sessions on `deepseek-v4-flash`, roughly ¥1–2 in total, plus container minutes inside the Workers Paid allowance. I will ask right before deploying. — decide by: Henry, at deploy time
- [x] **`POST /sessions/:id/debug/kill-sandbox`** stays on for the demo (`DEBUG_ENDPOINTS="1"`), sharing the delete limiter. (Henry, 2026-10-01)
- [x] **A message typed at the approval gate is treated as Reject + comment** (S6). (Henry, 2026-10-01)
- [x] **Limits**: create 5 / min / IP, delete 10 / min / IP, task ≤ 4,000 characters. No cap on concurrently running sessions for now; the accepted risk is that spend has a rate limit but no hard ceiling, with `KILL_SWITCH` as the stop. Revisit before the URL is shared publicly. (Henry, 2026-10-01)
- [ ] Assumption: the default container instance type is enough for `node --test` on the fixtures (the spike used the default). If a run is OOM-killed, move to `basic`. — decide by: during build
- [ ] Assumption: `node:sqlite` in Node 22.18 is close enough to DO SQLite for the queries used (plain `CREATE`/`INSERT`/`SELECT`/`DELETE`). The deployed run in S16 is the check on the real one. — decide by: during build

## Build Progress
| # | Unit | Proves | Status |
|---|---|---|---|
| 0 | Scaffold + contract, by the commander: packages, `protocol.ts`, `ports.ts`, `sandbox/container.ts`, `worker/types.ts`, test doubles (`node-sql`, `fake-container`, `tarball`), all acceptance tests | — | ✅ done |
| 1 | Core `SandboxLostError`, `session/coalesce.ts`, `session/frames.ts`, `session/store.ts`, lint rule | S5, S15 (frames), store edge cases, S9 (tool layer), boundary | ✅ done |
| 2 | `sandbox/cloudflare-sandbox.ts` | S7, S8, start timeout, loss detection | ✅ done |
| 3 | `session/engine.ts`, `session/workspace.ts` | S1–S4, S6, S9–S13 (engine), tarball failure, oversized changes | ✅ done |
| 4 | `worker/router.ts` | S13 (API), S14, S15 (HTTP), unknown routes | ✅ done |
| 5 | DO shells, `worker/index.ts`, `worker/repo.ts`, `wrangler.jsonc`, `Dockerfile`, debug page, fake SSE server | Local runtime (`wrangler dev` + Docker + fake SSE) | 🔨 in progress: `wrangler.jsonc`, `Dockerfile`, `.dev.vars.example`, fake SSE server written; DO shells, `index.ts`, `repo.ts`, debug page, worker tsconfig still to do |
| 6 | Deploy + runtime checks on the public URL (asks Henry first) | S16, S17, spike items 1–2 | ⏳ pending |

Build notes:
- The edge case "two tabs" is tested as "every persisted event is broadcast once, in order" (inside S1's test). The engine has one `broadcast` port; fanning out to several sockets is the Durable Object shell, which only runs in workerd, so two tabs are a runtime check.
- S6, `budget_exceeded`: the budget is per session (spec §6), so a message after `budget_exceeded` is accepted and shown, but the new turn stops again at once without a model call. The test asserts this instead of "the next model request ends with that message".
- Client-frame parsing lives in `src/session/frames.ts`, so `protocol.ts` stays types and constants only for the web app to import.
- Unit 3 review, two mistakes in the commander's own tests, fixed with no change to the spec's meaning: (1) the `atGate()` helper overwrote the engine factory with the engine instance, so three tests could not run; (2) S2, S3 and S4 expected Approve to produce `approval_resolved` → `status(done)`, but the core's `resume()` always passes through `running` first (D6: `awaiting_approval → running → done`). The implementer had made the engine drop that event to satisfy the tests; the commander removed that and corrected the tests to expect `approval_resolved`, `status(running)`, `status(done)`.
- Unit 3: a message that arrives in the short window after a pause was checkpointed and before the run segment finished cleaning up is answered with `rejected` ("the previous run is still finishing, try again"). Messages queued but never drained are injected at the first step of the next run.
