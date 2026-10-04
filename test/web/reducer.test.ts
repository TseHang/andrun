import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent, EventBody, PlanStep } from "../../src/core/events";
import { RESTORED_NOTE, type ServerFrame } from "../../src/session/protocol";
import { activityLabel, planNote, rowSummary, rowTone } from "../../web/src/state/format";
import { addPending, dropStreaming, initialView, markSending, reduce, type SessionView, type StepRow } from "../../web/src/state/reducer";

/** Builds events with increasing seq and ts, like one session's log. */
function script(start = { seq: 0, ts: 1_700_000_000_000 }) {
  let { seq, ts } = start;
  return (body: EventBody & Record<string, unknown>, opts: { step?: number; dt?: number } = {}): AgentEvent => {
    seq += 1;
    ts += opts.dt ?? 100;
    return { ...body, seq, ts, sessionId: "s-1", ...(opts.step !== undefined && { stepId: `s${opts.step}` }) } as AgentEvent;
  };
}

const run = (frames: ServerFrame[], from: SessionView = initialView()) => frames.reduce(reduce, from);
const rows = (v: SessionView): StepRow[] => v.items.flatMap((i) => (i.kind === "steps" ? i.rows : []));
const kinds = (v: SessionView) => v.items.map((i) => i.kind);

