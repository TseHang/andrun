# QA Report: Phase 4 GitHub integration
Date: 2026-10-03
Branch: feat/github
Tester: Carry (/qa-web), on local `wrangler dev` + the fake model + the fake GitHub, Chromium (Playwright)

Scope: approve opens a pull request, the Pull requests list, the review start page, Review mode. My PR (A7) is not in this branch (tag `my-pr-a7`).

## Summary
- Scenarios checked: 41. Passed: 39. Failed then fixed: 2. Not tested here: 5 (see the end).
- Critical issues: none.
- Security findings: none new. The notes from the security review still stand (`docs/limits.md` C5, G6).
- Tests added: 2 assertions in `test/worker/router.test.ts`.

## Issues found
| # | Severity | Description | Steps to reproduce | Fix |
|---|---|---|---|---|
| 1 | P2 | In the pull request list, a long title squeezed the action button: "View review" shrank and wrapped onto two lines. | A pull request with a title longer than the row, with a review session. | The status text and the action buttons no longer shrink; the title is cut instead (`web/src/components/PullRequestsPage.tsx`). Checked in the browser: the button is 116×30 again. |
| 2 | P3 | A pull request number that GitHub cannot have was sent to GitHub anyway: `GET /pulls/99999999999999999999` and `POST /sessions` with `pr: 1e30` each spent a GitHub request and answered 404. | The two requests above. | `GET /pulls/:n` takes at most 15 digits; `pr` must be a safe integer (`src/worker/router.ts`). Both are now refused before GitHub is called. Test: `test/worker/router.test.ts` › "reads one pull request for the review start page" and "review sessions are created from an open pull request". |

## Results
| # | Area | Check | Result |
|---|---|---|---|
| 1 | Happy path | Approve opens a pull request; round 2 adds a commit; delete keeps the pull request | Pass (E2E) |
| 2 | Happy path | Review: start page, findings, dismiss, edit, verdict, post | Pass (E2E) |
| 3 | API | `GET /pulls/:n` with `0`, `-1`, `abc`, `14abc`, `1e3`, an extra path segment | Pass: 404, no GitHub request |
| 4 | API | `GET /pulls/:n` with a 20-digit number | Fixed (issue 2) |
| 5 | API | `POST` and `DELETE` on `/pulls` | Pass: 404 |
| 6 | API | Review create with `pr` missing, `0`, `"14"`, `1.5`, `-3` | Pass: 400 |
| 7 | API | Review create with `pr: 1e30` | Fixed (issue 2) |
| 8 | API | Review create on a missing, closed or fork pull request | Pass: 404, 400, 400 with the reason |
| 9 | API | Code create with extra `pr`, `sha`, `baseBranch` fields | Pass: ignored; the session uses the default branch head |
| 10 | API | 64 `GET /pulls` from one address | Pass: 60 answered, then 429; another address is not affected |
| 11 | API | GitHub answers 500 or 401 on the list | Pass: 502 with GitHub's message |
| 12 | Frames | Not JSON, unknown type | Pass: refused |
| 13 | Frames | `finding` with an unknown id, empty text, 20,000 characters, `dismissed: "yes"` | Pass: refused |
| 14 | Frames | `post_review` with an unknown verdict or a wrong approval id | Pass: refused, nothing posted |
| 15 | Frames | `post_review` and `finding` sent to a Code session | Pass: refused ("post_review is only for review sessions") |
| 16 | Frames | Plain `approve` at the review gate | Pass: refused ("Choose a verdict and post the review."), nothing posted |
| 17 | Frames | `reject` or a message at the review gate | Pass: the agent runs again and stops at a new gate; the old approval id no longer works |
| 18 | Idempotency | `post_review` three times from two sockets at once | Pass: one review on GitHub; the others get "no such pending approval" |
| 19 | Idempotency | `approve` three times from two sockets at once (Code) | Pass: one branch, one pull request |
| 20 | Idempotency | After a review is posted: `finding`, message, `post_review` | Pass: all refused, still one review |
| 21 | Limits | 13 refused posts from one address | Pass: 10 reach GitHub, then "Too many requests. Try again in 60 seconds."; the session stays at the gate |
| 22 | Input | Pull request title `<img src=x onerror=alert(1)> <script>…` with Chinese and emoji | Pass: shown as text in the list, the start page, the session header and the sidebar; no dialog, no injected element |
| 23 | Input | The same markup in the review brief and in an edited finding | Pass: shown as text |
| 24 | Input | Brief of 5,000 characters; brief of spaces only | Pass: capped at 4,000; Start review is disabled |
| 25 | Display | Long title in the list | Fixed (issue 1) |
| 26 | Display | Long title on the start page and in the session header | Pass: cut with an ellipsis; no horizontal overflow at 1440 or 1024 px |
| 27 | Display | A pull request with no files | Pass: empty diff; every finding goes into the summary ("0 inline comments, 3 notes in the summary") |
| 28 | Display | Closed pull requests | Pass: not in the list; opened by URL, the page says "This pull request is not open." and Start review is disabled |
| 29 | Display | Fork pull request | Pass: the page says forks are not supported and Start review is disabled. Note: the list still offers "Start review" for it, because the list request does not say whether a pull request is a fork. |
| 30 | Display | `/prs/999`, `/prs/abc`, `/prs/0` | Pass: "Pull request not found." |
| 31 | Display | Empty list and empty tabs | Pass (E2E) |
| 32 | Interaction | Double-click Start review | Pass: one session |
| 33 | Interaction | Double-click Post review | Pass: one review |
| 34 | Interaction | Reload at the review gate after an edit and a dismiss | Pass: "3 kept, 1 dismissed" and the edited text are back |
| 35 | Interaction | Back to the start page, then forward | Pass: the session is back at "Ready to post" |
| 36 | Network | GitHub fails while the start page loads | Pass: the message and a Retry button |
| 37 | Network | GitHub refuses the review (422) | Pass: "GitHub error" card, still "Ready to post", Post works on the next try |
| 38 | Network | GitHub error on the list | Pass (E2E) |
| 39 | Sandbox | The commit of a review cannot be downloaded | Pass: "could not download TseHang/andrun-demo@…: HTTP 404", status Failed |
| 40 | Regression | Unit and integration suite, typecheck, lint | Pass: 226 tests |
| 41 | Regression | Whole E2E suite | Pass: 21/21 |

