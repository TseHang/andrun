# &run GitHub: PR on approve + Review mode — Implementation Checklist

**Status**: ✅ Built — Passing (2026-10-03). Deployed from `feat/github` (version 2ec3ee1c) and S21 passed with the real model and the real GitHub.
**Date**: 2026-10-03
**Branch**: `feat/github`
**Architecture**: `docs/architecture/web-codex-architecture-decision.md` → Phase 4 (D4, D9, D10, D14; amendments A5–A8)
**Design**: Claude Design canvas, page "v3 aligned", boards 6–12: https://claude.ai/artifact/TZezwBinDXnfySoDgTwquD
**Also read**: `docs/limits.md` (L2, L3, L4, L6, C1–C4), product spec §3, §7, §8 (tests B and E), Phase 3 checklist "Notes for Phase 4"

## Goal
As a coder, I want Approve to open a real pull request, and as a reviewer, I want an agent to draft findings on a pull request that I then edit and post, so that the agent's work leaves the sandbox only through a click I made.
This closes `limits.md` L6 and makes spec tests B and E pass on the public URL.

## Fixed rules (Henry, 2026-10-03)
- No login. Every pull request &run opens is opened by the **GitHub App bot**. "My PRs" = pull requests the bot opened from a session.
- Reviews are posted with **Henry's PAT**, as TseHang. Replies on a pull request &run opened are posted by the bot, its author (changed 2026-10-03 after S21; before, replies also used the PAT).
- The repo is fixed: `TseHang/andrun-demo`. A Code session resolves the default branch's head when it is created (App token). `DEMO_SHA` stays as an optional override (A8).
- The My PR page (A7) is the first thing to cut. Its scenarios are S17–S19 and are built last.
- The pull request for test E is opened by the bot, not by TseHang.
- There is no prepared demo (Henry, 2026-10-03). A Code session can be given any task; the pull request it opens can then be reviewed in &run. `DEMO_SHA` is empty on the deployed Worker, and agent pull requests may be merged.

## Decisions for this slice
Each open question from the brief has one recommended answer. Henry confirms or changes them at the gate; they are repeated under Open Questions.

- **P4-a. Tool name.** The tool stays `report_finding`; the event stays `review_finding`. The ADR's Phase 4 scope line ("a `review_finding` tool") is corrected. Reason: the code, the prompt, the tests and board 10 already use these names, and a tool is a verb while an event is a noun. No code change.
- **P4-b. A review ends at a gate.** In `policy.ts`, `finish` asks in Review mode too (reason: `posting requires your decision`). The session goes to `awaiting_approval`; the UI labels that state "Ready to post" for a review session. The sidebar keeps "Awaiting approval". A message typed at this gate is Reject + comment, as in Code: the agent continues.
- **P4-c. Findings are stored in the session and travel as events.** A new `findings` table in the SessionDO (`id, path, line, severity, text, dismissed, edited, inline`). Edit, Dismiss and Restore are client frames on the session socket; the engine updates the row and emits `review_finding` again with the same `id`. The reducer replaces by `id`, so a reload and a second tab show the same list. No new event type: `review_finding` gets three optional fields (`inline`, `dismissed`, `edited`).
- **P4-d. Edits are accepted only at the gate.** While the agent runs, the core owns the event sequence, so the engine cannot emit. Edit and Dismiss are shown disabled until "Ready to post". This differs from board 10, which shows them active while running.
- **P4-e. Post review and Approve are frames, not HTTP routes.** Both resolve the pending approval, so they use the same path as today's `approve` frame: `{type:"post_review", approvalId, verdict}` and the existing `{type:"approve", approvalId}`. The rate limit and the kill switch are checked inside the SessionDO; the client IP is stored on the socket when it is accepted. A refusal is a `rejected` frame, which the approval bar already shows. Rule: a write that moves the session's state is a frame; a write that does not (a reply on GitHub) is an HTTP route.
- **P4-f. Round 2 goes to the same pull request while it is open.** The branch is `agent/<first 8 hex of the session id>-<n>`, starting at `n = 1`. A later Approve adds a commit to that branch and the pull request updates. Only when that pull request is closed or merged does `n` go up and a new pull request open. Reason: review comments stay next to the fix. This changes board 7's hint from "Starts round 2 (agent/7f3a-2)" to "Adds a commit to pull request #12".
- **P4-g. The pull request is built from the session's `changes` table,** not from the sandbox, so Approve works after the container is gone (L5). The table is brought up to date every time a run pauses or ends, which already covers files changed only by a command (L3).
- **P4-h. Files &run cannot push block the pull request.** If any changed file was not stored (over 1 MB, L2; binary, L4), Approve is refused with a visible error naming the files, and the session stays at the gate. Reason: the pull request must equal the diff the human approved. The alternative, opening the pull request without those files and saying so, is listed under Open Questions.
- **P4-i. Files changed only by a command get a diff (G21, L3).** When a run pauses or ends, the engine emits `file_changed` for every changed text file whose stored content differs from the last diff it emitted.
- **P4-j. One kill switch more, one limiter more.** `GITHUB_WRITES="0"` or `KILL_SWITCH="1"` turns off every GitHub write (open or update a pull request, post a review, reply). New per-IP limiters: `GITHUB_WRITE_LIMITER` (10 per 60 s) for writes and `GITHUB_READ_LIMITER` (60 per 60 s) for the `/pulls` routes. Creating a review session uses the existing `CREATE_LIMITER`.
- **P4-k. Which pull request is which.** Every open pull request can be reviewed, also one &run opened: its author is the bot and the review is posted as TseHang, so GitHub accepts Approve and Request changes. "My PRs": the author is the App bot and the head branch starts with `agent/`. "Needs review": open, and no review session for it has ended as `done`. A pull request can be in both tabs. The WorkspaceDO index gets a `pr` column, so the list can show the Code session that opened a pull request and the latest review session for it.
- **P4-l. The agent gets the diff with line numbers.** The sandbox stays without network (D10). It holds one snapshot, the PR head, as its baseline, so `git diff` is empty there. A second snapshot or a clone would make `git diff` work but would still not give the model line numbers, which test E needs. The first model message of a review is the brief plus the pull request's title, branches and per-file patches, each line prefixed with its line number in the new file (capped at 60 KB; beyond that, file names only). The timeline shows only the brief.
- **P4-m. Review body.** Inline comments: kept findings whose `path` and `line` are on the right side of a diff hunk. Other kept findings go into the review body as a list. The body ends with "Drafted with &run, checked and posted by a human." The agent's summary is not posted: it may mention dismissed findings.
- **P4-n. Pull request title and body.** `finish` gets an optional `title` argument in Code mode. Title: that value, else the session title. Body: the agent's summary, the task, the changed files, and "Opened by &run after a human approved it."
- **P4-o. GitHub is always on.** Local development and E2E run a fake GitHub (`pnpm fake-github`, port 8789) through `GITHUB_API_URL`, like the fake model. There is no "GitHub not configured" mode to build or test.
- **P4-p. Schema.** New SessionDO tables `findings` and `github_state` (one JSON row: PR number, base branch, branch, round, PR URL, commentable lines) are created on first write. The `session` table is not altered, so sessions from before this phase still open. Such a Code session resolves its base branch when it is approved.

