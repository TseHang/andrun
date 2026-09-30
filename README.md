# &run

A Codex-style coding workspace on Cloudflare. You give it a task and a repo. An agent works in an isolated sandbox: it reads code, runs the tests and edits files, and it stops for your approval before anything is final.

**Status**:
- Phase 1 (the agent loop, plus an eval against real models) is done.
- Phase 2 (Durable Objects, the Cloudflare Sandbox, the deployed URL) is next.

## Quick start

Needs Node 22+ and pnpm.

```sh
pnpm install
pnpm test          # unit + integration tests (no network, no cost)
pnpm typecheck
pnpm lint
```

### Eval against a real model

Copy `.env.example` to `.env` (git-ignored) and fill in your ai& key, then:

```sh
pnpm eval --case sum-off-by-one            # one case, one run
pnpm eval                                  # all 5 cases, one run each
pnpm eval --runs 3 --max-cost 10           # the full acceptance run
```

- Defaults: `--runs 1 --max-cost 5` (yen); the model is `deepseek-ai/deepseek-v4-flash`.
- The run stops once the cost cap is reached.
- Each run writes a JSONL trajectory per case and a `summary.md` to `eval/runs/<timestamp>/`.
- A case fails if the agent edits the tests or `package.json`, even when the check passes.

Baseline on 2026-09-30 (flash, 5 cases × 1): **5/5 pass, 5.6 steps on average, ¥1.22 total.**

## Layout

```
src/core/     the agent: loop, tools, modes, policy, model client, events (no platform imports)
eval/         eval runner, local sandbox, YAML cases, fixture repos
test/         Vitest suites and test doubles
spike/        throwaway Sandbox SDK 1.0 spike (not part of the app)
docs/         architecture decision, flow diagram, per-phase checklists
```

## Docs

- [Architecture decision](docs/architecture/web-codex-architecture-decision.md): the key decisions D1–D19, the phases, cost and limits
- [System flow diagram](docs/architecture/web-codex-flow.html)
- [Sandbox 1.0 spike findings](docs/architecture/spike-sandbox-1.0.md)
- [Phase 1 checklist](docs/features/core-loop/core-loop-implementation-checklist.md)

## Why a loop, not a graph

The agent is a `while` loop. It asks the model, runs the tools the model picked, appends the results, and repeats until the model calls `finish` or a budget runs out. There is no graph, no planner node and no router.

The model is already the planner, and it re-plans on every turn with the full transcript. A graph would duplicate that decision in code and fix a control flow that the model should choose. A fixed flow is exactly what breaks when a test fails in an unexpected way.

Code does own the things that must not depend on the model:
- step and token budgets
- the approval gate
- the 3-strikes rule for failing tools
- which tools exist in each mode

These live around the loop, not inside a graph.

Modes (Code, Review, Task) are profiles, not branches. A profile is a prompt, a set of tools, a policy and a sandbox setup. Review can't edit code because it has no edit tool, not because a prompt asks it nicely.

Pausing for approval is a `return`, and resuming means calling the loop again with the decision appended. The same path handles a page refresh, an evicted Durable Object and a two-day wait.
