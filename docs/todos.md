# To-dos

Remaining product work as of 2026-10-05. Current behavior is in [limits.md](limits.md); this is a backlog, not a delivery commitment.

## Before broader access

- [ ] **GitHub sign-in and account connection:** user-owned sessions, repo selection and per-user publishing/review identities; replace the shared operator PAT (C4, C5, G1).
- [ ] **Spend and abuse controls:** global/daily and concurrent-run caps, classifier cost accounting, Task request quotas and disable public debug endpoints (C1–C3, C6, C7).
- [ ] **Auto-approve policy:** deterministic allow/deny rules, classify uncertain commands, keep GitHub writes explicitly approved; address command bypasses of file protections (L11).
- [ ] **Safe web access and search:** add a search tool, choose its provider/cost, harden destination validation and data-leak controls, verify deployed Task egress; consider registry-only access for Code/Review (L13, L14).
- [ ] **Preview security:** decide a CSP that limits external requests while retaining useful interactive HTML; cover both agent and PR previews (L15).

## Product improvements

- [ ] **Memory:** explicit, editable cross-session project knowledge, with ownership and deletion controls; distinguish it from saved conversation history.
- [ ] **User preferences:** persist model/effort, language, workflow and permission preferences.
- [ ] **Auto economics:** compare fixed routes on task success, latency and total cost; explore ai& serving/cache signals, history-aware classification and escalation (C7, C8).
- [ ] **Reliable workspaces:** durable message queue and crash recovery, stronger command-change checkpoints, large/binary storage and file modes; measure sandbox monitoring/cold-start costs (L1–L10, F1–F5).
- [ ] **Artifacts:** support more kinds of task outputs, including images and PDF, with previews and downloads so Task can handle a wider range of work (L12).
- [ ] **GitHub completeness:** paginate the PR/file lists, support fork review, warn on stale heads, make review retries resumable and align finding rendering; reply to/resolve review threads (G1–G8, G10).
- [ ] **Evaluation and release evidence:** check excessive model verification and reasoning continuity with real-model evals; obtain a clean full E2E result and deployed Task proof. Paid evals and deployment require operator approval.
- [ ] **Usability and delivery:** mobile layout, session search and automatic deployment from `main`.

Already implemented: Stop, basic Auto routing, Task text downloads, post-review conversation and handing GitHub review feedback to the Code agent. They are not new backlog items.
