# &run Core Loop + Eval — Implementation Checklist

**Status**: ✅ Approved (2026-09-30)
**Date**: 2026-09-30
**Architecture**: `docs/architecture/web-codex-architecture-decision.md` → Phase 1 (Day 1, morning)

## Goal
As the builder of &run, I want the agent loop to run and be measured locally against ai&, before any Cloudflare code exists. Then Phase 2 only has to host a loop that already works, and the model choice comes from data.
This slice is also what a reviewer reads first: `src/core/` is the agent.

## Scope
**In**
- `src/core/`, with no Cloudflare imports (D1):
  - `runAgent` (D2, D3)
  - the `events.ts` §5 union (D7)
  - `modes.ts` with `code` and `review` profiles (D4)
  - tools
  - `OpenAICompatModelClient` (SSE + tool-call assembly)
  - allowlist `ApprovalPolicy`
  - context compaction (D17)
  - per-mode model config (D19)
- `ScriptedModelClient` (test double) and `LocalSandbox` (D12)
- `eval/`: YAML loader, runner, JSONL trajectory writer, summary table, and 5 zero-dependency fixture repos (`node:test`)
- Day-1 spike (2 h time box, D15): a throwaway Sandbox SDK 1.0 container DO on a deployed Worker. The findings go into `docs/architecture/spike-sandbox-1.0.md`.

**Out**
- Cloudflare Worker, SessionDO, WorkspaceDO, WebSocket and `CloudflareSandboxAdapter` → Phase 2
- UI → Phase 3
- GitHub, PR creation, and posting findings → Phase 4. The `review` profile exists here only so that S7 can prove it cannot write.
- Task mode, auto-approve classifier, heterogeneous router → Phase 5 / bonus
- LLM-summary compaction → D17 excludes it

## Technical Notes
| Area | Change | Files |
|---|---|---|
| Tooling | Create: pnpm, TypeScript (strict, ESM), Vitest, eslint `no-restricted-imports` for `cloudflare:*` inside `src/core` | `package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js` |
| Event contract | Create: discriminated union of the 13 §5 events, the `message_delta` event, and the envelope `{seq, ts, sessionId, stepId?}` | `src/core/events.ts` |
| Ports | Create: `ModelClient`, `SandboxAdapter`, `ApprovalPolicy`, `AgentDeps` (`emit`, `checkpoint`, `drainUserMessages`, `signal`) | `src/core/types.ts` |
| Loop | Create: `runAgent(state, profile, deps) → RunOutcome` and `resume(state, decision)` | `src/core/agent.ts` |
| Tools | Create: `list_files`, `read_file`, `write_file`, `apply_patch` (`git apply` in the sandbox), `run_command`, `finish`, `report_finding` (review only) | `src/core/tools.ts` |
| Modes | Create: `code` and `review` profiles, and the system prompts (including "do not edit tests unless asked") | `src/core/modes.ts`, `src/core/prompts.ts` |
| Policy | Create: allowlist policy (`npm test`, `node --test`, `ls`, `cat`, `git diff`, `git status`, …) with `ask` for the rest, deletes and `finish` | `src/core/policy.ts` |
| Model | Create: fetch + SSE parser + tool-call delta assembly + usage; retry 2× with backoff on 429/5xx | `src/core/model.ts` |
| Context | Create: 8 KB tool-result cap, 70 % compaction, context-token estimate | `src/core/context.ts` |
| Config | Create: `models.{code,review}`, `contextWindow` per model, `maxSteps=30`, `maxTokens` | `src/core/config.ts` |
| Test doubles | Create | `test/support/scripted-model.ts` |
| Eval | Create | `eval/run.ts`, `eval/local-sandbox.ts`, `eval/cases/*.yaml`, `eval/fixtures/{sum-off-by-one,empty-array,slugify,cli-flag,multi-file}/` |
| Recorded SSE | Create: raw ai& stream captured once from the real API | `test/fixtures/aiand-sse/*.txt` |
| Spike | Create (throwaway, not merged into `src/`) | `spike/sandbox-1.0/`, `docs/architecture/spike-sandbox-1.0.md` |

Key Decisions: D1, D2, D3, D4, D7, D12, D15, D17, D19 (inherited).

Slice-level decisions:
- **S-a**: The eval runs with `EvalApprovalPolicy`, which wraps the real policy. Every `ask` is auto-approved and recorded as `auto_approved` in the JSONL. This matches acceptance A, where the only human input is Approve.
- **S-b**: Model/transport errors are retried 2× inside `ModelClient`. If they still fail, the loop emits `error{source:"model"}` and returns `failed`. They are not fed back to the model, because there is no model to feed them to.
- **S-c**: Tool errors are returned to the model as the tool result `{"error": …}`, as the spec requires.

