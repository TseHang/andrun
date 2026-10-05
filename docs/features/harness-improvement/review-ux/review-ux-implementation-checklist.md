# Review UX — Implementation Checklist

> Historical implementation/QA record: behavior and unchecked items describe this slice at the time. For current status and remaining work, see [Docs & progress](../../../README.md).

**Status**: ✅ Built — Passing (2026-10-04). Approved (Henry, 2026-10-04)
**Date**: 2026-10-04
**Architecture**: none (UI slice; one new read-only endpoint). Follows the design review of 2026-10-04 and Henry's answers to it.

## Goal
As a developer, I want the pull request page to tell me what the pull request is and offer me &run's review first, so that I can do the whole review in &run without opening GitHub.

Today the page opens on the diff, the thing to do sits in a narrow right column, there is no description, and nothing says the review is done by &run.

## Scope
**In**
- Pull request page (`/prs/:n`): title and meta, the description (markdown), then a "&run review" card (brief, model, Start). A loading state while the pull request loads.
- Files changed moves to a right panel, about 58% wide, that can be hidden. Each file card folds. HTML files have Preview, done the way Code does it.
- The review session (`/s/:id`, review mode) uses the same layout: main column on the left, Files changed on the right. The Activity / Files changed tabs and the separate Findings column are removed.
- Findings are shown in the main column as posts from &run: & avatar, the name "&run", a severity label with a short explanation. The inline note in the diff uses the same header.
- Post bar: the verdict is a three-part switch with an icon and a colour for each, the main button's label follows the verdict, and "ask the agent for another look" is behind a link.
- Navigation: Home's mode switch has no Review; the sidebar says "Code" and "Review PRs"; review sessions in Recent have a "Review" tag; the list's button says "Review with &run".
- New endpoint `GET /pulls/:n/files?path=` and `body` on `GET /pulls/:n`.

**Out**
- A Content-Security-Policy for the preview — still "to discuss" in the brief's TODO. The preview here has the same isolation as Code's (`sandbox="allow-scripts"`, `srcdoc`).
- Preview of anything but `.html` / `.htm`, and of pages that need other files (CSS, JS, images from the repo) — same limit as Code.
- Commits list, CI checks, existing GitHub review comments on the page.
- Responsive layout for narrow windows — the app has fixed widths everywhere; a separate slice.
- Task mode, and the sidebar name "Code & Task" — when Task ships.
- Changing the text posted to GitHub (`**High:** …` stays).
- Resizing the panel by dragging.

## Technical Notes
| Area | Change | Files |
|---|---|---|
| GitHub client | `body` on `PullDetail`; `getPullFile(n, path)` reads the file at the pull request's head commit | `src/github/pulls.ts`, `src/github/index.ts` |
| Worker | `GET /pulls/:n/files?path=` → `{ path, content }` or 404 | `src/worker/router.ts`, `src/worker/types.ts` |
| Fake GitHub | `body` on seeded pulls; `GET /repos/:repo/contents/:path?ref=` | `test/support/fake-github.ts` |
| Web API | `body` on `PullDetail`; `getPullFile(n, path)` | `web/src/api.ts` |
| Web, shared | Create `PullOverview.tsx` (meta + description), `ReviewFilesPanel.tsx` (panel, hide/show, file cards), `FindingPost.tsx` | `web/src/components/` |
| Web, pages | Modify | `ReviewStartPage.tsx`, `ReviewSession.tsx`, `SessionPage.tsx`, `PatchView.tsx`, `ReviewBars.tsx`, `HtmlPreview.tsx` |
| Web, removed | `FindingsPanel.tsx` (its content moves to `FindingPost.tsx` and the main column) | |
| Web, navigation | Modify | `Sidebar.tsx`, `Home.tsx`, `PullRequestsPage.tsx` |
| Web, labels | `severityLabel` | `web/src/state/format.ts` |

