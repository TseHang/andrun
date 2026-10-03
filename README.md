# &run

A Codex-style coding workspace on Cloudflare. You give it a task and a repo. An agent works in an isolated sandbox: it reads code, runs the tests and edits files, and it stops for your approval before anything is final.

**Status**:
- Phase 1 (the agent loop, plus an eval against real models) is done.
- Phase 2 (Durable Objects, the Cloudflare Sandbox, a debug page over the event stream) is deployed: https://andrun.mengtse-hang.workers.dev
- Phase 3 (the workspace UI: Home, the session view with diffs and the approval bar, a model menu) is built and tested locally on branch `feat/workspace-ui`; not deployed yet.
- Phase 4 (pull requests and Review mode) is next.

## Quick start

Needs Node 22+ and pnpm.

```sh
pnpm install
pnpm test          # unit + integration tests (no network, no cost)
pnpm typecheck
pnpm lint
pnpm e2e           # browser tests: starts the fake model and wrangler dev itself (needs Docker)
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

### Run the Worker locally

Needs Docker running (the sandbox is a container). No ai& key and no cost: a fake model server plays a fixed script.

```sh
cp .dev.vars.example .dev.vars
pnpm fake-model                      # terminal 1: fake OpenAI-compatible SSE server on :8788
pnpm build && pnpm dev               # terminal 2: build the app, then wrangler dev on :8787 (open it)
pnpm smoke                           # terminal 3: create → gate → replay → reject → approve → delete
pnpm smoke --flow kill               # kill the sandbox mid-run → failed → message → rebuilt
```

`pnpm dev` serves the last build in `dist/`. While working on the UI, run `pnpm dev:web` as well (Vite on :5173 with hot reload, proxying the API to :8787). The Phase 2 debug page is still at `/debug.html`.

Each local session leaves a `workerd-andrun-…` container in Docker, and `wrangler dev` does not always remove them when it stops. To clear them (with `wrangler dev` stopped):

```sh
docker ps -aq --filter name=workerd-andrun- | xargs docker rm -f
```

Tasks for the fake model can carry a marker: `[slow]` (8 s per answer), `[fail]` (every request fails), `[ask]` (first runs `rm -rf tmp`, which needs approval).

To use the real model locally, put your ai& key and base URL in `.dev.vars` instead.

### Deploy

```sh
pnpm exec wrangler secret put AIAND_API_KEY
pnpm run deploy
pnpm smoke https://<your-worker>.workers.dev      # one real session: costs tokens
```

The repo the agent works on is set by `DEMO_REPO` and `DEMO_SHA` in `wrangler.jsonc`. `KILL_SWITCH="1"` stops new sessions.

## Known limits: what a rebuilt sandbox does and does not bring back

A sandbox container is stopped after 15 idle minutes, on `done` and on `failed`. It is not rebuilt when the session wakes up; it is rebuilt the next time the agent needs it (for example after a Reject or a new message). Approving a finish needs no sandbox, so it never rebuilds one.

A rebuild starts from the repo at the pinned commit and writes the saved changes back. The limits:

- **Only file contents come back.** Background processes, `/tmp`, and anything git ignores (such as `node_modules`) start empty.
- **Files over 1 MB and binary files are not saved.** After a rebuild they are missing, and the restore note in the timeline names them.
- **Changes are saved when the agent edits a file** (`write_file`, `apply_patch`) **and when a run pauses or ends.** A file changed only by a command is saved at the next of those points. If the sandbox dies before that, the change is lost and the run ends as `failed`.

The UI must not suggest more than this: a restored workspace is "your file changes on a fresh checkout", not "the same machine". The full list of limits and open items is in [docs/limits.md](docs/limits.md).

## Layout

```
src/core/     the agent: loop, tools, modes, policy, model client, events (no platform imports)
src/session/  session state machine, SQLite store, wire protocol (no platform imports)
src/sandbox/  the sandbox adapter over a Cloudflare container
src/worker/   Worker router and the two Durable Objects (thin shells over src/session)
web/          the workspace UI (Vite + React + Tailwind); web/src/state is the event reducer, web/public the logo and the debug page
e2e/          Playwright browser tests against wrangler dev + the fake model
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
- [Phase 2 checklist](docs/features/session-do/session-do-implementation-checklist.md)
- [Phase 3 checklist](docs/features/workspace-ui/workspace-ui-implementation-checklist.md)

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