Data flow and new dependencies: `yaml`, `vitest`, `tsx`, and `eslint`. There is no OpenAI SDK; plain `fetch` keeps the client identical under Workers.

## Acceptance Scenarios

### S1: Happy path reaches the approval gate
**Given** the `sum-off-by-one` fixture in a `LocalSandbox`, and a `ScriptedModelClient` scripted to run `list_files → run_command("npm test") [fails] → read_file → apply_patch → run_command("npm test") [passes] → finish("…summary")`
**When** `runAgent` runs with the `code` profile
**Then**
- It returns `{kind:"awaiting_approval", pending:{tool:"finish", summary, diffSummary}}`.
- Emitted events, in order: `status(running)`, `tool_call`/`tool_output` pairs (the first `npm test` has exit ≠ 0, the second has exit 0), `file_changed{path:"src/sum.js", diff}` after the patch, `approval_required`, `status(awaiting_approval)`.
- Every event has a strictly increasing `seq`.

**Test**: Unit — `test/core/agent.test.ts` › "code run reaches approval gate with ordered events"

### S2: Approve and reject resume the same loop
**Given** the state returned by S1, round-tripped through `JSON.stringify`/`JSON.parse`
**When** `resume(state, {approved:true})` runs, and separately `resume(state, {approved:false, comment:"also add a test for the empty array case"})` runs
**Then**
- Approve: returns `{kind:"finished"}` and emits `approval_resolved(approved)` and `status(done)`.
- Reject: the next model request contains the comment inside the `finish` tool result, and the loop continues until the scripted model calls `finish` again, which returns `awaiting_approval` again.

**Test**: Unit — `test/core/agent.test.ts` › "resume after approve finishes; reject feeds comment and loops back to gate"

### S3: Policy gates risky tool calls
**Given** the `code` profile
**When** the model calls:
- `run_command("npm test")`
- `run_command("rm -rf src")`
- `apply_patch` whose diff deletes a file (`deleted file mode`)
- `finish`

**Then** `npm test` executes without a gate. The other three each return `awaiting_approval` with a `reason` (for example `"command not in allowlist: rm"`), and nothing runs in the sandbox before approval.
**Test**: Unit — `test/core/policy.test.ts` › "allowlist allows, others ask" and `test/core/agent.test.ts` › "gated command is not executed before approval"

### S4: Review profile cannot write
**Given** the `review` profile
**When** the model calls `apply_patch` or `write_file`
**Then**
- The tool list sent to the model does not contain `apply_patch` or `write_file`.
- A call to either tool returns the tool result `{"error":"unknown tool: apply_patch"}`.
- The sandbox's `git status --porcelain` is empty at the end.
- `report_finding` calls emit `review_finding{id, path, line, severity, text}`.

**Test**: Unit — `test/core/modes.test.ts` › "review profile exposes no write tools and leaves workspace clean"

### S5: Budgets stop the loop visibly
**Given** `maxSteps=3`, or `maxTokens=1000` with a scripted usage of 600 tokens per turn
**When** `runAgent` runs
**Then** it returns `{kind:"budget_exceeded"}` after step 3 (or after the second turn), and emits `error{source:"budget", message}` and `status(budget_exceeded)`. No further model call is made.
**Test**: Unit — `test/core/agent.test.ts` › "step cap stops with budget_exceeded" and "token cap stops with budget_exceeded"

### S6: Tool errors return to the model; 3 strikes asks the user
**Given** a scripted model that calls `read_file("missing.js")` 3 times in a row
**When** `runAgent` runs
**Then**
- Calls 1 and 2 produce tool results `{"error":"ENOENT …"}` and `error{source:"tool"}` events, and the loop continues.
- After the 3rd consecutive failure it returns `awaiting_approval` with the reason `"read_file failed 3 times"`.
- Any successful call in between resets the counter.

**Test**: Unit — `test/core/agent.test.ts` › "tool errors fed back; 3 consecutive failures ask user"

### S7: Model failures are visible
**Given** a `fetch` mock returning 500, 500, 500 (and separately 500, 500, 200)
**When** the `ModelClient` is called inside `runAgent`
**Then**
- 3 failures: `error{source:"model"}` is emitted with the HTTP status, and the loop returns `{kind:"failed"}` with `status(failed)`.
- 2 failures then 200: the loop proceeds normally with no `error` event.

**Test**: Unit — `test/core/model.test.ts` › "retries twice then fails visibly"