## Design vs. contract
| # | The design shows | What is true | Resolution |
|---|---|---|---|
| H1 | Board 7: "Starts round 2 (agent/7f3a-2)" | P4-f | "Adds a commit to pull request #12"; "Opens a new pull request" when #12 is closed. |
| H2 | Board 8 rows: "21 added", "18 added, 3 removed" | GitHub's list call does not return line counts; one call per pull request would. | Rows show author, branch and age. Counts are on the start page. |
| H3 | Board 8: "Pull requests 3" in the sidebar | — | The count of open pull requests, read on load and when the window regains focus. |
| H4 | Board 10: Edit and Dismiss while running; Post review visible | P4-d | Disabled, with "You can edit findings when the agent has finished." |
| H5 | Board 11: "4 kept, 1 dismissed", "3 inline comments, 1 note in the summary" | P4-c, P4-m | Counted from the `review_finding` events. |
| H6 | Board 6: branch label `agent/c21e-1 → main` | P4-f | 8 hex characters: `agent/c21e7f3a-1 → main`. |
| H7 | Board 8: "2 comments to answer" on a My PR row | Needs one call per My PR. | Built with A7 only (S17). Without A7 the row says "Opened by &run". |
| H8 | Spec §3: a search box; the reviewer adds their own comments | Not drawn. | Out. Editing a finding's text is the only way to change what is posted. |
| H10 | Board 8 footnote: "the pull requests under Needs review are written by someone else" | P4-k | "My PRs are the pull requests &run opened from this workspace. Reviews are posted as TseHang." |
| H9 | Home: "TseHang/andrun-demo at 0df6f53" | With A8 there is no commit until a session exists. | With no override: "TseHang/andrun-demo · latest commit on the default branch". The session's Base commit comes from its own snapshot. |

