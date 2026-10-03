import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent, EventBody } from "../../src/core/events";
import { RESTORED_NOTE, type ServerFrame } from "../../src/session/protocol";
import { rowSummary, rowTone } from "../../web/src/state/format";
import { addPending, initialView, markSending, reduce, type SessionView, type StepRow } from "../../web/src/state/reducer";

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
    expect(rowSummary(cmd!)).toBe("exit 1 · 1.1 s");
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
    expect(approved.items.at(-1)).toMatchObject({ kind: "approved" });

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
    expect(budget.composerEnabled).toBe(false);
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
        e({ type: "pr_opened", url: "https://github.com/x/y/pull/1" }),
        e({ type: "review_finding", id: "f1", path: "a.js", line: 1, severity: "low", text: "nit" }),
        e({ type: "review_posted", url: "https://github.com/x/y/pull/1", verdict: "COMMENT" }),
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
