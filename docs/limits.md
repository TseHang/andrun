# Known limits

Current behavior and gaps, checked against repository source on **2026-10-05**. This is not a fresh deployment audit. Runtime observations below retain their original verification scope. Future work lives in [todos.md](todos.md); design and verification records are indexed in [Docs & progress](README.md).

The product must not promise more than these boundaries. IDs are retained so earlier checklists remain readable.

## Sandbox and files

| ID | Current boundary |
|---|---|
| L1 | Rebuilds restore saved **file contents**, not a running machine. Processes, `/tmp`, dependencies and git-ignored files start empty. |
| L2 | Changed files over **1,000,000 bytes** are not saved. After a rebuild they are unavailable; the restore notice names them. |
| L3 | File tools save changes after edits; command-only changes are reconciled when a run pauses or ends. A sandbox lost before reconciliation can lose those changes. Command-only diffs appear at the pause, not live. |
| L4 | Binary files are not saved. Detection uses decoded text containing U+FFFD, so a text file containing that character is also rejected. |
| L5 | Rebuild is lazy: the next agent action starts a sandbox. Opening a session does not; approving a finished Code change needs no sandbox. |
| L6 | Code approval publishes saved changes. Binary or oversized changes block PR publication and leave the gate open. |
| L7 | Cold starts can take several seconds. About 11 s cold and under 1 s warm were observed in earlier deployed runs; these are measurements, not latency guarantees. The UI shows “Starting sandbox”. |
| L8 | Command output is capped at **1,000,000 JavaScript string units per stream**, not 1 MB of bytes. Extra output is dropped with a marker; pipes left by background processes are waited on for at most 2 s after exit. |
| L9 | An unsaved file remains in restore notices for the rest of the session, even if subsequently deleted. |
| L10 | New files publish with mode `100644`; modified files keep their base mode. Executable-bit-only changes are not published. Publication also refuses a repository tree that GitHub reports as truncated. |
| L11 | **Code and Task allow every shell command without approval.** Commands can delete files or alter `.git`, bypassing file-tool protections. Deleting patches still ask, and a Stop button exists. Review has no file-editing tools and restricts command syntax, but allowed test commands execute repo code and can have filesystem side effects. |
| L12 | Task delivers `.html`/`.htm`, `.md` and `.csv`. Other saved text files are working files, not downloads in the Files panel. Images, PDF and other binary outputs are unsupported. HTML should be self-contained; relative assets do not load in the preview. |
| L13 | Only Task has sandbox web access: HTTP/HTTPS GET/HEAD on ports 80/443, with **25,000,000 bytes per response**. The gate rejects literal IPs, localhost, single-label names, `.local` and `.internal`; it returns redirects to the client so followed hops are gated. This is a hostname filter, not DNS-resolution validation or a proven complete SSRF defense. No dedicated search tool exists. Code and Review remain offline, including package installation that requires downloads. |
| L14 | Task interception and CA trust have local runtime evidence for curl, Node and npm; other tools may fail certificate checks. Port 8443 failed locally. Deployed interception is unverified. GET URLs can carry task data outside the sandbox; restricted methods do not prevent exfiltration. `TASK_NETWORK="0"` or `KILL_SWITCH="1"` disables the gate. |
| L15 | HTML previews run scripts in an iframe with `sandbox="allow-scripts"`, without `allow-same-origin`. There is no preview CSP to block external requests. Agent or same-repo PR HTML can send browser requests, show misleading content inside the frame or consume CPU. |

## GitHub

| ID | Current boundary |
|---|---|
| G1 | The PR list contains open PRs only, at most 50. Code and Review use one operator-configured repo; there is no user account connection or repo picker. |
| G2 | Review refuses fork PRs and PRs with more than 100 changed files. Fork file previews are also refused. |
| G3 | “Needs review” / “Reviewed” in the PR list reflect &run sessions, not GitHub's complete review state. Deleting the session removes that signal. Separately, a Code session's review-comments panel reads submitted GitHub reviews and line comments, with pagination; empty, pending and dismissed reviews are omitted. |
| G4 | Review stays on its starting commit. New PR commits do not refresh its workspace or trigger a stale-head warning. “Review again” creates a new session for the current head. |
| G5 | Posting a review is one API request. If GitHub accepts it but the response is lost, retry can duplicate it. The error asks the user to check GitHub first. A recorded successful post is not repeated at the same gate. |
| G6 | Findings post under the configured reviewer's identity after a human click. Findings display as plain text in &run and Markdown on GitHub; mentions can notify people there. GitHub review comments in the Code side panel do render Markdown. |
| G7 | Review gets numbered patches in its initial message; above **60,000 JavaScript string units**, only file headings are included. Its sandbox holds the PR head, so `git diff` does not reconstruct the PR diff. GitHub can also omit individual patches. |
| G8 | Only unposted findings can be edited or dismissed, at the review gate. Posted findings are fixed. After posting, messages can start another review turn on the same commit while the PR is open; the next post includes only new kept findings. A new comment/verdict still requires another agent turn and finish gate. |
| G9 | Repeated Code approvals update the same open PR, including title and description. Merged or closed PRs block session actions except Stop; a new session is required to continue while they remain closed. Closure is polled on session reads/actions, with no webhook, so list status can lag; GitHub failures retain the last known state. |
| G10 | Code can hand selected reviews to the agent, but it does not reply to GitHub comments or mark threads resolved. Feedback becomes one message capped at the session message limit; excess text is truncated with a notice. |