## Scope
**In**
- `src/github/`: App JWT (PKCS#8, WebCrypto RS256), installation token cache, typed errors, Git Data publish (blobs → tree → commit → ref → pull request), pull request list / read / files, review post, diff-line parser. No `cloudflare:*` imports.
- Code: Approve at a finish gate opens or updates the pull request (`pr_opened`), boards 6 and 7
- Code sessions start from the default branch's head; `DEMO_SHA` override (A8)
- Pull requests page with three tabs (board 8)
- Review start page: diff from GitHub, editable brief, model menu, Start review (board 9, A6)
- Review session: `POST /sessions {mode:"review", pr, task}`, Activity / Files changed tabs, findings panel, jump to line (boards 10, 11)
- Edit / Dismiss / Restore, verdict, Post review as TseHang (`review_posted`)
- G21: diffs for files changed only by a command
- GitHub errors and rate limits shown in the UI (`error{source:"github"}`)
- Write kill switch and limiters (D14)
- Fake GitHub server for tests
- One Review eval case (spec §10)
- Docs: ADR amendments, `limits.md`, README (setup of the App, the PAT and the secrets)
- **A7, cut first**: My PR page: read review comments, reply as TseHang, Ask the agent to fix (board 12)

**Out**
- Login, OAuth, webhooks, more than one repo (spec §9)
- Pull requests from forks: a review of one is refused at create with a clear message
- Closed and merged pull requests on the list; more than 50 open pull requests; more than 100 files in one pull request (one page of each call)
- A search box and reviewer-written comments (H8)
- Editing a review after it is posted (spec §9)
- Storing binary or large files in R2 (L2, L4 stay; P4-h refuses instead)
- Preserving the executable bit of new files, and `chmod`-only changes (new limit L10)
- A two-step (pending → submit) review post. A timeout after GitHub accepted the review can produce a duplicate on retry (new limit L11).
- A second review in the same session after posting: the composer is disabled; "Review again" starts a new session
- Merging pull requests from &run
- Auto-approve, Task mode, dark mode, layouts under 1024 px
- F1–F5 and C1–C4 in `limits.md`

## Technical Notes
| Area | Change | Files |
|---|---|---|
| GitHub | Create | `src/github/app-auth.ts`, `src/github/client.ts`, `src/github/publish.ts`, `src/github/pulls.ts`, `src/github/review.ts`, `src/github/diff-lines.ts`, `src/github/index.ts` |
| Core | Modify: `finish` asks in Review; optional `title` on `finish`; optional fields on `pr_opened` (`number`, `branch`, `updated`) and `review_finding` (`inline`, `dismissed`, `edited`) | `src/core/policy.ts`, `src/core/tools.ts`, `src/core/events.ts`, `src/core/prompts.ts` |
| Session | Modify: review create, publish on approve, post review, finding frames, `file_changed` at pause, `github` and `guard` ports, `findings` / `github_state` tables, `pr` in the index, `sha` and `pr` in the snapshot | `src/session/engine.ts`, `src/session/store.ts`, `src/session/ports.ts`, `src/session/protocol.ts`, `src/session/frames.ts`, `src/session/workspace.ts` |
| Worker | Modify: `POST /sessions` for review and head resolution; `GET /pulls`, `GET /pulls/:n`; A7: `GET /pulls/:n/comments`, `POST /pulls/:n/comments/:id/replies`; `/config` gains `githubWrites`, `reviewBrief`, nullable `sha`; IP on the socket | `src/worker/router.ts`, `src/worker/types.ts`, `src/worker/index.ts`, `src/worker/env.ts`, `src/worker/session-do.ts`, `src/worker/workspace-do.ts` |
| Config | Modify: limiters 1003 and 1004; vars `GITHUB_API_URL`, `GITHUB_WRITES`; `run_worker_first` adds `/pulls`, `/pulls/*`; secrets `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_PAT` | `wrangler.jsonc`, `.dev.vars.example`, `package.json`, `playwright.config.ts` |
| Web | Create: `PullRequestsPage`, `ReviewStartPage`, `FindingsPanel`, `PrDiff`, `VerdictBar`, `PrCard`; A7: `ReviewComments` | `web/src/components/*.tsx` |
| Web | Modify: routes `/prs`, `/prs/:n`; sidebar item; reducer (findings, `pr_opened`, `review_posted`, github errors); approval bar label and branch; Home copy; API client | `web/src/app.tsx`, `web/src/api.ts`, `web/src/state/reducer.ts`, `web/src/components/Sidebar.tsx`, `ApprovalBar.tsx`, `SessionPage.tsx`, `Timeline.tsx`, `ChangesPanel.tsx`, `Composer.tsx`, `Home.tsx` |
| Eval | Modify: a review case checks an expected finding | `eval/run.ts`, `eval/cases/review-slugify.yaml`, a review fixture |
| Test support | Create: fake GitHub (in-memory refs, pull requests, reviews, comments; can fail on request); a key pair generated in the test | `test/support/fake-github.ts` |
| Docs | Modify | `docs/architecture/web-codex-architecture-decision.md`, `docs/limits.md`, `README.md` |

Key Decisions inherited: D4, D9, D10, D14, and A5–A8. D1 still holds: `src/core/` knows nothing about GitHub.

ADR amendments this slice records (A9–A12): P4-a (name), P4-b (review gate), P4-c (optional event fields; D7 stays at 13 event types), P4-f (D9's `<round>` goes up per pull request, not per approve).

Data flow:
- Approve (Code): browser `approve` frame → SessionDO checks the guard → reads `changes` → `github.publish` (App token) → `pr_opened` → index gets `pr` → the core is resumed → `done`.
- Review: `/prs/:n` → `GET /pulls/:n` → `POST /sessions {mode:"review"}` → Worker reads the PR head (App token) → SessionDO runs the review profile on `pr-head@sha` → `review_finding` events → gate → `post_review` frame → `github.postReview` (PAT) → `review_posted` → `done`.
- Tokens exist only between the Worker / SessionDO and `api.github.com`. Nothing goes into the sandbox or the browser.

New dependencies: none.

## Acceptance Scenarios

### S1: The App token is created, cached and renewed
**Given** an App id, an installation id and a PKCS#8 private key
**When** two GitHub calls are made within 50 minutes, then a third after 51 minutes
**Then** the first call requests an installation token with a JWT whose RS256 signature verifies against the public key and whose `iss` is the App id; the second reuses the token; the third requests a new one. A key that is not PKCS#8 fails with "GITHUB_APP_PRIVATE_KEY must be a PKCS#8 PEM".
**Test**: Unit — `test/github/app-auth.test.ts` › "signs a JWT, caches the installation token and renews it"

### S2: Publishing opens one pull request and is safe to repeat
**Given** a base commit, a branch name `agent/1a2b3c4d-1`, and changes: one modified file, one added file, one deleted file
**When** `publish` runs, then runs again with the same input, then runs after the first attempt failed right after the ref was created
**Then** GitHub has one commit on that branch whose tree is the base tree with those three changes (the modified file keeps its mode), authored by the bot, and one open pull request into the base branch. The second run creates nothing and returns the same URL. The third creates only the missing pull request.
**Test**: Unit — `test/github/publish.test.ts` › "opens one pull request; a retry reuses the ref and the pull request"

### S3: A later approve adds a commit to the open pull request
**Given** a session whose pull request #12 is open on `agent/1a2b3c4d-1`
**When** `publish` runs with more changes; and again after #12 was closed
**Then** first: the branch gets a second commit whose parent is the first, the result says `updated: true` and still points to #12. After the close: a new branch `agent/1a2b3c4d-2` from the session's base commit and a new pull request.
**Test**: Unit — `test/github/publish.test.ts` › "round 2 updates the open pull request, or opens a new one when it is closed"

### S4: Approve in a Code session opens the pull request
**Given** a Code session at the finish gate with one changed file, and the sandbox already stopped
**When** an `approve` frame arrives
**Then** the events are, in order: `pr_opened {url, number, branch}`, `approval_resolved {approved:true}`, `status done`. The index row has `pr` set. The sandbox was not started. The pull request title is the `title` from `finish` (or the session title), and the body contains the agent's summary and the task.
**Test**: API — `test/session/engine-github.test.ts` › "approve publishes from stored changes and ends as done"

### S5: A GitHub failure keeps the gate open
**Given** the same session, and GitHub answers 502 (or 403 with `x-ratelimit-remaining: 0`)
**When** `approve` arrives, and then again after GitHub recovers
**Then** first: `error {source:"github", message}` with GitHub's status in the message (for a rate limit: when it resets), `next: "Approve again to retry."`; the status stays `awaiting_approval` with the same `approvalId`; no `pr_opened`. Second: one pull request and `done`.
**Test**: API — `test/session/engine-github.test.ts` › "a GitHub error is shown and approve can be retried"

### S6: Files that cannot be pushed block the pull request
**Given** a Code session at the finish gate whose `changes` has one stored file and one skipped file (`logo.png`)
**When** `approve` arrives
**Then** nothing is sent to GitHub; `error {source:"github"}` says "The pull request was not opened: logo.png cannot be pushed (binary or over 1 MB)." with `next: "Ask the agent to remove or replace it."`; the status stays `awaiting_approval`.
**Test**: API — `test/session/engine-github.test.ts` › "a file that was not stored blocks the pull request"

### S7: Writes are limited and can be switched off
**Given** a session at a finish gate
**When** (a) `GITHUB_WRITES` is `"0"`; (b) `KILL_SWITCH` is `"1"`; (c) the write limiter refuses this IP
**Then** each `approve` (and each `post_review`) gets a `rejected` frame: "GitHub writes are disabled" for (a) and (b), "Too many requests. Try again in 60 seconds." for (c). GitHub receives no request and the gate stays. `GET /config` reports `githubWrites: false` for (a) and (b).
**Test**: API — `test/session/engine-github.test.ts` › "kill switch and rate limit refuse GitHub writes"; `test/worker/router.test.ts` › "config reports githubWrites"

### S8: A Code session starts from the default branch's head
**Given** `DEMO_SHA` is empty and the default branch `main` is at commit `abc…`
**When** `POST /sessions {mode:"code", task}`; and again with `DEMO_SHA` set to `0df6…`
**Then** first: the session row has `sha = abc…` and base branch `main`; `GET /sessions/:id` returns that `sha`. Second: the row has `0df6…` and no commit lookup is made. If GitHub fails in the first case, the answer is `502 {error}` and no session exists.
**Test**: API — `test/worker/router.test.ts` › "code sessions resolve the default branch head; DEMO_SHA overrides it"

### S9: A file changed only by a command gets its diff
**Given** a run where `npm run format` rewrote `src/a.js` and no edit tool touched it
**When** the run pauses at the gate
**Then** a `file_changed {path:"src/a.js", diff}` event follows, and it is not emitted again at the next pause unless the file changed. A skipped file gets no event.
**Test**: API — `test/session/engine-github.test.ts` › "a command-only change gets a file_changed event at the pause"

### S10: The pull request list
**Given** GitHub has three open pull requests: #14 (`agent/1a2b3c4d-1`, by the bot), #13 (`feat/json-flag`, by another account), #12 (`agent/7f3a9c1e-1`, by the bot); the index has a Code session and a review session at `awaiting_approval` for #14, and a Code session for #12
**When** `GET /pulls`
**Then** `200 {pulls:[…]}` newest first, each with `number, title, author, headRef, updatedAt, url, mine, codeSession, reviewSession`. `mine` is true for #14 and #12. Each session field is `{id, status}` or `null`: #14 has both, #12 has only `codeSession`, #13 has neither. With two review sessions for one pull request, the newest is returned. A GitHub failure gives `502 {error}`; a refused read limiter gives `429`.
**Test**: API — `test/worker/router.test.ts` › "pull list joins GitHub with the session index"

### S11: A review session is created from a pull request
**Given** open pull request #14 with head `a41c…` on the same repo
**When** `POST /sessions {mode:"review", pr:14, task:"<brief>", model?}`
**Then** `201 {id}`; the session has `mode: "review"`, `sha = a41c…`, title "Review PR #14: Add slugify helper", and `pr: 14` in the index. The first `message` event carries only the brief; the model's first message also carries the patches with new-file line numbers. Refused with `400`: `pr` missing or not a positive integer, an empty brief, a closed pull request ("pull request #14 is not open"), a fork ("pull requests from forks are not supported"). Unknown number: `404`.
**Test**: API — `test/worker/router.test.ts` › "review sessions are created from an open pull request"; `test/session/engine-github.test.ts` › "the review task carries the numbered diff"

### S12: A review cannot write and ends at the gate
**Given** a review session with a scripted model that calls `report_finding` twice (line 4, which is in the diff, and `README.md:3`, which is not), tries `rm -rf src`, then calls `finish`
**When** the run completes
**Then** two `review_finding` events with `inline: true` and `inline: false`; the `rm` call is denied and reported to the model; the status is `awaiting_approval` with `tool: "finish"`; `changes` is empty. An `approve` frame is refused: "Choose a verdict and post the review."
**Test**: API — `test/session/engine-github.test.ts` › "a review drafts findings and waits at the gate"; Unit — `test/core/policy.test.ts` › "review mode asks before finishing"

### S13: Findings can be edited, dismissed and restored
**Given** that session at the gate
**When** frames arrive: `{type:"finding", id, text:"new text"}`, `{type:"finding", id2, dismissed:true}`, `{type:"finding", id2, dismissed:false}`; and one while the agent is running; and one with an unknown id
**Then** each accepted frame emits `review_finding` with the same `id` and the new state (`edited: true` after a text change), and a replay from `lastSeq=0` ends in the same list. The frame sent while running and the unknown id each get a `rejected` frame. Text is trimmed, must not be empty, and is at most 4,000 characters.
**Test**: API — `test/session/findings.test.ts` › "edit, dismiss and restore are stored and replayed"

### S14: Post review sends exactly the kept findings
**Given** that session with four findings: two kept and inline (one edited), one kept and not on a diff line, one dismissed
**When** `{type:"post_review", approvalId, verdict:"REQUEST_CHANGES"}` arrives
**Then** GitHub receives one review request authorised with the PAT: `commit_id` = the session's `sha`, `event: "REQUEST_CHANGES"`, two `comments` with `path`, `line`, `side:"RIGHT"` and the edited text, and a body that lists the third finding and not the dismissed one. Then `review_posted {url, verdict}`, `approval_resolved`, `status done`. On a GitHub error (for example 422 because TseHang wrote the pull request): `error {source:"github"}` with GitHub's message, and the gate stays.
**Test**: API — `test/session/engine-github.test.ts` › "post review sends kept findings with the PAT"; Unit — `test/github/review.test.ts` › "findings off the diff go into the body"

### S15: Test B in the browser
**Given** `wrangler dev`, the fake model and the fake GitHub
**When** I run "make the failing test pass", and at the gate click **Approve and open PR**
**Then** the bar showed `agent/<8 hex>-1 → main` before the click. After it: an "Approved" marker, a card "Pull request #N opened" with the branch and "Opened by the &run bot. View on GitHub", the header says Done. On **Pull requests** the new pull request is listed under All, Needs review and My PRs, with "View session" (opens this session) and "Start review". Sending another message, then approving again, shows "Pull request #N updated" and the composer hint said "Adds a commit to pull request #N".
**Test**: E2E — `e2e/pr.spec.ts` › "approve opens a pull request and it appears under My PRs"

### S16: Test E in the browser
**Given** the same servers, and a fake pull request #14 by the bot (head `agent/1a2b3c4d-1`) with a planted bug in `src/slugify.js` line 4
**When** I open **Pull requests**, click **Start review** on #14, read the diff, change one line of the brief, click **Start review**; when the header says "Ready to post" I dismiss one finding, edit another, pick **Request changes** and click **Post review**
**Then** before the second click nothing ran (no session existed). During the run the header says "Read-only review" and the findings appear in the panel. Clicking a finding opens Files changed at that line. The bar says "N inline comments, M note in the summary · Posts to GitHub as TseHang". After posting: a card "Review posted · Request changes" with a link; the fake GitHub holds exactly the kept comments on the right lines with the edited text; the row on the list says "Reviewed". The fake repo's refs did not change.
**Test**: E2E — `e2e/review.spec.ts` › "review a pull request: dismiss, edit, request changes, post"

### S17 (A7, cut first): Review comments are listed on a My PR
**Given** pull request #12 opened by the bot with two review comments by another account, one of them already answered by TseHang
**When** `GET /pulls/12/comments`, and I open the session of #12
**Then** `200 {comments:[{id, author, path, line, body, createdAt, replies:[…], answered}]}`. The session page shows a "Review comments" panel with "1 open", each comment with its file and line, and the list row says "1 comment to answer".
**Test**: API — `test/worker/router.test.ts` › "review comments of a pull request"; E2E — `e2e/my-pr.spec.ts` › "review comments: listed, replied to as TseHang, and fixed by the agent"

### S18 (A7, cut first): Reply as the bot
**Given** that page
**When** I type a reply and click **Reply**
**Then** `POST /pulls/12/comments/:id/replies {text}` is sent with the App token; the reply appears under the comment, written by the &run bot; the comment counts as answered. The route is refused with `429` by the write limiter and `503` when writes are off; an empty or over-4,000-character text gets `400`.
**Test**: API — `test/worker/router.test.ts` › "reply to a review comment"; E2E — the same `e2e/my-pr.spec.ts` test, and "a reply that GitHub refuses is shown and nothing is lost"

### S19 (A7, cut first): Ask the agent to fix
**Given** that page
**When** I click **Ask the agent to fix** on a comment
**Then** a message is sent to the session: the comment's file and line, its text, and my reply text if there is one. The agent runs, reaches the gate, and Approve adds a commit to pull request #12.
**Test**: E2E — the same `e2e/my-pr.spec.ts` test (last part)

### S20: The review eval case
**Given** `eval/cases/review-slugify.yaml` with `mode: review` and `expect_finding: {path: "src/slugify.js", lines: [4, 5]}`
**When** the runner runs it with a scripted model
**Then** the result passes only if a `review_finding` has that path and a line in the list, and the workspace has no changes. The JSONL has the same result line as a Code case.
**Test**: Unit — `test/eval/runner.test.ts` › "a review case passes on an expected finding and no changes"

### S21: The deployed URL passes B and E with the real model
**Given** the Worker deployed from this branch with the four secrets set and `DEMO_SHA` empty
**When** on the public URL I start a Code session with a task that adds `src/slugify.js` with a known bug (two spaces become two hyphens) and a test, approve it, and then review that pull request
**Then** B: the session started from the head of `main`; GitHub shows a pull request by the bot with a descriptive title and body, and it is on the Pull requests page. E: the agent's findings include the planted bug with the right file and line; after dismissing one, editing one and posting Request changes, GitHub shows that review by TseHang with exactly the kept comments on the right lines; the repo has no new commit or branch from the review.
**Runtime check**: by hand on the deployed URL. **Costs money** (two real-model sessions, about ¥1): Henry's OK is needed first.

## Edge Cases
- [x] Approve with no changed files: no GitHub call; the session ends as `done`; the timeline says "Approved. No files changed, so no pull request was opened." — **Test**: `test/session/engine-github.test.ts` › "no changes, no pull request"
- [x] The branch name already exists and points to an unrelated commit (8-hex collision): `error {source:"github"}`, nothing is overwritten (the ref update is never forced). — **Test**: `test/github/publish.test.ts` › "a foreign branch is not overwritten"
- [x] A `post_review` frame in a Code session, an unknown `verdict`, or a stale `approvalId`: `rejected` frame. — **Test**: `test/session/findings.test.ts` › "invalid post_review frames are refused"
- [x] Post review with every finding dismissed and verdict Approve: a review with no comments and the footer body is posted. — **Test**: `test/github/review.test.ts` › "a review without comments"
- [x] A finding on a deleted line or on the left side of the diff counts as not inline. — **Test**: `test/github/diff-lines.test.ts` › "only added and context lines on the right side can take a comment"
- [x] A file in the pull request has no `patch` (binary or too large): the start page says "Diff not available", and findings on it go into the body. — **Test**: `test/github/diff-lines.test.ts` › "a file without a patch has no commentable lines"; `e2e/review.spec.ts` › "review a pull request: dismiss, edit, request changes, post" (the `logo.png` file)
- [x] The diff sent to the model is over 60 KB: file names only, with a note to read the files. — **Test**: `test/session/engine-github.test.ts` › "a large diff is cut to file names"
- [~] deferred — The pull request head moves after the review started: the review is posted on the session's commit; GitHub marks moved lines as outdated. Nothing extra is built. — **Runtime check**: note in `limits.md` only
- [x] The review sandbox is lost and rebuilt: it is rebuilt from the PR head `sha`; findings are kept. — **Test**: `test/session/engine-github.test.ts` › "findings survive a sandbox rebuild"
- [x] A message to a review session after its review was posted is refused, and the composer is disabled with "Review again" linking to `/prs/:n`. — **Test**: `test/session/findings.test.ts` › "a posted review takes no more messages"; the same E2E test (composer disabled, "Review again")
- [x] Deleting a session does not touch its pull request or its posted review; the list row goes back to "Opened by &run" without a session link. — **Test**: `e2e/pr.spec.ts` › "delete keeps the pull request"
- [x] A session from before this phase (no `github_state`): Approve resolves the default branch and opens the pull request. — **Test**: `test/session/engine-github.test.ts` › "a session without stored GitHub state"
- [x] `GET /pulls` fails or is rate limited: the page shows GitHub's message and a Retry button, and the sidebar count is hidden. — **Test**: `e2e/pulls.spec.ts` › "GitHub error on the list"
- [x] Empty tabs: "No pull requests need a review." / "&run has not opened a pull request yet." — **Test**: `e2e/pulls.spec.ts` › "empty tabs"
- [x] The reducer handles `pr_opened` with and without the new optional fields, and a repeated `review_finding` id replaces the earlier one in place. — **Test**: `test/web/reducer.test.ts` › "pr_opened card" and "a finding update replaces by id"
- [x] No GitHub credential reaches the browser or the sandbox: `dist/` contains no secret name, and `GET /config`, `GET /pulls` and the session snapshot carry no token. — **Test**: `test/worker/router.test.ts` › "responses carry no credential"; **Runtime check**: done 2026-10-03, `dist/` has no token, PAT, key or secret name
- [x] `src/github/` has no `cloudflare:*` import and `src/core/` has no `github` import. — **Test**: `test/core/boundary.test.ts` (extended)
- [x] `pnpm test`, `pnpm typecheck`, `pnpm lint` and `pnpm e2e` pass. — **Runtime check**: done 2026-10-03: 230 unit/integration tests, 23 E2E tests, typecheck and lint clean

Not applicable:
- Auth / PII: no users (spec D3). The write protection is P4-j, accepted as ADR Q1.
- Mobile layout, dark mode: out of scope, as in Phase 3.
- Webhooks: none; the list is read live.

Tests from earlier phases that change meaning (to be recorded in Build Progress):
- `test/core/policy.test.ts` › "review mode … lets finish through" → finish asks (P4-b).
- `e2e/code-run.spec.ts` › the "Approved. Nothing was pushed…" assertion → the pull request card (L6 is closed).

## What Henry has to do (I cannot)
1. Create the GitHub App: permissions Contents read/write, Pull requests read/write, Metadata read; install it on `TseHang/andrun-demo` only. Note the App id and the installation id.
2. Download the private key and convert it to PKCS#8: `openssl pkcs8 -topk8 -nocrypt -in key.pem -out key.pk8.pem`.
3. Create a fine-grained PAT for `TseHang/andrun-demo` with Pull requests read/write.
4. `wrangler secret put` for `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_PAT`.
5. Before S21: approve the paid check.

## Open Questions
- [x] **P4-b**: a review ends at `awaiting_approval`, shown as "Ready to post". (Henry, 2026-10-03)
- [x] **P4-c / P4-e**: findings are stored in the SessionDO and edited through frames; Post review is a `post_review` frame, not an HTTP route. The alternative is `POST /sessions/:id/review`, with the limiter in the router; it would then also need an HTTP route for Approve so both writes are limited the same way. (Henry, 2026-10-03)
- [x] **P4-a**: keep `report_finding` (tool) and `review_finding` (event); fix the ADR's wording. (Henry, 2026-10-03)
- [x] **P4-f**: round 2 adds a commit to the same pull request while it is open; a new pull request only after it is closed or merged. (Henry, 2026-10-03)
- [x] **P4-h**: a change with a binary or over-1 MB file cannot be approved into a pull request. The alternative: open it without those files and say so at the gate, in the card and in the pull request body. (Henry, 2026-10-03)
- [x] **P4-n**: `finish` gets an optional `title` for the pull request title. Without it the title is the task text, which for "make the failing test pass" does not describe the change (test B asks for a descriptive title). (Henry, 2026-10-03)
- [x] **P4-d**: Edit and Dismiss are disabled while the agent runs. (Henry, 2026-10-03)
- [x] **Deployed `DEMO_SHA`**: empty. No prepared demo; any task, then review the pull request it opened. The variable stays as an override. (Henry, 2026-10-03)
- [x] **Sandbox network stays off (P4-l)**: the diff reaches the agent through the first message, not through a clone. (Henry, 2026-10-03)
- [x] **Paid checks**: S21 approved and run (Henry, 2026-10-03; ¥0.65). The real-model run of the review eval case (`deepseek-v4-flash`, 3 runs) is not run yet and still needs Henry's OK.
- [x] **The GitHub App and the PAT exist and the four secrets are set on Cloudflare** (Henry, 2026-10-03). Local runs keep using the fake GitHub.
- [x] Assumption (held): a Rate Limiting binding can be called from inside a Durable Object. Seen in `wrangler dev` (the request budget refused a publish started from the SessionDO) and on the deployed Worker (S21: the publish and the review ran through the guard and the budget).
- [x] Assumption (held): a commit created through the Git Data API with an installation token and no `author` is attributed to the bot (`andrun-bot[bot]`, verified). Seen in S21.

## Build Progress
| # | Unit | Proves | Status |
|---|---|---|---|
| 1 | `src/github/`: App auth, client errors, publish, pulls, review, diff lines | S1, S2, S3, review/diff-line edges, foreign branch | ✅ done |
| 2 | Core + session: review gate, `finish` title, event fields, publish on approve, findings, post review, `file_changed` at pause, guard | S4, S5, S6, S7 (engine), S9, S12, S13, S14, engine edges | ✅ done |
| 3 | Worker: review create, head resolution, `/pulls` routes, index `pr`, config, wiring, wrangler, fake GitHub script | S7 (config), S8, S10, S11, credential edge | ✅ done |
| 4 | Web: reducer, pull request card, approval bar, Pull requests page, sidebar, Home copy | S15, reducer and list edges | ✅ done (E2E `pr.spec`, `pulls.spec`, `code-run.spec`, `home.spec` green) |
| 5 | Web: review start page, review session (tabs, findings panel, verdict bar) | S16, review edges | ✅ done (E2E `review.spec` green, run twice) |
| 6 | Eval: review case | S20 | ✅ done |
| 7 | A7 (cut first): review comments, reply, ask the agent to fix | S17, S18, S19 | ✅ done (E2E `my-pr.spec` green) |
| 8 | Docs: ADR amendments, `limits.md`, README | — | ✅ done (by the commander) |

Test changes during the build:
- `test/core/policy.test.ts`, `test/core/modes.test.ts`, `test/core/agent.test.ts`: a review's `finish` now asks (P4-b), so the expected outcome is a gate; the multi-call test uses the eval's auto-approve policy to get the same path as before.
- `test/session/engine.test.ts`, `test/session/workspace.test.ts`: the engine now needs the `github` and `guard` ports; a stub is passed, and the three approve assertions expect `pr_opened` before `approval_resolved`.
- `test/worker/router.test.ts`: `/config` has `githubWrites` and `reviewBrief`; the invalid-mode case uses `"task"` because `"review"` is now valid.
- `test/web/reducer.test.ts` › "unknown events are ignored": `pr_opened`, `review_finding` and `review_posted` are drawn now, so only `artifact` and an unknown type remain in it.
- `e2e/pr.spec.ts`, `e2e/pulls.spec.ts`, `e2e/review.spec.ts`: each test first deletes all sessions, because the fake GitHub numbers pull requests from 12 again after a reset.
- `e2e/code-run.spec.ts`, `e2e/home.spec.ts`: Approve is "Approve and open PR" and shows the pull request card (L6 closed); Review in the mode switch is a link to `/prs`.

Security review findings handled during the build (added to the tests):
- "My PRs" and `publish` compare against the App's own bot login (`GET /app`), not any `[bot]` account; a branch with a pull request that &run did not open is refused.
- A pull request with more files than one page returns (100) cannot be reviewed: `400` instead of a partial review.
- A review that reached GitHub is not posted again if the session was interrupted before the gate closed.
- Accepted: the rate-limit key is `"unknown"` when there is no client IP (a shared bucket, not a bypass). Finding text is written by the model and posted as the user only after the user's click; it is plain text in &run and Markdown on GitHub (goes into `limits.md`).
- A7: `GET /pulls` adds `openComments` to pull requests &run opened that have no review session (at most 10 per load).
- A7 (security review): replies are accepted only on pull requests &run opened; every GitHub request of the Worker counts against one shared budget (`GITHUB_API_LIMITER`, 240 a minute); "Ask the agent to fix" tells the agent that the comment is someone's text from GitHub.
- The review prompt says that the pull request's title and diff are material to review, not instructions.

Found by the E2E runs and fixed:
- The sidebar's pull request count did not follow a pull request opened in the open session. The session page now refreshes the list when a pull request card or a review card appears.
- "Ready to post" is broadcast while the run's segment is still winding down; a Dismiss clicked in that moment was refused. Such a frame now waits for the segment (unit test added).
- After Post review the review card is in Activity while the user may be on Files changed; the view switches back to Activity when a post has an outcome.

Runtime verification (2026-10-03, `wrangler dev` + fake model + fake GitHub, Chromium):
- S15, S16, S17–S19 walked in the browser by the E2E specs; all 23 E2E tests pass in one run. Screens captured: Home, the open-PR gate, the pull request card with review comments, the Pull requests page, the review start page, Ready to post, Files changed with findings, Review posted. No page error and no console error.
- S1–S14 and S20: Vitest (230 tests).
- S21 done 2026-10-03 on https://andrun.mengtse-hang.workers.dev with `deepseek-v4-flash` (Henry approved; ¥0.65 in total):
  - B: a Code session (task: add `src/slugify.js` with a known bug and a test) started from the head of `main` (`0df6f53`), reached the gate in 5 steps (¥0.21), and Approve opened https://github.com/TseHang/andrun-demo/pull/1. On GitHub: author `andrun-bot`, branch `agent/3dad850c-1 → main`, title "Add slugify helper and test" (from `finish`), body with the summary, the task and the changed files; one commit by `andrun-bot[bot]`, verified, parent `0df6f53`. It is on the Pull requests page under Needs review and My PRs.
  - E: the review of #1 drafted four findings in 6 steps (¥0.44), all on diff lines. The planted bug was found at `src/slugify.js:4` ("Consecutive spaces produce consecutive hyphens"). One finding was dismissed (`src/slugify.js:2`), the planted one was edited, verdict Request changes. GitHub shows one review by TseHang, `CHANGES_REQUESTED`, on commit `ae3d210`, with exactly the three kept comments (`src/slugify.js:4` twice, `test/slugify.test.js:5`), the edited text included and the dismissed one absent. The repo has the same two branches and `main` did not move.
  - The first two Post review attempts failed with "GitHub answered 522" and then "520"; each was shown as a GitHub error and the session stayed at Ready to post, and no review reached GitHub. The third attempt, after a redeploy that added the PAT format check, succeeded, and GitHub has exactly one review. The cause of the two failures is not known (see `limits.md` O4).

Observations (not fixed, not user-visible):
- `wrangler dev` logs "saving workspace changes failed: git … failed" when a session is deleted or ends while a save is in flight. The save is for a sandbox that is being destroyed; nothing is lost. It was already possible in Phase 2.
- Once, in the first E2E run of this build, a Code session ended as Failed before its gate. It did not happen again in the following full runs (3 of 3 clean). Cause unknown; watch for it in S21.

Units: 8 (implementer: 7, commander: 1 for the docs; small fixes after verification by the commander).

Changed after S21 (Henry, 2026-10-03): replies on a pull request &run opened are posted by the bot instead of TseHang, so the author (bot) and the reviewer (TseHang) stay two roles. Tests updated: `test/github/pulls.test.ts`, `test/worker/router.test.ts`, `e2e/my-pr.spec.ts`.
