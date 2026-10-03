# QA Report: Phase 3 Code workspace UI
Date: 2026-10-03
Branch: feat/workspace-ui
Tester: Carry (/qa-web), on local `wrangler dev` + the fake model, Chromium (Playwright)

## Summary
- Scenarios checked: 24. Passed: 21. Failed then fixed: 3. Not tested: 3 (see the end).
- Critical issues: 1, fixed (the sidebar showed a stale status after Approve).
- Security findings: none blocking. Two notes on the open API, both by design (no auth, ADR D3).
- Tests added: 2 (engine: index writes in order; E2E: sidebar after Approve).

## Issues found
| # | Severity | Description | Steps to reproduce | Fix |
|---|---|---|---|---|
| 1 | P1 | After Approve, the session page said Done, but the sidebar said Running once the page was left. | Run a task to the gate, Approve, go to Home. | The engine sent its index writes to the WorkspaceDO in parallel. Calls to another Durable Object arrive in any order, so an older "running" could land last. The writes are now queued one at a time (`src/session/engine.ts`). This bug was already in Phase 2; the sidebar made it visible. Test: `test/session/engine.test.ts` › "index upserts are applied in order even when one is slow"; `e2e/code-run.spec.ts` › "run, watch, approve" (last step). Rows already wrong in an existing local index are corrected only by that session's next status change. |
| 2 | P2 | Clicking into the task field drew an orange rectangle inside the composer card (Henry). The same ring appeared on the message and comment fields. | Click the task field on Home. | Browsers match `:focus-visible` on every click into a text field. Text fields no longer get the ring. The Home card darkens its edge on `focus-within`, and the message and comment fields turn white with a hairline. Buttons and links keep the accent ring for keyboard focus. |
| 3 | P3 | With no sessions, the sidebar showed a "Recent" heading over nothing. | Empty session list. | "No sessions yet" under the heading. |

Found along the way, not in the app: every local session leaves a `workerd-andrun-…` proxy container in Docker, and a `wrangler dev` that is not stopped cleanly leaves its `workerd` process running. 193 containers had built up. They were removed, and README now has the cleanup command.

## Results
| # | Area | Check | Result |
|---|---|---|---|
| 1 | Happy path | Run, watch, approve; reject with a comment; command gate refused or run once | Pass (E2E) |
| 2 | Input | `<img src=x onerror=alert(1)>` with Chinese and emoji as the task | Pass: shown as text in the title, sidebar and bubble; no dialog, no `<img>` element |
| 3 | Input | Task of 4,001 characters; Enter in the task field | Pass: capped at 4,000; Enter adds a newline, Cmd/Ctrl+Enter runs |
| 4 | Display | Long title | Pass: titles are cut to 80 characters by the server; no horizontal overflow at 1440 or 1024 px |
| 5 | Display | 1 MB of output in one row | Pass: the box stays 320 px and scrolls |
| 6 | Display | Empty session list | Fixed (issue 3) |
| 7 | Interaction | Double-click Run | Pass: one POST |
| 8 | Interaction | Double-click Approve | Pass: one approval; the second frame is refused quietly |
| 9 | Interaction | Back and forward between Home and a session | Pass |
| 10 | Interaction | Keyboard: Tab order, focus ring, Escape closes menu and dialog | Pass (E2E) |
| 11 | Interaction | Focus look of text fields | Fixed (issue 2) |
| 12 | Network | Create fails (network error) | Pass: "Could not start the session.", task kept |
| 13 | Network | 429, 503, 400 on create; 429 on delete; list request fails | Pass (E2E) |
| 14 | Real-time | Reload mid-run; socket dropped mid-run | Pass (E2E): no lost or doubled rows |
| 15 | Real-time | Approve in one tab, a second tab open on the same session | Pass: the second tab shows Done and drops its bar |
| 16 | Real-time | Sidebar status after leaving an approved session | Fixed (issue 1) |
| 17 | State | Sandbox shown as Running while the run goes on, Stopped after Done | Pass |
| 18 | Motion | Reduced motion | Pass: spinners do not animate |
| 19 | Regression | `/debug.html` still creates sessions | Pass (redirects to `/debug`) |
| 20 | Regression | Unit/integration suite, typecheck, lint | Pass: 159 tests |
| 21 | Regression | Whole E2E suite | Pass: 13/13 |

## Security
| Vector | Status | Notes |
|---|---|---|
| XSS | Pass | All user and model text is rendered as React text; no `innerHTML` in `web/src`. |
| CSRF | Note | No auth (ADR D3), so a third-party page could POST to `/sessions`. It gains nothing over calling the API directly. The limits are the per-IP rate limit and `KILL_SWITCH`. |
| IDOR | Note | Anyone with a session id can open it, and `GET /sessions` lists every session. This is by design while there is no login. Ids are random UUIDs. |
| Rate limiting | Pass | Create 5/min, delete 10/min per IP (router tests). `GET /config` is not limited and reads no Durable Object. |
| Input validation | Pass | Server-side: mode, task length and model allowlist (router tests). |

## Not tested here
- Safari and Firefox: only Chromium was run.
- Widths under 1024 px: out of scope (checklist).
- (Done later the same day: S20 on the deployed Worker passed, see the checklist.) One stale row from before the fix ("what you can do", shown as Running) is also in the deployed index; it is corrected the next time that session changes status, or by deleting it.
