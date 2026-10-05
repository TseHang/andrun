# Docs & progress

Start with the [product README](../README.md), [known limits](limits.md) and [to-dos](todos.md). Setup, checks, real-model evals and deployment instructions live in [development.md](development.md).

## Current source

As of 2026-10-05, the repository contains:

- One agent loop with Code, Review and Task profiles, streamed events, plans, questions and Stop.
- SQLite session history and saved text changes, replay after reconnect and lazy sandbox rebuilds.
- Model/effort selection and application-side Auto classification; no provider-side cache-aware routing.
- GitHub App PR publishing, PAT review posting, ongoing review conversations and closed/merged session guards.
- A Code-session panel for GitHub review feedback and sending selected reviews to the agent.
- Empty Task sandboxes with restricted GET/HEAD egress, HTML preview and HTML/Markdown/CSV downloads.

These statements describe checked-in code. The old phase checklists and QA reports describe their own dated snapshots; unchecked design questions are not automatically unfinished features. Later ADR amendments supersede earlier decisions.

## Verification boundaries

- The original 2026-09-30 real-model baseline covered five cases (5/5), not today's 13 cases. Do not use it as a current all-mode result.
- Phase 4 records deployed real-model/GitHub checks; these do not establish that every subsequent UI or harness change is deployed.
- The Task checklist records local tests, typecheck, lint and Task browser/runtime flows passing. Its full E2E run was 40/41; reruns passed individually, and a second full run was stopped after other timeouts. A clean full-suite result remains open.
- Task's deployed networking check and a real-model Task eval remain unverified. Documentation cleanup performs no deployment, paid eval or GitHub write.
- This documentation audit reran local unit/integration checks: **31 test files, 374 tests passed**. All 52 local Markdown file links were checked; `git diff --check` passed. This adds current local evidence without replacing the historical E2E result.

## Architecture

- [Architecture decisions and amendments](architecture/web-codex-architecture-decision.md) — original choices and their subsequent revisions.
- [Original system flow diagram](architecture/web-codex-flow.html) — historical diagram; its budget, network and session endings predate later amendments.
- [Sandbox SDK spike](architecture/spike-sandbox-1.0.md) and [Task egress spike](architecture/spike-egress.md) — dated runtime findings.

The core loop uses platform-independent ports. `src/session` handles persisted state and approvals; `src/worker` binds Durable Objects and HTTP/WebSocket routes; `src/sandbox` adapts container execution; `src/github` publishes and reads GitHub state; `web` reduces session events into the UI. `test`, `e2e` and `eval` cover offline checks, scripted browser flows and model evaluations respectively.

## Implementation records

These retain original scope, decisions and evidence. Use limits/todos for current gaps.

| Work | Record |
|---|---|
| Agent loop and eval harness | [Core loop checklist](features/core-loop/core-loop-implementation-checklist.md) |
| Persisted sessions and sandbox recovery | [Session DO checklist](features/session-do/session-do-implementation-checklist.md) |
| Workspace UI | [Checklist](features/workspace-ui/workspace-ui-implementation-checklist.md) · [QA report](features/workspace-ui/workspace-ui-qa-report.md) |
| GitHub publishing and review | [Checklist](features/github/github-implementation-checklist.md) · [QA report](features/github/github-qa-report.md) |
| Harness changes | [Original brief](features/harness-improvement/harness-improvement-brief.md) · [Slice A checklist](features/harness-improvement/harness-improvement-implementation-checklist.md) |
| Conversational flow | [Checklist](features/harness-improvement/conversational-flow/conversational-flow-implementation-checklist.md) |
| Session UI and preview | [Checklist](features/harness-improvement/session-ui/session-ui-implementation-checklist.md) |
| Review UX | [Checklist](features/harness-improvement/review-ux/review-ux-implementation-checklist.md) |
| Task mode and local verification | [Checklist and results](features/harness-improvement/task-mode/task-mode-implementation-checklist.md) |
| Work log | [Time log](time-log.md) |