Browser console during the run: only the 404 and 502 answers that the checks caused on purpose.

## Security
| Vector | Status | Notes |
|---|---|---|
| XSS | Pass | Pull request titles, briefs and finding text are rendered as React text. A finding's text is posted to GitHub as Markdown, and GitHub renders it (limits G6). |
| CSRF | Note | No login (ADR D3). A third-party page could send frames or create sessions, as in Phase 3. GitHub writes are held by the per-address write limit and `GITHUB_WRITES`. |
| IDOR | Note | Anyone with the URL can approve a session's gate or post a drafted review (limits C5). By design while there is no login. |
| Rate limiting | Pass | Reads 60/min and writes 10/min per address, checked at runtime (results 10 and 21). |
| Input validation | Pass | Server-side for `pr`, `mode`, task, finding text, verdict and approval id (results 3 to 8, 12 to 16). |
| Credentials | Pass | No token in `/config`, `/pulls` or error bodies (router test "responses carry no credential"). GitHub's own error text is passed on as it is. |

## Not tested here
- Review of a pull request that &run itself opened, as one chain, on the local setup: the sandbox downloads the commit from the real GitHub, and a commit made on the fake GitHub does not exist there (result 39). This chain passed on the deployed Worker (S21 in the checklist).
- The kill switch at runtime (`GITHUB_WRITES=0`): covered by unit tests only (`engine-github.test.ts` › "kill switch and rate limit refuse GitHub writes").
- A second review round with a real model: a real model may report the same finding twice. The fake model does not.
- Safari and Firefox: only Chromium was run.
- Widths under 1024 px: out of scope, as in Phase 3. At 375 px the list overflows sideways.