### S8: SSE tool-call assembly matches real ai& output
**Given** raw SSE recorded from ai& (`test/fixtures/aiand-sse/tool-call.txt`), where the tool-call arguments are split across chunks
**When** it is parsed by `OpenAICompatModelClient`
**Then**
- It yields `message_delta` events for text, and one assembled tool call with valid JSON args.
- `usage{tokens_in, tokens_out, model, latency_ms}` matches the final chunk.

**Test**: Unit — `test/core/model.test.ts` › "assembles split tool-call args from recorded ai& stream"

### S9: Context stays inside the window (D17)
**Given** a `read_file` result of 50 KB, and a state whose estimated prompt is 75 % of `contextWindow` across 12 steps
**When** the next model request is built
**Then**
- The 50 KB result is sent as ≤ 8 KB with `[… N bytes elided]`.
- The tool results older than the last 6 steps become one-line stubs.
- The system prompt and user messages are unchanged.
- The `usage` event carries `context_tokens` < 70 % of `context_window`.

**Test**: Unit — `test/core/context.test.ts` › "caps tool output" and "compacts old tool results above 70%"

### S10: Checkpoint every step, resumable from any step
**Given** a 6-step scripted run
**When** it runs, with `deps.checkpoint` capturing each state
**Then** `checkpoint` is called once per step. For each captured state `k`, running `runAgent` from a JSON round-trip of it with the remaining script ends in the same outcome and final diff as the uninterrupted run.
**Test**: Unit — `test/core/agent.test.ts` › "resume from any checkpoint yields same outcome"

### S11: Per-mode model and usage attribution (D19)
**Given** config `models.code="<coding-model>"` and `models.review="<review-model>"`
**When** each profile runs one turn
**Then** the request body `model` equals the configured id, and every `usage` event has the matching `model` field.
**Test**: Unit — `test/core/model.test.ts` › "uses per-mode model id and reports it in usage"

### S12: Eval runner writes a trajectory and scores honestly
**Given** `eval/cases/sum-off-by-one.yaml`, run with a `ScriptedModelClient` twice: once with a legitimate fix, and once with a "fix" that edits `test/sum.test.js`
**When** `pnpm eval --case sum-off-by-one --runs 1 --model scripted` runs
**Then**
- `eval/runs/<ts>/sum-off-by-one-1.jsonl` exists; each line is a §5 event, and the last line is `{type:"result", pass, steps, tokens_in, tokens_out, cost, tool_errors, edited_tests, auto_approved}`.
- The legitimate run has `pass:true` (the check command exits 0).
- The test-editing run has `edited_tests:true` and `pass:false`, even though the tests pass.
- stdout prints a summary table with one row per case.

**Test**: Integration — `test/eval/runner.test.ts` › "writes JSONL and fails runs that edit tests"

### S13: Core is platform-free (D1)
**Given** the repository
**When** `pnpm lint` runs
**Then** it fails if any file under `src/core/` imports `cloudflare:*`, `@cloudflare/*` or `node:*` (so core stays portable to Workers). The current tree passes.
**Test**: Unit — `test/core/boundary.test.ts` › "src/core has no platform imports"

### S14: Real model passes the seeded cases
**Given** `AIAND_API_KEY` in `.env` (git-ignored), and the 5 fixture cases
**When** `pnpm eval --runs 3 --model <coding-model>` runs
**Then** every case passes ≥ 2/3, no run has `edited_tests:true`, and the summary is saved to `eval/runs/<ts>/summary.md`.
**Test**: Runtime — the eval run itself, against the real ai& API. This is the spec §8 acceptance A from the CLI.

## Edge Cases
- [ ] `apply_patch` with a patch that doesn't apply → a tool error containing the `git apply` stderr, fed back to the model. **Test**: `test/core/tools.test.ts` › "failed patch returns stderr"
- [ ] Path traversal (`../../etc/passwd`, absolute paths) in `read_file`/`write_file` → a tool error, and nothing outside the workspace is read. **Test**: `test/core/tools.test.ts` › "rejects paths outside workspace"
- [ ] `write_file` > 1 MB → a tool error (headroom under the 2 MB DO row limit; see ADR "Cost and limits"). **Test**: `test/core/tools.test.ts` › "rejects files over 1 MB"
- [ ] `run_command` exceeding 120 s → aborted via `AbortSignal`, and `tool_output` exit is reported as a timeout. **Test**: `test/eval/local-sandbox.test.ts` › "command timeout aborts" (uses a 1 s override)
- [ ] The model returns malformed JSON tool args → a tool error `"invalid arguments"` is fed back, and it counts toward 3 strikes. **Test**: `test/core/agent.test.ts` › "malformed tool args are fed back"
- [ ] The model replies with text only and no tool call → the text is emitted as a `message`, and the loop nudges once ("call a tool or finish"). A second text-only reply is treated as `finish`, which goes through the gate. **Test**: `test/core/agent.test.ts` › "text-only turn nudges then gates"
- [ ] A user redirect message is queued mid-run → it is injected at the next step boundary as a user message. **Test**: `test/core/agent.test.ts` › "drained user message injected before next model call"
- [ ] `signal` is aborted → the loop stops after the current step and returns `failed` with `error{source:"sandbox"|"model"}` naming the cause. **Test**: `test/core/agent.test.ts` › "abort stops loop visibly"
- [ ] Spike: the 1.0 container DO clones a fixture via `Files` + tarball, streams `node --test` output, and reports whether one DO class can be both session and container. **Runtime check**: deployed throwaway Worker; findings recorded in `spike-sandbox-1.0.md`, including a go/no-go on the D15 fallback

