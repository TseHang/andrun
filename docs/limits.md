# &run — Known limits and to-dos

Things that work as designed but are less than a user might assume, plus open items to fix or decide later. Update this file when one is fixed or changes.

**Rule for the product:** the UI and its copy must not promise more than what is listed here.

Last updated: 2026-10-05 (Task mode, local verification).

## Sandbox and workspace

| # | Limit | What the user could wrongly assume | Possible fix |
|---|---|---|---|
| L1 | A rebuilt sandbox restores **file contents only**. Background processes, `/tmp`, and anything git ignores (such as `node_modules`) start empty. | "My session was resumed on the same machine." | Say "your file changes on a fresh checkout". For dependencies: a snapshot (`DirectoryBackup` / container snapshot) instead of replaying files. |
| L2 | **Files over 1 MB (in bytes) are not saved.** After a rebuild they are missing; the restore note names them. | "All my changes are safe." | Store large files in R2 (the ADR's revisit condition for D8). |
| L3 | Changes are saved when the agent edits a file (`write_file`, `apply_patch`) and when a run pauses or ends. **A file changed only by a command is saved at the next of those points.** If the sandbox dies first, that change is lost and the run ends as `failed`. Since Phase 4 such a file's diff is shown when the run pauses, not while it runs. | "Anything the agent did is kept." | Reconcile after every `run_command` too (one extra `git diff` per command). |
| L4 | **Binary files are not saved** (anything that is not valid UTF-8 text). They are treated like L2: missing after a rebuild and named in the restore note. The check is a heuristic: a text file that contains the character U+FFFD is treated as binary too. | "All my changes are safe." | Store bytes (base64 or R2). |
| L9 | A file that could not be saved (L2, L4) **stays in the restore note for the rest of the session**, also if the agent later deleted it on purpose. | "The note lists what is missing right now." | Track deletions of unsaved files. |
| L8 | **Command output is capped at 1 MB per stream**; the rest is dropped with an "output truncated" marker. After a command exits, output from a background process it left behind is read for 2 s at most. | "I see everything the command printed." | A downloadable full log (R2). |
| L5 | The sandbox is rebuilt **lazily**: not when the session wakes up, but the next time the agent needs it (Reject, new message). Approving a finish never rebuilds. | "Opening the session brings the sandbox back." | None needed; show "Starting sandbox…" again on a rebuild (it does). |
| L6 | Fixed in Phase 4: Approve opens a pull request. **A change that contains a binary file or a file over 1 MB (L2, L4) cannot be approved into a pull request**: the gate stays open and names the files. | "Approve always publishes my change." | Store such files in R2 and push them as blobs. |
| L10 | A pull request is built from stored file contents. **A new file is always pushed as a normal file (mode 100644), and a change of only the executable bit is not pushed.** A modified file keeps the mode it had. | "The pull request equals the sandbox exactly." | Store the mode with each change. |
| L7 | The first sandbox start after a deploy takes **about 11 s**; later starts take under 1 s. | "It hangs." | The "Starting sandbox…" step is shown; Phase 3 should make it prominent. |
| L11 | **In Code mode every command runs without asking** (ADR A17). A command can delete files or change `.git` (for example hide a file from the diff), which `write_file` and `apply_patch` refuse or ask for. What bounds it: no network, no secrets, a throwaway container, and the pull request is built from the same stored changes the gate shows, so a hidden change is not published either. | "Risky commands ask first." | An auto mode with a narrower rule set (ask for `rm -rf`, `git` writes), or a Stop button. |

| L12 | **Task delivers only `.html` (including `.htm`), `.md` and `.csv`.** The Files panel filters by extension; other text files are working files, saved in SQLite for rebuilds but not listed or downloadable. HTML should be self-contained with inline CSS, scripts and SVG. L2/L4 still apply; images and PDF are not supported. | "Any file the agent writes can be downloaded." | Additional formats and binary storage are a later slice. |
| L13 | **Only Task can read the web: GET and HEAD to public DNS names, HTTP/HTTPS on ports 80/443.** Other methods return 405; literal IPs, localhost, single-label, `.local` and `.internal` names return 403. Redirects return to the client and every followed hop goes through the gate. Each response stops at 25 MB (25,000,000 bytes). There is no search tool; fetched content is untrusted data. | "Task can search, upload files or submit forms." | Search needs Henry's provider/cost decision. Code and Review remain offline. |
| L14 | **Network and CA support were verified locally with curl, Node and npm only.** The CA is installed after start; Node gets `NODE_EXTRA_CA_CERTS` per exec, npm gets a global cafile. Other tools may report certificate errors. Nonstandard ports fail in the container (8443 verified); deployed interception is not yet verified. A GET URL can carry task text outside the sandbox. | "Every network tool works, or GET-only means no data can leave." | Verify deployed S10 with Henry's go-ahead; verify other tools only when needed. |

## GitHub (Phase 4)

| # | Limit | What the user could wrongly assume | Possible fix |
|---|---|---|---|
| G1 | The Pull requests page lists **open pull requests only, at most 50**, read live on each visit. | "All pull requests are here." | Pagination; a closed tab. |
| G2 | A pull request with **more than 100 changed files, or from a fork, cannot be reviewed** in &run (refused when the review is started). | "Any pull request can be reviewed." | Read every page of files; download fork tarballs. |
| G3 | "Needs review" and "Reviewed" come from &run's own sessions. **A review posted directly on GitHub is not seen**, and deleting the review session makes the pull request "Needs review" again. | "Reviewed means reviewed on GitHub." | Read the pull request's reviews from GitHub. |
| G4 | A review is posted on the commit the session started from. **If the pull request got new commits meanwhile, GitHub marks moved lines as outdated**; &run does not warn. | "The review is on the latest code." | Compare the head when posting and say so. |
| G5 | Post review is one request. **If GitHub accepted it but the answer was lost, pressing Post again creates a second review.** The error text says to check GitHub first. If the answer arrived, a repeat is not posted. | "Retry is always safe." | Create a pending review, then submit it (two steps, resumable). |
| G6 | **Findings are written by the model and posted under the reviewer's name** after the reviewer's click. &run shows the text as plain text; GitHub renders it as Markdown, so an `@name` notifies that person and links are live. | "What I see is exactly what GitHub shows." | Render Markdown in the findings panel, or escape mentions. |
| G7 | The agent sees the pull request's diff in its first message, cut to file names when the diff is over 60 KB. `git diff` inside the review sandbox shows nothing: the sandbox holds only the pull request's head. | "The agent ran git diff." | Unpack the base commit first, then the head on top. |
| G8 | Edit and Dismiss work only when the agent has finished, not while it runs. A posted review takes no more messages: a new review is a new session. | "I can curate findings as they arrive." | Queue finding edits like redirect messages. |
| G9 | Round 2 of a Code session **adds a commit to the same pull request while it is open**; the pull request keeps its first title and body. After it is closed or merged, the next approve opens a new one that holds all the session's changes. | "Each approve is its own pull request." | — |

## Failure handling

| # | Limit | Possible fix |
|---|---|---|
| F1 | A sandbox killed **while the model is answering** is noticed only when the agent next touches the sandbox, which can be many seconds later. Killed while a command runs, it shows within about 2 s. | Watch `container.monitor()` for the whole run and abort the run when it settles. |
| F2 | `setup` watches `container.monitor()` to learn why a start failed. A pending `monitor()` **keeps the Durable Object in memory for up to 15 min** after a successful start, so hibernation at the gate begins later and the container can live closer to 30 idle minutes than 15. | Measure the real cost; drop `monitor()` if start failures stop appearing. |
| F3 | A run that was in memory when the Durable Object was evicted (for example by a deploy) is marked `failed` by a 60 s watchdog; the user must send a message to continue. It is **not resumed automatically**. Proven by a test only; not yet seen on the deployed Worker. | Resume from the last checkpoint automatically. |
| F4 | Redirect messages typed while the agent runs are **queued in memory**; an eviction before the next step loses them. A message typed too late to reach the run is applied when the run pauses or ends: at an approval gate that means **Reject + comment**, also when the gate is for a command the user has not looked at yet. | Persist the queue. Show the queued message in the timeline at once. |

| F5 | While the sandbox is rebuilt after an Approve or Reject (up to about 11 s after a deploy), `GET /sessions/:id` **still reports `awaiting_approval`** with the old pending approval. A second decision sent then is refused; if the Durable Object is evicted during the rebuild, the gate is simply shown again. | Store `running` before the rebuild starts. |

## Cost and abuse (no login)

| # | Limit | Possible fix |
|---|---|---|
| C1 | **Spend has a rate limit but no hard ceiling.** 5 new sessions per minute per IP. A session has no budget: each turn stops at ¥50 (list price), and a message starts another turn. `KILL_SWITCH="1"` is the stop. Task additionally permits public web reads: GET/HEAD only, 25 MB per response, `TASK_NETWORK="0"` disables it (default "1"); the kill switch also disables the gate. There is no per-session request count cap. This exposure was accepted for the current audience (Henry, 2026-10-01); reconfirm before sharing the URL publicly. | A cap on concurrently running sessions, or a daily session cap, in the WorkspaceDO. |
| C5 | **Anyone with the URL can open pull requests as the bot and post reviews as TseHang** (ADR Q1, accepted). Limits: 10 GitHub writes per minute per IP, 60 pull request reads per minute per IP. `GITHUB_WRITES="0"` or `KILL_SWITCH="1"` turns the writes off. | A passcode or login. |
| C2 | **Closed (harness improvement, 2026-10-04).** The limit is per turn: ¥50 of model calls at list price, or 4,000,000 tokens for a model with no price. A message after `budget_exceeded` starts a new turn with a fresh limit. The header shows the session's total cost, in red above ¥10. | — |
| C3 | `POST /sessions/:id/debug/kill-sandbox` is public while `DEBUG_ENDPOINTS="1"`. It gives no more power than the public delete. | Set `DEBUG_ENDPOINTS="0"` after the demo. |
| C4 | Anyone with the URL sees and can delete every session (one shared workspace, spec D3). | Out of scope for this version. |

| C6 | **The App's GitHub quota (5,000 requests an hour) can be used up by visitors.** Reads are limited to 60 a minute per IP, and the Worker's GitHub requests to 240 a minute for the public routes and 240 a minute for the sessions (separate budgets, so list requests cannot block an approve). That bounds a burst but not an hour, and one visitor can use up the routes' budget for the others for that minute. When the quota is gone, GitHub's rate-limit message is shown and pull requests and reviews stop working until it resets. | A short cache for the pull request list; a login. |

## Open observations (cause not confirmed)

- **O1. A container that never started.** Once, on the deployed Worker, `start()` was accepted but the container never ran, and a retry on the same session failed the same way. After the next deploy the same session started in 0.4 s. The cause is unknown. Since then `setup` reports the platform's reason at once ("the sandbox did not start: …"); that message has not appeared in production yet.
- **O2. The very first deployed session** failed with "The container has not been started". Two changes went in together (read the image at start time; set the idle timeout after the container answers) and the next deploy worked. Which one mattered, or whether it was O1 again, was not isolated.
- **O4. Post review failed twice with HTTP 522 and then 520** on the deployed Worker (2026-10-03), while reads and the pull request publish worked in the same minutes. The third attempt, after a redeploy, succeeded. These codes come from the network between the Worker and GitHub, not from GitHub's API. No review was posted by the failed attempts and none was duplicated. Not reproduced since; if it comes back, look at `wrangler tail` during a post.
- **O3. `npm test` ended about 10 s after its last output** on two cold-start sessions. npm's update check is the suspect (no network, DNS timeout). The image now disables it in npm's global config and a later run took 0.9 s, but that run was a warm start, so this is not confirmed.

## To-dos carried into later phases

- [ ] Phase 3: show the restore note (`error{source:"sandbox"}` after `sandbox_setup`) as a visible notice, with the names of files that were not restored (L1, L2).
- [ ] Phase 3: make the cold-start wait obvious (L7), and explain `budget_exceeded` (C2).
- [ ] Phase 3: a redirect typed while running is shown as "queued" in the browser only; the bubble is gone after a reload until the message is injected (F4).
- [x] Phase 4: a file changed only by a command gets its diff when a run pauses (L3).
- [x] Phase 4: Code sessions start from the default branch's head; `DEMO_SHA` is an optional pin (ADR A8).
- [x] Phase 4: PR on approve reads the changed files from the session's `changes`; a change with a file over 1 MB or a binary file is refused (L6).
- [ ] After merge: connect Workers Builds so `main` deploys automatically (Henry, in the Cloudflare dashboard).
- [ ] Later: **My PR** (ADR A7): on a pull request &run opened, show the reviewer's comments and let the agent address them. A first version was built and taken out on 2026-10-03 (git tag `my-pr-a7`): a comment list inside the Code session with a Reply and an "Ask the agent to fix" button per comment felt wrong there. Open design questions: where it lives (not mixed into the Code session's timeline), and one action in the composer that hands all open comments to the agent instead of one click per comment. Roles when it comes back: the bot (the coder) replies; TseHang only reviews.
- [ ] Before sharing the URL publicly: C1, C3 and C5.
- [ ] Decide on F1 and F2 together: either watch `monitor()` for the whole run, or not at all.