const diffOf = (path: string, del: string[], add: string[]) =>
  [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${del.length + 1} +1,${add.length + 1} @@`,
    " keep",
    ...del.map((l) => `-${l}`),
    ...add.map((l) => `+${l}`),
    "",
  ].join("\n");

const NEW_TEST = [
  "diff --git a/test/empty.test.js b/test/empty.test.js",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/test/empty.test.js",
  "@@ -0,0 +1,2 @@",
  "+a",
  "+b",
  "",
].join("\n");

describe("view state (P3-a)", () => {
  it("a recorded run reduces to timeline, gate and header totals", () => {
    // The persisted events of one fake-model run up to the gate (`pnpm fake-model` + `wrangler dev`).
    const file = join(import.meta.dirname, "../fixtures/events/happy.jsonl");
    const events = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as AgentEvent);
    const v = run(events);

    expect(kinds(v)).toEqual(["user", "steps", "assistant", "steps", "assistant", "steps"]);
    expect(v.items[0]).toMatchObject({ kind: "user", text: "make the failing test pass", pending: false });
    expect(v.items[2]).toMatchObject({ kind: "assistant", text: "Running the tests first.", streaming: false });
    for (const item of v.items) {
      if (item.kind === "assistant") expect(item.usage).toMatchObject({ model: "deepseek-ai/deepseek-v4-flash" });
    }

    const r = rows(v);
    expect(r.map((row) => row.name)).toEqual(["sandbox_setup", "run_command", "read_file", "apply_patch", "run_command"]);
    expect(r[0]!.arg).toMatch(/^ready in \d+\.\d s$/);
    expect(r.slice(1).map((row) => row.arg)).toEqual(["npm test", "src/sum.js", "src/sum.js", "npm test"]);
    expect(r[1]).toMatchObject({ exitCode: 1, done: true, expanded: true });
    expect(r[3]).toMatchObject({ additions: 1, deletions: 1, done: true });
    expect(r[4]).toMatchObject({ exitCode: 0, done: true, expanded: false });

    // Each row lasts from its tool_call to its last tool_output.
    for (const row of r) {
      const call = events.find((e) => e.type === "tool_call" && e.callId === row.callId)!;
      const last = events.filter((e) => e.type === "tool_output" && e.callId === row.callId).at(-1)!;
      expect(row.durationMs).toBe(last.ts - call.ts);
    }

    const gate = events.find((e): e is Extract<AgentEvent, { type: "approval_required" }> => e.type === "approval_required")!;
    expect(v.status).toBe("awaiting_approval");
    expect(v.gate).toMatchObject({
      approvalId: gate.approvalId,
      tool: "finish",
      reason: "finishing requires approval",
      summary: gate.summary,
      diffSummary: gate.diffSummary,
      primary: "Approve",
      secondary: "Send",
    });
    expect(v.lastCommand).toEqual({ command: "npm test", exitCode: 0 });

    const usages = events.filter((e): e is Extract<AgentEvent, { type: "usage" }> => e.type === "usage");
    const steps = events.flatMap((e) => (e.stepId ? [Number(e.stepId.slice(1))] : []));
    expect(v.header.step).toBe(Math.max(...steps));
    expect(v.header.contextTokens).toBe(usages.at(-1)!.context_tokens);
    expect(v.header.contextWindow).toBe(usages.at(-1)!.context_window);
    expect(v.header.cost).toBeCloseTo(usages.reduce((sum, u) => sum + (u.cost ?? 0), 0), 10);
    expect(v.lastSeq).toBe(events.at(-1)!.seq);
  });

  it("deltas build one message and replay without deltas matches", () => {
    const e = script();
    const d1 = e({ type: "message_delta", id: "m1", text: "Running the " }, { step: 1 });
    const d2 = e({ type: "message_delta", id: "m1", text: "tests first." }, { step: 1 });
    const final = e({ type: "message", id: "m1", role: "assistant", text: "Running the tests first." }, { step: 1 });

    const streaming = run([d1, d2]);
    expect(streaming.items).toEqual([expect.objectContaining({ kind: "assistant", text: "Running the tests first.", streaming: true })]);

    const live = reduce(streaming, final);
    const replayed = run([final]);
    expect(live.items).toEqual(replayed.items);
    expect(live.items).toEqual([expect.objectContaining({ kind: "assistant", text: "Running the tests first.", streaming: false })]);

    // A delta for a message that is already final changes nothing.
    const late = { ...d1, seq: final.seq + 1, text: "zzz" } as AgentEvent;
    expect(reduce(live, late).items).toEqual(live.items);
  });

  it("reasoning streams into its own item, the stored event replaces it, and a routed turn says its model", () => {
    const e = script();
    const routed = e({ type: "model_routed", task: "complex", model: "deepseek-ai/deepseek-v4.1-flash", reasoning: "high" });
    const d1 = e({ type: "reasoning_delta", id: "m1", text: "The loop " }, { step: 1 });
    const d2 = e({ type: "reasoning_delta", id: "m1", text: "stops early." }, { step: 1 });
    const final = e({ type: "reasoning", id: "m1", text: "The loop stops early." }, { step: 1 });
    const message = e({ type: "message", id: "m1", role: "assistant", text: "Fixing it." }, { step: 1 });

    const streaming = run([routed, d1, d2]);
    expect(streaming.items).toEqual([
      expect.objectContaining({ kind: "routed", task: "complex", model: "deepseek-ai/deepseek-v4.1-flash", reasoning: "high" }),
      expect.objectContaining({ kind: "reasoning", text: "The loop stops early.", streaming: true }),
    ]);
    expect(dropStreaming(streaming).items.map((i) => i.kind)).toEqual(["routed"]);

    const live = reduce(reduce(streaming, final), message);
    const replay = run([routed, final, message]);
    expect(live.items).toEqual(replay.items);
    expect(live.items.map((i) => i.kind)).toEqual(["routed", "reasoning", "assistant"]);
    expect(live.items[1]).toMatchObject({ text: "The loop stops early.", streaming: false });
  });

  it("command rows show streamed chunks once; non-stream tools show the result", () => {
    const e = script();
    const v = run([
      e({ type: "tool_call", callId: "c1", name: "run_command", args: { command: "npm test" }, summary: "npm test" }, { step: 1 }),
      e({ type: "tool_output", callId: "c1", stream: "stdout", chunk: "one\n" }, { step: 1 }),
      e({ type: "tool_output", callId: "c1", stream: "stdout", chunk: "two\n" }, { step: 1 }),
      e({ type: "tool_output", callId: "c1", stream: "stderr", chunk: "warn\n" }, { step: 1 }),
      e({ type: "tool_output", callId: "c1", stream: "stdout", chunk: "three\n" }, { step: 1 }),
      e({ type: "tool_output", callId: "c1", stream: "result", chunk: "one\ntwo\nwarn\nthree\n", exitCode: 1 }, { step: 1, dt: 1100 }),
      e({ type: "tool_call", callId: "c2", name: "run_command", args: { command: "sleep 999" }, summary: "sleep 999" }, { step: 2 }),
      e({ type: "tool_output", callId: "c2", stream: "result", chunk: "timed out", exitCode: null }, { step: 2 }),
      e({ type: "tool_call", callId: "c3", name: "read_file", args: { path: "src/sum.js" }, summary: "src/sum.js" }, { step: 3 }),
      e({ type: "tool_output", callId: "c3", stream: "result", chunk: "export function sum() {}" }, { step: 3 }),
    ]);
    const [cmd, slow, read] = rows(v);

    expect(cmd!.output).toEqual([
      { stream: "stdout", text: "one\n" },
      { stream: "stdout", text: "two\n" },
      { stream: "stderr", text: "warn\n" },
      { stream: "stdout", text: "three\n" },
    ]);
    expect(cmd).toMatchObject({ exitCode: 1, done: true, expanded: true });
    expect(rowSummary(cmd!)).toBe("exit 1 · 1.5 s"); // from the call to the result
    expect(rowTone(cmd!)).toBe("failed");

    expect(slow).toMatchObject({ exitCode: null, done: true });
    expect(rowSummary(slow!)).toMatch(/^timed out · \d+\.\d s$/);
    expect(rowTone(slow!)).toBe("failed");

    expect(read!.output).toEqual([{ stream: "result", text: "export function sum() {}" }]);
    expect(read).toMatchObject({ done: true, expanded: false });
    expect(rowTone(read!)).not.toBe("failed");
  });

  it("changes keep the latest diff per path and flag test paths", () => {
    const e = script();
    const first = diffOf("src/sum.js", ["old"], ["new"]);
    const second = diffOf("src/sum.js", ["old", "older"], ["new", "newer"]);
    const v = run([
      e({ type: "file_changed", path: "src/sum.js", diff: first }, { step: 1 }),
      e({ type: "file_changed", path: "test/empty.test.js", diff: NEW_TEST }, { step: 2 }),
      e({ type: "file_changed", path: "src/sum.js", diff: second }, { step: 3 }),
      e({
        type: "approval_required",
        approvalId: "a1",
        tool: "finish",
        reason: "finishing requires approval",
        summary: "done",
        diffSummary: {
          files: [
            { path: "coverage/out.json", additions: 2, deletions: 0 },
            { path: "src/sum.js", additions: 2, deletions: 2 },
            { path: "test/empty.test.js", additions: 2, deletions: 0 },
          ],
        },
      }),
    ]);

    expect(v.changes).toEqual([
      { path: "src/sum.js", additions: 2, deletions: 2, diff: second },
      { path: "test/empty.test.js", additions: 2, deletions: 0, diff: NEW_TEST },
      { path: "coverage/out.json", additions: 2, deletions: 0, diff: null }, // changed by a command: no diff
    ]);
    expect(v.testPaths).toEqual(["test/empty.test.js"]);

    // The panel keeps its files after the gate is resolved.
    const after = reduce(v, e({ type: "approval_resolved", approvalId: "a1", approved: true }));
    expect(after.changes).toEqual(v.changes);

    const noTests = run([script()({ type: "file_changed", path: "src/sum.js", diff: first })]);
    expect(noTests.testPaths).toEqual([]);
  });

  it("gate variants and resolution markers", () => {
    const finish = () => {
      const e = script();
      return {
        e,
        frames: [
          e({ type: "tool_call", callId: "f1", name: "finish", args: { summary: "Fixed it." }, summary: "finish" }, { step: 5 }),
          e({ type: "approval_required", approvalId: "a1", tool: "finish", reason: "finishing requires approval", summary: "Fixed it." }, { step: 5 }),
          e({ type: "status", status: "awaiting_approval" }, { step: 5 }),
        ],
      };
    };
    const f = finish();
    const atFinish = run(f.frames);
    expect(atFinish.gate).toMatchObject({ tool: "finish", reason: "finishing requires approval", summary: "Fixed it.", primary: "Approve", secondary: "Send" });
    expect(rows(atFinish).map((r) => r.name)).not.toContain("finish");

    let e = script();
    const cmd = run([
      e({ type: "tool_call", callId: "r1", name: "run_command", args: { command: "rm -rf tmp" }, summary: "rm -rf tmp" }, { step: 1 }),
      e({ type: "approval_required", approvalId: "a2", tool: "run_command", reason: "command not in allowlist: rm" }, { step: 1 }),
      e({ type: "status", status: "awaiting_approval" }, { step: 1 }),
    ]);
    expect(cmd.gate).toMatchObject({ command: "rm -rf tmp", reason: "command not in allowlist: rm", primary: "Run once", secondary: "Don't run" });
    // Refused: the run goes on, and the command never ran.
    const declined = reduce(cmd, e({ type: "approval_resolved", approvalId: "a2", approved: false, comment: "Do not run this command." }));
    expect(declined.gate).toBeNull();
    const declinedRow = rows(declined)[0]!;
    expect(declinedRow).toMatchObject({ done: true });
    expect(declinedRow.exitCode).toBeUndefined();
    expect(rowSummary(declinedRow)).toMatch(/^declined/);

    e = script();
    const deletion = "--- a/src/old.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-export const old = 1;\n";
    const patch = run([
      e({ type: "tool_call", callId: "p1", name: "apply_patch", args: { patch: deletion }, summary: "src/old.js" }, { step: 1 }),
      e({ type: "approval_required", approvalId: "a3", tool: "apply_patch", reason: "patch deletes files: src/old.js" }, { step: 1 }),
    ]);
    expect(patch.gate).toMatchObject({ paths: ["src/old.js"], reason: "patch deletes files: src/old.js", primary: "Apply", secondary: "Don't apply" });

    e = script();
    const strikes: AgentEvent[] = [];
    for (let i = 1; i <= 3; i++) {
      strikes.push(
        e({ type: "tool_call", callId: `x${i}`, name: "read_file", args: { path: "missing.js" }, summary: "missing.js" }, { step: i }),
        e({ type: "tool_output", callId: `x${i}`, stream: "result", chunk: "ENOENT: missing.js" }, { step: i }),
        e({ type: "error", source: "tool", message: "ENOENT: missing.js", next: "The agent sees this error and can try again." }, { step: i }),
      );
    }
    strikes.push(e({ type: "approval_required", approvalId: "a4", tool: "read_file", reason: "read_file failed 3 times" }, { step: 3 }));
    const struck = run(strikes);
    expect(struck.gate).toMatchObject({ tool: "read_file", reason: "read_file failed 3 times", primary: "Let it continue", secondary: "Redirect" });
    expect(struck.gate!.command).toBeUndefined();
    expect(struck.gate!.paths).toBeUndefined();

    const approved = reduce(atFinish, f.e({ type: "approval_resolved", approvalId: "a1", approved: true }));
    expect(approved.gate).toBeNull();
    expect(approved.items.at(-1)).toMatchObject({ kind: "approved", finish: true });
    // Code review: only the finish approval may carry the "no pull request" note, not a mid-run gate.
    const letContinue = reduce(struck, e({ type: "approval_resolved", approvalId: "a4", approved: true }));
    expect(letContinue.items.at(-1)).toMatchObject({ kind: "approved", finish: false });

    const rejected = reduce(atFinish, f.e({ type: "approval_resolved", approvalId: "a1", approved: false, comment: "also add a test for the empty array case" }));
    expect(rejected.gate).toBeNull();
    expect(rejected.items.at(-1)).toMatchObject({ kind: "user", text: "also add a test for the empty array case", pending: false });
  });

  it("errors become inline rows, notices or failure cards", () => {
    let e = script();
    const tool = run([
      e({ type: "tool_call", callId: "c1", name: "read_file", args: { path: "missing.js" }, summary: "missing.js" }, { step: 1 }),
      e({ type: "tool_output", callId: "c1", stream: "result", chunk: "ENOENT: missing.js" }, { step: 1 }),
      e({ type: "error", source: "tool", message: "ENOENT: missing.js", next: "The agent sees this error and can try again." }, { step: 1 }),
    ]);
    expect(kinds(tool)).toEqual(["steps"]);
    expect(rows(tool)[0]).toMatchObject({ error: "ENOENT: missing.js", expanded: true, done: true });
    expect(rowSummary(rows(tool)[0]!)).toMatch(/^failed/);
    expect(rowTone(rows(tool)[0]!)).toBe("failed");

    e = script();
    const restored = `${RESTORED_NOTE} Not restored (over 1 MB or binary): data/big.json.`;
    const note = run([e({ type: "error", source: "sandbox", message: restored, next: "The run continues." })]);
    expect(note.items).toEqual([expect.objectContaining({ kind: "notice", title: "Your changes are on a fresh checkout", message: restored })]);

    e = script();
    const lost = run([
      e({ type: "status", status: "running" }),
      e({ type: "tool_call", callId: "c1", name: "run_command", args: { command: "npm test" }, summary: "npm test" }, { step: 1 }),
      e({ type: "error", source: "sandbox", message: "the sandbox was lost" }, { step: 1 }),
      e({ type: "status", status: "failed" }, { step: 1 }),
    ]);
    expect(lost.items.at(-1)).toMatchObject({ kind: "failure", title: "The sandbox was lost", message: "the sandbox was lost" });
    expect(lost.status).toBe("failed");
    expect(rows(lost).every((r) => r.done)).toBe(true); // no spinner is left behind
    expect(lost.composerEnabled).toBe(true);

    e = script();
    const model = run([e({ type: "error", source: "model", message: "HTTP 500 from ai&" }), e({ type: "status", status: "failed" })]);
    expect(model.items.at(-1)).toMatchObject({ kind: "failure", title: "ai& did not answer", message: "HTTP 500 from ai&" });
    expect(model.composerEnabled).toBe(true);

    e = script();
    const budget = run([
      e({ type: "error", source: "budget", message: "step limit reached (30)" }),
      e({ type: "status", status: "budget_exceeded" }),
    ]);
    expect(budget.items.at(-1)).toMatchObject({ kind: "failure", title: "Limit reached", message: "step limit reached (30)" });
    expect(budget.composerEnabled).toBe(true); // HI-h: a message continues it
  });

  it("a pending message is resolved by its message or by a rejection with the same comment", () => {
    let e = script();
    const running = run([e({ type: "status", status: "running" })]);
    const queued = addPending(running, "also rename the helper");
    expect(queued.items.at(-1)).toMatchObject({ kind: "user", text: "also rename the helper", pending: true });

    const injected = reduce(queued, e({ type: "message", id: "u2", role: "user", text: "also rename the helper" }, { step: 2 }));
    const bubbles = injected.items.filter((i) => i.kind === "user" && i.text === "also rename the helper");
    expect(bubbles).toEqual([expect.objectContaining({ pending: false })]);

    e = script();
    const late = addPending(run([e({ type: "status", status: "running" })]), "redo it");
    const atGate = run(
      [
        e({ type: "approval_required", approvalId: "a1", tool: "finish", reason: "finishing requires approval" }),
        e({ type: "status", status: "awaiting_approval" }),
        e({ type: "approval_resolved", approvalId: "a1", approved: false, comment: "redo it" }),
      ],
      late,
    );
    expect(atGate.items.filter((i) => i.kind === "user" && i.text === "redo it")).toEqual([expect.objectContaining({ pending: false })]);
  });

  it("rows show meta when present", () => {
    const e = script();
    const v = run([
      e({ type: "tool_call", callId: "c1", name: "read_file", args: { path: "big.txt" }, summary: "big.txt" }),
      e({ type: "tool_output", callId: "c1", stream: "result", chunk: "…", meta: { bytes: 5000 } }),
      e({ type: "tool_call", callId: "c2", name: "list_files", args: {}, summary: "." }),
      e({ type: "tool_output", callId: "c2", stream: "result", chunk: "a\nb\nc", meta: { files: 3 } }),
      e({ type: "tool_call", callId: "c3", name: "read_file", args: { path: "old.txt" }, summary: "old.txt" }),
      e({ type: "tool_output", callId: "c3", stream: "result", chunk: "stored before Phase 3" }),
    ]);
    const [read, list, old] = rows(v);
    expect(rowSummary(read!)).toMatch(/^5\.0 kB · \d+\.\d s$/);
    expect(rowSummary(list!)).toMatch(/^3 files · \d+\.\d s$/);
    expect(rowSummary(old!)).toMatch(/^\d+\.\d s$/);
  });

  it("unknown events are ignored", () => {
    const e = script();
    const base = run([e({ type: "message", id: "u1", role: "user", text: "hi" })]);
    const after = run(
      [
        // pr_opened, review_finding and review_posted are drawn since Phase 4 (see the last describe).
        e({ type: "artifact", name: "a.txt", size: 1, url: "https://example.com/a.txt" }),
        e({ type: "something_new" } as unknown as EventBody),
      ],
      base,
    );
    expect(after.items).toEqual(base.items);
    expect(after.gate).toBeNull();
  });

  it("duplicate and gapped seq", () => {
    const e = script();
    const a = e({ type: "message", id: "u1", role: "user", text: "one" });
    const b = e({ type: "message", id: "m1", role: "assistant", text: "two" }, { step: 1 });
    e({ type: "message_delta", id: "m2", text: "never persisted" }); // leaves a gap in the stored seq
    const c = e({ type: "message", id: "m2", role: "assistant", text: "three" }, { step: 2 });
    const v = run([a, b, c]);
    expect(v.items.map((i) => (i.kind === "user" || i.kind === "assistant" ? i.text : ""))).toEqual(["one", "two", "three"]);
    expect(v.lastSeq).toBe(c.seq);

    expect(run([b, { ...a, seq: b.seq } as AgentEvent], v).items).toEqual(v.items); // at or below the highest seq
  });

  it("a refused frame is shown, not stored", () => {
    const e = script();
    const gate = run([
      e({ type: "approval_required", approvalId: "a1", tool: "finish", reason: "finishing requires approval" }),
      e({ type: "status", status: "awaiting_approval" }),
    ]);
    const sending = markSending(gate);
    expect(sending.sending).toBe(true);

    const refused = reduce(sending, { type: "rejected", reason: "no such pending approval" });
    expect(refused.sending).toBe(false);
    expect(refused.refused).toBe("no such pending approval");
    expect(refused.items).toEqual(gate.items);
    expect(refused.lastSeq).toBe(gate.lastSeq);
    expect(markSending(refused).refused).toBeNull();

    const resolved = reduce(sending, e({ type: "approval_resolved", approvalId: "a1", approved: true }));
    expect(resolved.sending).toBe(false);
  });
});

describe("review findings (PR)", () => {
  it("a refused message leaves no queued bubble behind", () => {
    const e = script();
    const queued = addPending(run([e({ type: "status", status: "running" })]), "also rename the helper");
    const refused = reduce(queued, { type: "rejected", reason: "no such session" });
    expect(refused.items.some((i) => i.kind === "user" && i.pending)).toBe(false);
    expect(refused.refused).toBe("no such session");
  });

  it("a reconnect clears the sending state and unacknowledged bubbles", () => {
    const e = script();
    const v = markSending(addPending(run([e({ type: "status", status: "running" })]), "lost in the drop"));
    const after = dropStreaming(v);
    expect(after.sending).toBe(false);
    expect(after.items.some((i) => i.kind === "user" && i.pending)).toBe(false);
  });

  it("patch counts and paths ignore '-- ' and '++ ' lines inside a hunk", () => {
    const e = script();
    const patch = [
      "--- a/db/schema.sql",
      "+++ b/db/schema.sql",
      "@@ -1,3 +1,3 @@",
      " create table t (id int);",
      "--- old comment",
      "+++ new comment",
      " select 1;",
      "",
    ].join("\n");
    const v = run([e({ type: "tool_call", callId: "p1", name: "apply_patch", args: { patch }, summary: "db/schema.sql" })]);
    expect(rows(v)[0]).toMatchObject({ arg: "db/schema.sql", additions: 1, deletions: 1 });
  });
});

describe("Phase 4: pull requests and reviews", () => {
  const gate = (e: ReturnType<typeof script>) => [
    e({ type: "status", status: "running" }),
    e({ type: "approval_required", approvalId: "a1", tool: "finish", reason: "finishing requires approval", summary: "Fixed." }),
    e({ type: "status", status: "awaiting_approval" }),
  ];

  it("pr_opened card", () => {
    const e = script();
    const url = "https://github.com/TseHang/andrun-demo/pull/12";
    let v = run([
      ...gate(e),
      e({ type: "pr_opened", url, number: 12, branch: "agent/1a2b3c4d-1" }),
      e({ type: "approval_resolved", approvalId: "a1", approved: true }),
      e({ type: "status", status: "done" }),
    ]);
    expect(kinds(v)).toEqual(["approved", "pr"]); // the marker first, then what the approval did
    expect(v.items[1]).toMatchObject({ kind: "pr", url, number: 12, branch: "agent/1a2b3c4d-1", updated: false });
    expect(v.pr).toEqual({ url, number: 12, branch: "agent/1a2b3c4d-1" });

    // Round 2 on the same pull request: a second card, and `pr` stays the same pull request.
    v = run([e({ type: "pr_opened", url, number: 12, branch: "agent/1a2b3c4d-1", updated: true })], v);
    expect(v.items.at(-1)).toMatchObject({ kind: "pr", number: 12, updated: true });
    expect(v.pr).toMatchObject({ number: 12 });

    // An event stored before the optional fields existed still gives a card with its link.
    const old = run([e({ type: "pr_opened", url })]);
    expect(old.items[0]).toMatchObject({ kind: "pr", url, updated: false });
    expect(old.pr).toEqual({ url });
    expect(initialView().pr).toBeNull();
  });

  it("a finding update replaces by id", () => {
    const e = script();
    const f = (id: string, line: number, extra: Record<string, unknown> = {}) =>
      e({ type: "review_finding", id, path: "src/slugify.js", line, severity: "high", text: `finding ${id}`, inline: true, ...extra });
    let v = run([f("a", 4), f("b", 5, { inline: false }), f("c", 6)]);
    expect(v.findings.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(v.findings[0]).toEqual({ id: "a", path: "src/slugify.js", line: 4, severity: "high", text: "finding a", inline: true, dismissed: false, edited: false });
    expect(v.findings[1]).toMatchObject({ inline: false });
    expect(kinds(v)).toEqual([]); // findings live in the panel, not in the timeline

    v = run([f("b", 5, { inline: false, dismissed: true }), e({ type: "review_finding", id: "a", path: "src/slugify.js", line: 4, severity: "high", text: "edited", inline: true, edited: true })], v);
    expect(v.findings.map((x) => x.id)).toEqual(["a", "b", "c"]); // the order does not change
    expect(v.findings[0]).toMatchObject({ text: "edited", edited: true, dismissed: false });
    expect(v.findings[1]).toMatchObject({ dismissed: true });

    // An event without the optional fields (Phase 1 shape) counts as inline, kept and not edited.
    const old = run([e({ type: "review_finding", id: "z", path: "a.js", line: 1, severity: "low", text: "t" })]);
    expect(old.findings[0]).toMatchObject({ inline: true, dismissed: false, edited: false });
  });

  it("review_posted card ends the review", () => {
    const e = script();
    const url = "https://github.com/TseHang/andrun-demo/pull/14#pullrequestreview-101";
    const v = run([
      ...gate(e),
      e({ type: "review_posted", url, verdict: "REQUEST_CHANGES" }),
      e({ type: "approval_resolved", approvalId: "a1", approved: true }),
      e({ type: "status", status: "done" }),
    ]);
    expect(kinds(v)).toEqual(["review_posted"]); // no "Approved" marker: the card says what happened
    expect(v.items[0]).toMatchObject({ kind: "review_posted", url, verdict: "REQUEST_CHANGES" });
    expect(v.posted).toEqual({ url, verdict: "REQUEST_CHANGES" });
    expect(v.gate).toBeNull();
    expect(initialView().posted).toBeNull();
  });

  it("a GitHub error ends sending and keeps the gate", () => {
    const e = script();
    let v = markSending(run(gate(e)));
    v = run([e({ type: "error", source: "github", message: "GitHub answered 502: Bad Gateway", next: "Approve again to retry." })], v);
    expect(v.sending).toBe(false);
    expect(v.gate).toMatchObject({ approvalId: "a1" });
    expect(v.items.at(-1)).toMatchObject({ kind: "failure", source: "github", title: "GitHub error", message: "GitHub answered 502: Bad Gateway", next: "Approve again to retry." });
    expect(v.status).toBe("awaiting_approval");
  });
});

describe("Harness improvement: plan, turn limit, cost", () => {
  const PLAN_1: PlanStep[] = [
    { step: "Read the code", status: "in_progress" },
    { step: "Fix the loop bound", status: "pending" },
    { step: "Run the tests", status: "pending" },
  ];
  const PLAN_2: PlanStep[] = [
    { step: "Read the code", status: "completed" },
    { step: "Fix the loop bound", status: "completed" },
    { step: "Run the tests", status: "in_progress" },
  ];
  const planCall = (e: ReturnType<typeof script>, callId: string, plan: PlanStep[], step: number) => [
    e({ type: "tool_call", callId, name: "update_plan", args: { plan }, summary: "Update plan" }, { step }),
    e({ type: "tool_output", callId, stream: "result", chunk: "Plan updated" }, { step }),
    e({ type: "plan_updated", plan }, { step }),
  ];

  it("plan_updated replaces the plan and adds no timeline row", () => {
    const e = script();
    const frames = [
      e({ type: "status", status: "running" }),
      ...planCall(e, "p1", PLAN_1, 1),
      e({ type: "tool_call", callId: "c1", name: "read_file", args: { path: "src/sum.js" }, summary: "Read src/sum.js" }, { step: 2 }),
      e({ type: "tool_output", callId: "c1", stream: "result", chunk: "export function sum" }, { step: 2 }),
      ...planCall(e, "p2", PLAN_2, 3),
    ];

    // Live, frame by frame.
    const afterFirst = run(frames.slice(0, 4));
    expect(afterFirst.plan).toEqual(PLAN_1);
    const live = run(frames.slice(4), afterFirst);
    expect(live.plan).toEqual(PLAN_2);
    expect(rows(live).map((r) => r.name)).toEqual(["read_file"]);
    expect(kinds(live)).toEqual(["steps"]);
    expect(live.header.step).toBe(3);

    // A replay of the stored log gives the same view.
    expect(run(frames)).toEqual(live);

    // No plan yet.
    expect(initialView().plan).toBeNull();
    expect(run(frames.slice(0, 1)).plan).toBeNull();
  });

  it("an empty plan clears the card", () => {
    const e = script();
    const v = run([...planCall(e, "p1", PLAN_1, 1), ...planCall(e, "p2", [], 2)]);
    expect(v.plan).toBeNull();
    expect(rows(v)).toEqual([]);
  });

  it("the gate note counts unfinished steps of the latest plan", () => {
    expect(planNote(null)).toBeNull();
    expect(planNote([])).toBeNull();
    expect(planNote(PLAN_1)).toBe("3 of 3 plan steps not completed");
    expect(planNote(PLAN_2)).toBe("1 of 3 plan steps not completed");
    expect(planNote([{ step: "Only step", status: "pending" }])).toBe("1 of 1 plan step not completed");
    expect(planNote(PLAN_2.map((s) => ({ ...s, status: "completed" as const })))).toBeNull();

    // A follow-up turn's plan replaces the first turn's.
    const e = script();
    const next: PlanStep[] = [{ step: "Add the empty array test", status: "completed" }];
    const v = run([
      ...planCall(e, "p1", PLAN_2, 1),
      e({ type: "approval_required", approvalId: "a1", tool: "finish", reason: "finishing requires approval", summary: "Fixed." }, { step: 2 }),
      e({ type: "approval_resolved", approvalId: "a1", approved: true }, { step: 2 }),
      e({ type: "status", status: "done" }, { step: 2 }),
      e({ type: "message", id: "u2", role: "user", text: "also add a test" }, { step: 2 }),
      e({ type: "status", status: "running" }, { step: 2 }),
      ...planCall(e, "p2", next, 3),
    ]);
    expect(v.plan).toEqual(next);
    expect(planNote(v.plan)).toBeNull();
  });

  it("the composer stays enabled after the turn limit", () => {
    const e = script();
    const usage = (cost: number, step: number) =>
      e({ type: "usage", model: "deepseek-ai/deepseek-v4-flash", tokens_in: 1000, tokens_out: 10, latency_ms: 5, cost, context_tokens: 1000, context_window: 1_000_000 }, { step });
    const v = run([
      e({ type: "status", status: "running" }),
      usage(30, 1),
      usage(24, 2),
      e({ type: "error", source: "budget", message: "This turn reached its ¥50 safety limit", next: "Send a message to continue." }, { step: 2 }),
      e({ type: "status", status: "budget_exceeded" }, { step: 2 }),
    ]);
    expect(v.status).toBe("budget_exceeded");
    expect(v.composerEnabled).toBe(true);
    expect(v.header).toMatchObject({ step: 2, cost: 54 }); // the session's total, not the turn's
    expect(v.items.at(-1)).toMatchObject({ kind: "failure", title: "Limit reached", message: "This turn reached its ¥50 safety limit", next: "Send a message to continue." });

    // The next turn adds to the total.
    const more = run([e({ type: "message", id: "u2", role: "user", text: "continue" }, { step: 2 }), e({ type: "status", status: "running" }, { step: 2 }), usage(6, 3)], v);
    expect(more.header).toMatchObject({ step: 3, cost: 60 });
    expect(more.composerEnabled).toBe(true);
  });
});

describe("Conversational flow: questions and waiting", () => {
  const QUESTION = { question: "Which game?", options: [{ label: "Mental math", description: "Uses sum()" }, { label: "Guess the number" }] };
  const usage = (e: ReturnType<typeof script>, step: number) =>
    e({ type: "usage", model: "deepseek-ai/deepseek-v4-flash", tokens_in: 1000, tokens_out: 10, latency_ms: 5, context_tokens: 1000, context_window: 1_000_000 }, { step });

  it("a question opens a card and the answer closes it", () => {
    const e = script();
    const asked = [
      e({ type: "status", status: "running" }),
      usage(e, 1),
      e({ type: "tool_call", callId: "q1", name: "ask_user", args: QUESTION, summary: "Ask Which game?" }, { step: 1 }),
      e({ type: "question", id: "a1", ...QUESTION }, { step: 1 }),
      e({ type: "status", status: "awaiting_input" }, { step: 1 }),
    ];
    const open = run(asked);
    expect(open.status).toBe("awaiting_input");
    expect(open.question).toEqual({ id: "a1", ...QUESTION });
    expect(open.gate).toBeNull();
    // The question is part of the conversation; the tool call is not a step row.
    expect(rows(open)).toEqual([]);
    expect(open.items).toMatchObject([{ kind: "question", question: "Which game?" }]);
    expect(initialView().question).toBeNull();

    const answered = run(
      [
        e({ type: "message", id: "u1", role: "user", text: "Mental math" }, { step: 1 }),
        e({ type: "status", status: "running" }, { step: 1 }),
        e({ type: "tool_output", callId: "q1", stream: "result", chunk: '{"answer":"Mental math"}' }, { step: 1 }),
      ],
      open,
    );
    expect(answered.question).toBeNull();
    expect(answered.status).toBe("running");
    expect(kinds(answered)).toEqual(["question", "user"]);
    expect(rows(answered)).toEqual([]);

    // A second question replaces the first; a replay of the whole log gives the same view.
    const second = e({ type: "question", id: "a2", question: "How hard?", options: [{ label: "Easy" }, { label: "Hard" }] }, { step: 1 });
    const again = reduce(answered, second);
    expect(again.question).toMatchObject({ id: "a2", question: "How hard?" });
    expect(run([...asked.slice(0, 5)])).toEqual(open);
  });

  it("an empty reply shows a notice", () => {
    const e = script();
    const empty = run([e({ type: "status", status: "running" }), usage(e, 1), e({ type: "status", status: "awaiting_input" }, { step: 1 })]);
    expect(empty.items).toMatchObject([{ kind: "notice", title: "The agent stopped without a reply." }]);

    // A reply with text, or a question, is its own explanation.
    const f = script();
    const replied = run([
      f({ type: "status", status: "running" }),
      usage(f, 1),
      f({ type: "message", id: "m1", role: "assistant", text: "Which one?" }, { step: 1 }),
      f({ type: "status", status: "awaiting_input" }, { step: 1 }),
    ]);
    expect(kinds(replied)).toEqual(["assistant"]);
    const g = script();
    const asked = run([
      g({ type: "status", status: "running" }),
      usage(g, 1),
      g({ type: "question", id: "a1", ...QUESTION }, { step: 1 }),
      g({ type: "status", status: "awaiting_input" }, { step: 1 }),
    ]);
    expect(kinds(asked)).toEqual(["question"]);
  });
});

describe("Session UI: a stopped run (UI-a)", () => {
  it("stopped closes open rows and adds a notice", () => {
    const ev = script();
    const running = run([
      ev({ type: "status", status: "running" }),
      ev({ type: "message", id: "u1", role: "user", text: "go" }),
      ev({ type: "tool_call", callId: "c1", name: "run_command", args: { command: "npm test" }, summary: "Run npm test" }, { step: 1 }),
      ev({ type: "message_delta", id: "m2", text: "Let me" }, { step: 2 }),
    ]);
    expect(rows(running)[0]!.done).toBe(false);
    expect(running.items.some((i) => i.kind === "assistant" && i.streaming)).toBe(true);

    const v = run([ev({ type: "stopped" }), ev({ type: "status", status: "awaiting_input" })], running);
    expect(v.status).toBe("awaiting_input");
    expect(rows(v)[0]).toMatchObject({ done: true, expanded: false });
    // Deltas are not persisted: the half-written reply goes, so a replay shows the same timeline.
    expect(v.items.some((i) => i.kind === "assistant")).toBe(false);
    expect(v.items.at(-1)).toMatchObject({ kind: "notice", title: "Stopped", message: "Changes so far are kept. Send a message to continue." });
    // One notice only: not also "The agent stopped without a reply."
    expect(v.items.filter((i) => i.kind === "notice")).toHaveLength(1);
    expect(activityLabel(v)).toBeNull();

    // A command the stop cut off reads "stopped", not "timed out" or "failed".
    const cut = run(
      [
        ev({ type: "tool_output", callId: "c1", stream: "result", chunk: "stopped by the user", exitCode: null }),
        ev({ type: "error", source: "tool", message: "stopped by the user" }),
        ev({ type: "stopped" }),
        ev({ type: "status", status: "awaiting_input" }),
      ],
      running,
    );
    expect(rowSummary(rows(cut)[0]!)).toMatch(/^stopped · /);
    expect(rowTone(rows(cut)[0]!)).toBe("muted");
    expect(cut.lastCommand).toBeNull();

    // The persisted log (no deltas) replays to the same timeline.
    const replay = script();
    const replayed = run([
      replay({ type: "status", status: "running" }),
      replay({ type: "message", id: "u1", role: "user", text: "go" }),
      replay({ type: "tool_call", callId: "c1", name: "run_command", args: { command: "npm test" }, summary: "Run npm test" }, { step: 1 }),
      replay({ type: "stopped" }),
      replay({ type: "status", status: "awaiting_input" }),
    ]);
    expect(kinds(replayed)).toEqual(kinds(v));
    expect(kinds(v)).toEqual(["user", "steps", "notice"]);
  });
});