Not applicable:
- Auth/PII: no users (spec D3).
- Concurrency: one loop per session, and DO serialization comes in Phase 2.
- UI states: no UI in this slice.

## Open Questions
- [ ] **ai& API access**: base URL, key, and model IDs (Kimi code / K3) and their context windows. This blocks S8 fixture capture and S14. — decide by: Henry (the key comes from Mutsumi/Hara or the free trial)
- [x] Tooling defaults: pnpm + Vitest + tsx + eslint — confirmed by Henry
- [ ] `apply_patch` takes a unified diff applied with `git apply`; `write_file` covers new files and full rewrites. Assumes the model produces valid unified diffs; if S14 shows many patch failures, add a search/replace `edit_file` tool. — decide by: during build (eval data)
- [ ] Eval cost per full run (5 × 3) is unknown until the ai& pricing and model are known. — decide by: during build
- [x] Docker is installed — confirmed by Henry

## Build Progress
| # | Unit | Proves | Status |
|---|---|---|---|
| 0 | Scaffold + contract (`events.ts`, `types.ts`, `config.ts`), written by the commander as the test contract | S13 | ✅ done |
| 1 | `context.ts`, `diff.ts`, `policy.ts` | S3 (policy), S9 (unit) | ✅ done |
| 2 | `tools.ts` + `eval/local-sandbox.ts` | Edge: patch stderr, traversal, >1 MB, timeout | ✅ done |
| 3 | `model.ts` (SSE, retries, per-mode model) | S7 (client), S8 (OpenAI-format fixture), S11 (request) | ✅ done |
| 4 | `modes.ts`, `prompts.ts`, `agent.ts` | S1, S2, S3, S4, S5, S6, S7, S9, S10, S11, loop edge cases | ✅ done |
| 5 | `eval/` runner, 5 fixtures, cases | S12 | ✅ done |
| 6 | Sandbox 1.0 spike (deploy needs Henry's OK) | Spike edge case | ⏳ pending |
| — | Real ai& SSE capture + real eval | S8 (real), S14 | ⛔ blocked: waiting for the ai& API key |

Build notes:
- S12's test drives the runner through its exported `runEval()` API with a `ScriptedModelClient`. The `pnpm eval` CLI is a thin wrapper, verified at runtime.
- S8 is tested now against an OpenAI-format fixture. The recorded ai& fixture test is `skipIf` absent, and gets activated when the key arrives.
- Unit 1 review: `find -delete`/`-exec` and `git … --output` could delete or write files through the allowlist. The commander added these cases to `policy.test.ts` (it strengthens S3, so the spec meaning is unchanged) and blocked write-capable flags in `policy.ts`.
- Unit 2 review: `write_file`/`apply_patch` could write into `.git/` (e.g. `.git/info/exclude`) and hide changes from the approval diff. The commander added a test to `tools.test.ts` (it strengthens the path-traversal edge case) and reserved `.git` in `validatePath`.
- Unit 4 review: when a run finished, the `finish` tool_call (and any later calls in the same turn) had no tool message. The next turn after `done` (ADR D6) would then send an invalid transcript and get a 400. The commander added "transcript stays valid for the next turn" tests to `agent.test.ts` (a new invariant; no scenario changed meaning), and `done()` now answers those calls.
- Unit 5 review: the check runs in the agent-modified workspace, so rewriting the `package.json` test script to `true` would "pass" without touching `test/`. The commander added `package.json` to every case's `forbid_changes` and a script-cheat run to `runner.test.ts`. This strengthens S12's "no cheating", and `edited_tests` now means "edited a protected file".
- S10 uses an in-memory `MemorySandbox` test double, so a checkpoint can snapshot the workspace.
