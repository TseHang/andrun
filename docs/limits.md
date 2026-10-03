# &run — Known limits and to-dos

Things that work as designed but are less than a user might assume, plus open items to fix or decide later. Update this file when one is fixed or changes.

**Rule for the product:** the UI and its copy must not promise more than what is listed here.

Last updated: 2026-10-02 (end of Phase 2).

## Sandbox and workspace

| # | Limit | What the user could wrongly assume | Possible fix |
|---|---|---|---|
| L1 | A rebuilt sandbox restores **file contents only**. Background processes, `/tmp`, and anything git ignores (such as `node_modules`) start empty. | "My session was resumed on the same machine." | Say "your file changes on a fresh checkout". For dependencies: a snapshot (`DirectoryBackup` / container snapshot) instead of replaying files. |
| L2 | **Files over 1 MB (in bytes) are not saved.** After a rebuild they are missing; the restore note names them. | "All my changes are safe." | Store large files in R2 (the ADR's revisit condition for D8). |
| L3 | Changes are saved when the agent edits a file (`write_file`, `apply_patch`) and when a run pauses or ends. **A file changed only by a command is saved at the next of those points.** If the sandbox dies first, that change is lost and the run ends as `failed`. | "Anything the agent did is kept." | Reconcile after every `run_command` too (one extra `git diff` per command). |
| L4 | **Binary files are not saved** (anything that is not valid UTF-8 text). They are treated like L2: missing after a rebuild and named in the restore note. The check is a heuristic: a text file that contains the character U+FFFD is treated as binary too. | "All my changes are safe." | Store bytes (base64 or R2). |
| L9 | A file that could not be saved (L2, L4) **stays in the restore note for the rest of the session**, also if the agent later deleted it on purpose. | "The note lists what is missing right now." | Track deletions of unsaved files. |
| L8 | **Command output is capped at 1 MB per stream**; the rest is dropped with an "output truncated" marker. After a command exits, output from a background process it left behind is read for 2 s at most. | "I see everything the command printed." | A downloadable full log (R2). |
| L5 | The sandbox is rebuilt **lazily**: not when the session wakes up, but the next time the agent needs it (Reject, new message). Approving a finish never rebuilds. | "Opening the session brings the sandbox back." | None needed; show "Starting sandbox…" again on a rebuild (it does). |
| L6 | The agent's changes **cannot leave the sandbox yet**: no PR, no download. After `done` the container is destroyed; the changes stay in the session's storage until the session is deleted. | "Approve publishes my change." | Phase 4: PR on approve. |
| L7 | The first sandbox start after a deploy takes **about 11 s**; later starts take under 1 s. | "It hangs." | The "Starting sandbox…" step is shown; Phase 3 should make it prominent. |

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
| C1 | **Spend has a rate limit but no hard ceiling.** 5 new sessions per minute per IP, each up to 400k tokens. `KILL_SWITCH="1"` is the stop. Accepted for now (Henry, 2026-10-01). Revisit before the URL is shared publicly. | A cap on concurrently running sessions, or a daily session cap, in the WorkspaceDO. |
| C2 | The budget is **per session**. A message sent after `budget_exceeded` is accepted and shown, but the new turn stops again at once. | Say so in the UI; or a per-turn budget. |
| C3 | `POST /sessions/:id/debug/kill-sandbox` is public while `DEBUG_ENDPOINTS="1"`. It gives no more power than the public delete. | Set `DEBUG_ENDPOINTS="0"` after the demo. |
| C4 | Anyone with the URL sees and can delete every session (one shared workspace, spec D3). | Out of scope for this version. |

## Open observations (cause not confirmed)

- **O1. A container that never started.** Once, on the deployed Worker, `start()` was accepted but the container never ran, and a retry on the same session failed the same way. After the next deploy the same session started in 0.4 s. The cause is unknown. Since then `setup` reports the platform's reason at once ("the sandbox did not start: …"); that message has not appeared in production yet.
- **O2. The very first deployed session** failed with "The container has not been started". Two changes went in together (read the image at start time; set the idle timeout after the container answers) and the next deploy worked. Which one mattered, or whether it was O1 again, was not isolated.
- **O3. `npm test` ended about 10 s after its last output** on two cold-start sessions. npm's update check is the suspect (no network, DNS timeout). The image now disables it in npm's global config and a later run took 0.9 s, but that run was a warm start, so this is not confirmed.

## To-dos carried into later phases

- [ ] Phase 3: show the restore note (`error{source:"sandbox"}` after `sandbox_setup`) as a visible notice, with the names of files that were not restored (L1, L2).
- [ ] Phase 3: make the cold-start wait obvious (L7), and explain `budget_exceeded` (C2).
- [ ] Phase 3: a redirect typed while running is shown as "queued" in the browser only; the bubble is gone after a reload until the message is injected (F4).
- [ ] Phase 4: a file changed only by a command has no diff in the Changes panel, only line counts at the gate (L3). Emit its diff when a run pauses.
- [ ] Phase 4: Code sessions start from the pinned `DEMO_SHA`, not the branch head (ADR A8).
- [ ] Phase 4: PR on approve reads the changed files from the session's `changes` (L6); decide what to do with files over 1 MB (L2) and binary files (L4) before that.
- [ ] After merge: connect Workers Builds so `main` deploys automatically (Henry, in the Cloudflare dashboard).
- [ ] Before sharing the URL publicly: C1 and C3.
- [ ] Decide on F1 and F2 together: either watch `monitor()` for the whole run, or not at all.