## Session reliability

| ID | Current boundary |
|---|---|
| F1 | Sandbox loss while the model answers is noticed on the next sandbox operation. During a running command, earlier runtime checks observed detection within about 2 s; this is not a guarantee. |
| F2 | Startup attaches a pending `container.monitor()` promise. Earlier analysis identified possible delayed DO hibernation and extra idle container time; current production duration/cost has not been measured. |
| F3 | A persisted `running` session with no in-memory loop is failed by the 60 s watchdog; it needs a user message to continue. Automatic recovery is unimplemented. Evidence is from local tests. |
| F4 | Redirect messages queue in memory until consumed. Eviction can lose them, and reload loses the browser's unacknowledged bubble. A late message is applied when the run pauses or ends; at a gate it acts as Reject + comment. |
| F5 | During sandbox rebuild after a gate, snapshots can still report the old stored `awaiting_approval` state. In-memory handling rejects a duplicate decision and queues messages; eviction can expose the old gate again. Approving a finished Code change does not itself rebuild. |

## Cost, access and model routing

| ID | Current boundary |
|---|---|
| C1 | No hard global or per-session spend ceiling. Creation is limited to 5 sessions/minute/IP; each user message can start another paid turn. Task has no per-session web-request count cap. The kill switch stops new sessions and GitHub writes and disables Task egress; it is not a cancellation mechanism for all existing model calls. |
| C2 | The agent checks a **¥50 list-price estimate per turn**, or 4,000,000 tokens for an unpriced model. In-flight calls can overshoot. A new turn resets the limit; the header shows session usage estimates and turns red above ¥10. Estimates use configured uncached input/output prices, not a provider invoice. |
| C3 | The sandbox-kill debug endpoint is exposed when `DEBUG_ENDPOINTS="1"` (the checked-in configuration). |
| C4 | No login or session ownership: visitors share one workspace and can read/delete every session. Persistent session history is not cross-session memory or saved user preferences. |
| C5 | Visitors can approve PR writes as the App bot and post reviews as the configured PAT account (TseHang in this demo). Writes are limited to 10/minute/IP, reads to 60/minute/IP. `GITHUB_WRITES="0"` or the kill switch blocks GitHub writes; per-user authorization is absent. |
| C6 | Outgoing GitHub requests have separate 240/minute budgets for routes, sessions and PR-state reads. They limit bursts, not total hourly quota consumption, and visitors share each budget. Exhaustion can interrupt other visitors' workflows. |
| C7 | Auto classifies only the latest user message, truncated to 4,000 characters, with fixed daily/complex routes. Failure falls back to daily; there is no mid-turn escalation or comparative cost/quality eval. Classifier usage is not included in displayed cost or the turn limit. Provider-side routing and cache optimization are hypotheses, not integrations. |
| C8 | Streamed reasoning is displayed/stored but not sent back in subsequent model messages. The effect on multistep task quality has not been evaluated. |

## Verification and unresolved observations

- **Task verification:** its checklist records 347 local unit/integration tests, typecheck and lint passing. One full E2E run had 40/41 passes; the failed case passed alone. A second full run was stopped after different existing Code timeouts, which passed after container cleanup. Container buildup is a suspected cause, not established. Task flows passed locally; this is not a clean full-suite or deployed acceptance result.
- **O1/O2 — startup:** earlier deployed runs saw a container never start and an initial “The container has not been started” error. Later deploys worked; the cause was not isolated.
- **O3 — npm delay:** two cold runs ended about 10 s after their last output. Disabling npm's update check preceded a faster warm run; causality was not confirmed.
- **O4 — review post:** on 2026-10-03, deployed post attempts returned HTTP 522/520 before a later attempt succeeded after redeploy. No duplicate was observed; the failing network hop was not isolated.

Historical details and runtime evidence remain in the [implementation records](README.md#implementation-records). No new deployed verification or paid evaluation was performed for this documentation update.