Key Decisions
- **RV-a** One layout before and after Start: main column left, Files changed right. Reason: same place for files as a Code session; the thing to do is in the reading column.
- **RV-b** Files panel width is `58%`; hidden state is remembered in localStorage under `andrun.review.files.hidden` (separate from Code's `andrun.changes.hidden`). Hidden shows a "Show files · N" button, as Code does.
- **RV-c** Preview reads the file from GitHub at the pull request's head commit (contents API), returns JSON, and the page puts it in `<iframe sandbox="allow-scripts" srcdoc>` — the same as UI-c/UI-d of the session UI slice. No button when the file is not HTML, was removed, or has no patch, or when the pull request is from a fork (Henry, 2026-10-04: forks get neither review nor preview). If the content cannot be read (too large, GitHub error), the card says "Preview not available for this file".
- **RV-d** The description is rendered with the existing `Markdown` component: no raw HTML, images become links. It is text written by the pull request's author, so it is treated like a model reply.
- **RV-e** Severity labels: High = "Fix before merging", Medium = "Worth fixing", Low = "Optional". Colour is never the only signal: the word is always there.
- **RV-f** Verdict labels and main button: Comment → "Post comments"; Approve → "Approve"; Request changes → "Request changes". Colours: neutral, green (`done`), red (`failed`). The switch stays a `radiogroup` for keyboard and screen readers.
- **RV-g** In the review session the description is folded by default (the user has read it before Start); on `/prs/:n` it is open.
- **RV-h** `GET /pulls/:n/files` uses the existing GitHub read rate limiter, serves only `.html` / `.htm` paths (added after code review), and does not check that the path is one of the changed files: the workspace already shows this repository, and the check would cost another GitHub request.

Data flow: page → `GET /pulls/:n` (now with `body`) → `PullOverview`. Preview → `GET /pulls/:n/files?path=` → worker reads the pull request for its head sha, then `GET /repos/:repo/contents/:path?ref=<sha>` → base64 decoded → JSON. No new dependencies.

## Acceptance Scenarios

### S1: The pull request page leads with the description and the review card
**Given** an open pull request #7 "Add slugify" by `octocat` with the body `## Why\n\nWe need **slugs**.` and two changed files
**When** the user opens `/prs/7`
**Then** the main column shows, in this order: the title with `#7`; "octocat wants to merge … into main"; the description with an `<h2>` "Why" and bold "slugs"; a region named "&run review" containing the brief textarea with the default brief, the model menu, and a "Start review" button. The right side is a region named "Files changed" listing both files with their diffs. No diff is in the main column.
**Test**: E2E — `e2e/review.spec.ts` › "the pull request page shows the description, the review card and the files panel"

### S2: The pull request has no description
**Given** a pull request whose body is empty or null
**When** the page renders
**Then** the description area says "No description." and the review card is unchanged
**Test**: Unit (render) — `test/web/render.test.tsx` › "a pull request without a description says so"

### S3: The description is rendered safely
**Given** a body with `<script>alert(1)</script>`, `![x](https://evil.example/p.png)` and `[a](javascript:alert(1))`
**When** `PullOverview` renders
**Then** there is no `<script>` and no `<img>` element, the image is a link, and the `javascript:` link has no href
**Test**: Unit (render) — `test/web/render.test.tsx` › "a pull request description cannot inject elements"

### S4: `GET /pulls/:n` returns the description
**Given** GitHub returns `body: "Hello"` (and, in a second case, `body: null`)
**When** `getPull` is called
**Then** the result has `body: "Hello"` (and `body: ""` for null)
**Test**: Unit — `test/github/pulls.test.ts` › "reads one pull request with its files" (extended) and API — `test/worker/router.test.ts` › "reads one pull request for the review start page" (extended)

### S5: Loading state
**Given** `/pulls/7` takes 2 seconds to answer
**When** the user opens `/prs/7`
**Then** the page shows a status "Loading pull request" until the answer arrives, then S1's content
**Test**: E2E — `e2e/review.spec.ts` › "the pull request page shows a loading state" (route delayed with `page.route`)

### S6: The files panel hides, and stays hidden
**Given** `/prs/7` with the panel shown
**When** the user presses "Hide files", reloads, then presses "Show files · 2"
**Then** after "Hide files" the panel is gone and the main column takes the width; after the reload it is still hidden and the button reads "Show files · 2"; after "Show files · 2" the panel is back. A Code session's Changes panel is not affected by this setting.
**Test**: E2E — `e2e/review.spec.ts` › "the files panel hides and the choice survives a reload"

### S7: A file card folds
**Given** the panel with `src/slugify.js` and `README.md`
**When** the user presses the header of `src/slugify.js`
**Then** its diff is hidden, `aria-expanded` is `false`, the header still shows the path and `+N −M`; `README.md` is unchanged. Pressing again shows the diff.
**Test**: Unit (render) for the default state — `test/web/render.test.tsx` › "a pull request file card is open by default and has a fold button"; E2E for the click — inside S6's test

### S8: Preview of an HTML file in a pull request
**Given** a pull request that changes `index.html` (whose script sets the heading to "Hello from the page") and `app.js`
**When** the user presses "Preview" on `index.html`
**Then** an iframe titled "Preview of index.html" with `sandbox="allow-scripts"` shows "Hello from the page"; the button now says "Diff" and brings the diff back. `app.js` has no Preview button. The page's own URL and cookies are not reachable from the frame (the frame has an opaque origin: `sandbox` has no `allow-same-origin`).
**Test**: E2E — `e2e/review.spec.ts` › "an HTML file in a pull request can be previewed"

### S9: `GET /pulls/:n/files?path=`
**Given** pull request #7 with head sha `abc…`, and `index.html` at that commit
**When** the client requests `/pulls/7/files?path=index.html`
**Then** 200 `{ "path": "index.html", "content": "<the file's text>" }`, read with `ref=<head sha>`. Missing `path`, a file that does not exist at that commit, a directory, or a file GitHub returns without inline content → 404 `{ "error": "no such file" }`. A pull request that does not exist → 404. Non-numeric `:n` → 404. Over the rate limit → 429, as for the other `/pulls` routes.
**Test**: API — `test/worker/router.test.ts` › "reads a file of a pull request at its head commit"; Unit — `test/github/pulls.test.ts` › "reads a file at the pull request's head commit"

### S10: The review session uses the same layout
**Given** a review of pull request #7 has been started (fake model: four findings, then finish)
**When** the session page is open and the agent has finished
**Then** there are no "Activity" / "Files changed" tabs; the main column shows the pull request's meta, a folded "Description" that opens on click, the agent's activity, then a "Findings" section; the "Files changed" panel is on the right with the diff and the inline notes; the post bar sits under the main column and does not cover the panel.
**Test**: E2E — `e2e/review.spec.ts` › "review a pull request: dismiss, edit, request changes, post" (updated)

### S11: A finding is a post from &run
**Given** a kept inline finding: high, `src/slugify.js:4`, "Two spaces in a row become two hyphens."
**When** it renders in the main column and in the diff
**Then** both show the & avatar (`role="img"`, label "&run"), the name "&run", and "High · Fix before merging". The main-column post also shows `src/slugify.js:4` as a link, the text, and Edit / Dismiss. A medium finding reads "Medium · Worth fixing", a low one "Low · Optional". A finding not on a changed line shows the "In summary" badge and no link. A dismissed finding is muted with the text struck through and only "Restore".
**Test**: Unit (render) — `test/web/render.test.tsx` › "a finding is shown as a post from &run with an explained severity"; Unit — `test/web/format.test.ts` › "severity labels"

### S12: A finding's location opens the file
**Given** the files panel is hidden and the card of `src/slugify.js` is folded
**When** the user presses `src/slugify.js:4` on a finding
**Then** the panel is shown, the card is open, and line 4 with its note is in view
**Test**: E2E — inside S10's test

### S13: Findings can still be edited, dismissed and restored
**Given** the review is at the post gate
**When** the user edits one finding, dismisses another, and restores it
**Then** the same results as today: "Edited" badge, the count line "N kept, M dismissed", the diff note disappears for a dismissed finding and returns on restore. While the agent runs, the buttons are disabled and the section says "You can edit findings when the agent has finished."
**Test**: E2E — `e2e/review.spec.ts` (both existing tests, updated selectors)

### S14: The verdict switch
**Given** the post bar with 2 inline comments and 1 note
**When** the user picks each verdict
**Then** the switch is a radiogroup "Verdict" with three options, each with an icon and its label; the selected option has `data-verdict` of `COMMENT` / `APPROVE` / `REQUEST_CHANGES` and its colour; the main button reads "Post comments", "Approve", "Request changes". There is no separate hint line. Arrow keys move the selection. Posting with "Request changes" sends `post_review` with `verdict: "REQUEST_CHANGES"` (the review is posted as today).
**Test**: E2E — `e2e/review.spec.ts` › "review a pull request: dismiss, edit, request changes, post" (updated)

### S15: Asking for another look is behind a link
**Given** the post bar
**When** it first shows, and then the user presses "Ask &run for another look"
**Then** at first there is no comment input; after the press an input "Comment for the agent" and a Send button appear, focused; sending a comment rejects the gate and the agent runs again, as today
**Test**: E2E — `e2e/review.spec.ts` › "findings cannot be edited while the agent runs, and a refused review stays at the gate" (extended) 

### S16: Navigation names
**Given** one Code session and one Review session exist
**When** the user opens `/`
**Then** the sidebar links read "Code" (current) and "Review PRs" with the count; Home's mode group has "Code" (pressed) and "Task" (disabled) and no "Review"; in the sidebar's Recent and Home's Recent the Review session has a "Review" tag and the Code session has none
**Test**: E2E — `e2e/home.spec.ts` › "navigation: Code and Review PRs, review sessions are tagged"

### S17: The list invites a review by &run
**Given** `/prs` with a pull request that has no review
**When** the page renders
**Then** the heading is "Review PRs", the button reads "Review with &run" and goes to `/prs/:n`; rows with a review still say "View review"
**Test**: E2E — `e2e/pulls.spec.ts` › "the list shows who wrote each pull request and what can be done" (updated)

## Edge Cases
- [x] A blocked pull request (closed, fork, more than 100 files): the review card shows the reason and Start is disabled; description and files still show — **Test**: `test/web/render.test.tsx` › "a blocked pull request shows why and cannot start"
- [x] Preview content cannot be read (404 from the endpoint): the card says "Preview not available for this file" and Diff still works — **Test**: `e2e/review.spec.ts` › inside "an HTML file in a pull request can be previewed" (second file removed at head via `page.route`)
- [x] A removed `.html` file, one with no patch, or any file of a fork's pull request: no Preview button — **Test**: `test/web/render.test.tsx` › "a removed or patch-less HTML file has no preview", "a fork's pull request has no preview"
- [x] `GET /pulls/:n/files` for a fork's pull request → 404 `no such file` (the button is hidden, and the endpoint does not serve it either) — **Test**: `test/worker/router.test.ts` › "reads a file of a pull request at its head commit"
- [x] A path with spaces, `#` or non-ASCII characters is read correctly — **Test**: `test/github/pulls.test.ts` › "reads a file at the pull request's head commit"
- [~] deferred — not checked in the browser: A long description (200 lines) scrolls with the main column and does not push the files panel — **Runtime check**: browser, one long body
- [~] deferred — same hook as Code's panel, not re-checked: localStorage unavailable: the panel shows, the toggle works for the visit — **Test**: covered by the same hook pattern as Code; **Runtime check** only
- [x] `prefers-reduced-motion: reduce`: the verdict switch and the fold arrows change without a transition — **Test**: `e2e/review.spec.ts` › inside S14's test with `page.emulateMedia({ reducedMotion: "reduce" })`, computed `transition-duration` is `0s`
- [x] Zero findings: the Findings section says "No findings." and the post bar reads "0 inline comments, 0 notes in the summary" — **Test**: `test/web/render.test.tsx` › "no findings"
- [~] deferred — code path read, not exercised in the browser: The diff fails to load in a review session: the panel shows the message; the main column and the post bar still work — **Runtime check**: block `/pulls/:n` in the browser
- [x] ~~After posting: the "This review was posted" bar and "Review again" still show under the main column~~ Replaced by ADR A24: the composer returns and "Review again" is in the posted card — **Test**: S10's test
- [x] Regression: Code session layout, Changes panel and its preview are unchanged — **Test**: `e2e/session-ui.spec.ts`, `e2e/code-run.spec.ts` (existing, unchanged)

Not applicable: auth (none in the app), pagination (the files request is capped at 100 as before), real-time reconnect (unchanged, covered by `e2e/reconnect.spec.ts`).

## Open Questions
- [x] Severity wording (RV-e) — approved by Henry
- [x] Main button labels (RV-f) — approved by Henry
- [x] Fork pull requests: no review (as before) and no preview — decided by Henry
- [x] RV-h: no check that the previewed path is one of the changed files — approved with the checklist
- [ ] Where findings sit relative to the activity: one "Findings" section after the activity, in the same scrolling column — Henry agreed; shown to him in runtime verification

## Build Progress
| # | Unit | Proves | Status |
|---|---|---|---|
| 0 | Acceptance tests (commander) | all scenarios fail for the right reason | ✅ done |
| 1 | GitHub `body` + `getPullFile`, `GET /pulls/:n/files` | S4, S9, edge: odd paths, fork | ✅ done |
| 2 | Shared parts and the pull request page: `PullOverview`, `ReviewCard`, `ReviewFilesPanel`, preview, loading, hide | S1–S3, S5–S8, edges: blocked, no preview | ✅ done |
| 3 | Review session layout: one column + files panel, `Findings` posts, jump | S10–S13, edge: no findings | ✅ done |
| 4 | Post bar: verdict switch, another look behind a link, reduced motion | S14, S15 | ✅ done |
| 5 | Navigation names and tags, list button | S16, S17 | ✅ done |
| 6 | Runtime verification (commander) | all scenarios in the browser, E2E | ✅ done |

Contracts fixed by the tests (the implementer does not change them):
- `github.getPullFile(n, path): Promise<string | null>`; `GET /pulls/:n/files?path=`.
- `PullOverview({ pull, defaultOpen? })` → `<section aria-label="Pull request">`; `ReviewCard({ pull })` → `<section aria-label="&run review">`; `ReviewFilesPanel({ pull, findings, onHide })` → `<aside aria-label="Files changed">` with `[data-file]` cards; `Findings({ view, status, send, onJump })` → `<section aria-label="Findings">` with `li[data-finding]`; `severityLabel(severity)` in `web/src/state/format.ts`.
- Verdict: `role="radiogroup"` named "Verdict" with `data-verdict`, three `role="radio"` buttons with `aria-checked`.
- Tag on review sessions in Recent: `[data-tag="review"]`.

Build notes
- Units 1 and 5 by one implementer run, units 2–4 by a second; none re-briefed. Commander fixes: the post bar layout (it overflowed in the narrower main column: the verdict switch now takes the full width, the "another look" link and the main button share the next row), and a dot-segment check on the file path (`.`, `..` and empty segments are refused before any GitHub request; flagged by the security review, test added).
- Tests corrected by the commander, with reasons: (1) render tests matched `/disabled/` on a button's whole tag, which also matched the `disabled:` class names; they now match the `disabled=""` attribute. (2) the E2E compared the verdict colours during the transition; it now waits for the final colours.
- E2E, full suite on the final code minus the post bar layout fix: 36 passed, 2 failed (`conversation.spec.ts` "a question is answered by picking an option", `failures.spec.ts` "a killed sandbox…"); both are outside this slice and passed when run alone (6/6). Same local container instability as in the session UI slice. After the layout fix: `review.spec.ts` 6/6.
- Runtime: screenshots of the list, the pull request page, the preview, the hidden panel, the session at the gate and the post bar at 1440 and 1280 wide were checked by eye.
- Known limits: at 1280 wide the verdict switch just fits; narrower windows are out of scope (no responsive layout). The sidebar still says "Awaiting approval" for a review that is ready to post (unchanged). The "Show files" button has no count until the diff has loaded.
- Code review (high), fixed: the file endpoint served any file of the repo — it now serves only `.html` / `.htm`; an empty HTML file was reported as missing; the files panel kept bottom padding for a bar that no longer covers it. Follow-ups are in the pull request.
