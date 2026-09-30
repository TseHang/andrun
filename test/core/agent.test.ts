import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalSandbox } from "../../eval/local-sandbox";
import { createSession, resume, runAgent } from "../../src/core/agent";
import { defaultConfig, type AgentConfig } from "../../src/core/config";
import type { AgentEvent } from "../../src/core/events";
import { getProfile } from "../../src/core/modes";
import type { AgentDeps, AgentState, ModelClient, SandboxAdapter } from "../../src/core/types";
import { MemorySandbox } from "../support/memory-sandbox";
import { ScriptedModelClient, call, type ScriptStep } from "../support/scripted-model";

const FIXTURE = join(import.meta.dirname, "../../eval/fixtures/sum-off-by-one");
const profile = getProfile("code", defaultConfig);

const FIX_PATCH = [
  "--- a/src/sum.js",
  "+++ b/src/sum.js",
  "@@ -1,6 +1,6 @@",
  " export function sum(values) {",
  "   let total = 0;",
  "-  for (let i = 0; i < values.length - 1; i++) {",
  "+  for (let i = 0; i < values.length; i++) {",
  "     total += values[i];",
  "   }",
  "   return total;",
  "",
].join("\n");

const HAPPY_SCRIPT = (): ScriptStep[] => [
  { text: "Running the tests first.", calls: [{ name: "list_files", args: {} }] },
  call("run_command", { command: "npm test" }),
  call("read_file", { path: "src/sum.js" }),
  call("apply_patch", { patch: FIX_PATCH }),
  call("run_command", { command: "npm test" }),
  call("finish", { summary: "Fixed the loop bound in sum()." }),
];

const local: LocalSandbox[] = [];
afterEach(async () => {
  await Promise.all(local.splice(0).map((s) => s.destroy()));
});
async function fixtureSandbox() {
  const s = await LocalSandbox.fromFixture(FIXTURE);
  local.push(s);
  return s;
}

function harness(model: ModelClient, sandbox: SandboxAdapter | null, extra: Partial<AgentDeps> = {}, config: AgentConfig = defaultConfig) {
  const events: AgentEvent[] = [];
  const deps: AgentDeps = { model, sandbox, emit: (e) => events.push(e), config, ...extra };
  return { events, deps };
}

const start = (mode: "code" | "review" = "code") =>
  createSession({ sessionId: "sess-1", mode, task: "Make the failing test pass." }, getProfile(mode, defaultConfig));

const roundTrip = (s: AgentState): AgentState => JSON.parse(JSON.stringify(s));

const indexOf = (events: AgentEvent[], pred: (e: AgentEvent) => boolean) => events.findIndex(pred);

describe("S1: happy path reaches the approval gate", () => {
  it("code run reaches approval gate with ordered events", async () => {
    const sandbox = await fixtureSandbox();
    const { events, deps } = harness(new ScriptedModelClient(HAPPY_SCRIPT()), sandbox);
    const { outcome } = await runAgent(start(), profile, deps);

    expect(outcome.kind).toBe("awaiting_approval");
    if (outcome.kind !== "awaiting_approval" || outcome.pending.kind !== "tool") throw new Error("wrong outcome");
    expect(outcome.pending.call.function.name).toBe("finish");
    expect(outcome.pending.summary).toBe("Fixed the loop bound in sum().");
    expect(outcome.pending.diffSummary).toEqual({ files: [{ path: "src/sum.js", additions: 1, deletions: 1 }] });

    expect(events[0]).toMatchObject({ type: "status", status: "running" });
    for (let i = 1; i < events.length; i++) expect(events[i]!.seq).toBeGreaterThan(events[i - 1]!.seq);
    for (const e of events) expect(e.sessionId).toBe("sess-1");

    const runCalls = events.filter((e) => e.type === "tool_call" && e.name === "run_command");
    expect(runCalls).toHaveLength(2);
    const exitOf = (callId: string) =>
      events.find((e) => e.type === "tool_output" && e.callId === callId && e.exitCode !== undefined);
    const firstExit = exitOf((runCalls[0] as { callId: string }).callId);
    const secondExit = exitOf((runCalls[1] as { callId: string }).callId);
    expect(firstExit && firstExit.type === "tool_output" && firstExit.exitCode).not.toBe(0);
    expect(secondExit).toMatchObject({ exitCode: 0 });

    const iFirstFail = events.indexOf(firstExit!);
    const iChanged = indexOf(events, (e) => e.type === "file_changed" && e.path === "src/sum.js");
    const iSecondPass = events.indexOf(secondExit!);
    const iApproval = indexOf(events, (e) => e.type === "approval_required");
    expect(iFirstFail).toBeLessThan(iChanged);
    expect(iChanged).toBeLessThan(iSecondPass);
    expect(iSecondPass).toBeLessThan(iApproval);
    expect(events.at(-1)).toMatchObject({ type: "status", status: "awaiting_approval" });

    const changed = events[iChanged]!;
    expect(changed.type === "file_changed" && changed.diff).toContain("+  for (let i = 0; i < values.length; i++) {");

    expect(events.filter((e) => e.type === "usage")).toHaveLength(6);
    expect(events.find((e) => e.type === "message" && e.role === "assistant")).toMatchObject({
      text: "Running the tests first.",
    });
    expect(events.filter((e) => e.type === "message_delta").length).toBeGreaterThan(0);
    const toolCall = events.find((e) => e.type === "tool_call" && e.name === "read_file");
    expect(toolCall).toMatchObject({ summary: "Read src/sum.js" });
  });
});

describe("S2: approve and reject resume the same loop", () => {
  it("resume after approve finishes; reject feeds comment and loops back to gate", async () => {
    const sandbox = await fixtureSandbox();
    const first = harness(new ScriptedModelClient(HAPPY_SCRIPT()), sandbox);
    const { state: paused } = await runAgent(start(), profile, first.deps);
    expect(paused.status).toBe("awaiting_approval");

    // Approve
    const approve = harness(new ScriptedModelClient([]), sandbox);
    const approved = await resume(roundTrip(paused), { approved: true }, profile, approve.deps);
    expect(approved.outcome).toEqual({ kind: "finished", summary: "Fixed the loop bound in sum()." });
    expect(approve.events[0]).toMatchObject({ type: "approval_resolved", approved: true });
    expect(approve.events.at(-1)).toMatchObject({ type: "status", status: "done" });
    expect(approve.events[0]!.seq).toBeGreaterThan(first.events.at(-1)!.seq);

    // Reject with a comment
    const comment = "also add a test for the empty array case";
    const model = new ScriptedModelClient([
      call("write_file", { path: "test/empty.test.js", content: "// empty case\n" }),
      call("finish", { summary: "Added the empty case test." }),
    ]);
    const reject = harness(model, sandbox);
    const rejected = await resume(roundTrip(paused), { approved: false, comment }, profile, reject.deps);
    expect(reject.events[0]).toMatchObject({ type: "approval_resolved", approved: false, comment });
    const lastMsg = model.requests[0]!.messages.at(-1)!;
    expect(lastMsg.role).toBe("tool");
    expect(lastMsg.role === "tool" && lastMsg.content).toContain(comment);
    expect(rejected.outcome.kind).toBe("awaiting_approval");
    expect(rejected.outcome.kind === "awaiting_approval" && rejected.outcome.pending.kind === "tool" && rejected.outcome.pending.summary).toBe(
      "Added the empty case test.",
    );
  });
});

describe("transcript stays valid for the next turn", () => {
  const unanswered = (s: AgentState) => {
    const answered = new Set(s.messages.flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : [])));
    return s.messages.flatMap((m) => (m.role === "assistant" ? (m.tool_calls ?? []) : [])).filter((c) => !answered.has(c.id));
  };

  it("every tool_call has a tool message after an approved finish", async () => {
    const { state: paused } = await runAgent(start(), profile, harness(new ScriptedModelClient([call("finish", { summary: "d" })]), new MemorySandbox()).deps);
    const { state } = await resume(roundTrip(paused), { approved: true }, profile, harness(new ScriptedModelClient([]), new MemorySandbox()).deps);
    expect(state.status).toBe("done");
    expect(unanswered(state)).toEqual([]);
  });

  it("every tool_call has a tool message when an auto-approved finish ends a multi-call turn", async () => {
    const turn = { calls: [{ name: "finish", args: { summary: "d" } }, { name: "list_files", args: {} }] };
    const reviewProfile = getProfile("review", defaultConfig);
    const { state } = await runAgent(start("review"), reviewProfile, harness(new ScriptedModelClient([turn]), new MemorySandbox()).deps);
    expect(state.status).toBe("done");
    expect(unanswered(state)).toEqual([]);
  });

  it("a sandbox failure mid-turn fails the run visibly and leaves no call unanswered", async () => {
    class BrokenDiff extends MemorySandbox {
      override async diff(): Promise<string> {
        throw new Error("sandbox gone");
      }
    }
    const turn = { calls: [{ name: "write_file", args: { path: "a.js", content: "x" } }, { name: "list_files", args: {} }] };
    const { events, deps } = harness(new ScriptedModelClient([turn]), new BrokenDiff());
    const { state, outcome } = await runAgent(start(), profile, deps);
    expect(outcome).toMatchObject({ kind: "failed" });
    expect(events).toContainEqual(expect.objectContaining({ type: "error", source: "sandbox", message: expect.stringContaining("sandbox gone") }));
    expect(events.at(-1)).toMatchObject({ type: "status", status: "failed" });
    expect(unanswered(state)).toEqual([]);
    expect(state.pending).toBeNull();
  });

  it("a sandbox failure while pausing does not leave a pending approval", async () => {
    class BrokenDiff extends MemorySandbox {
      override async diff(): Promise<string> {
        throw new Error("sandbox gone");
      }
    }
    const { deps } = harness(new ScriptedModelClient([call("finish", { summary: "d" })]), new BrokenDiff());
    const { state, outcome } = await runAgent(start(), profile, deps);
    expect(outcome.kind).toBe("failed");
    expect(state.pending).toBeNull();
    expect(unanswered(state)).toEqual([]);
  });
});

describe("S3: gated commands", () => {
  it("gated command is not executed before approval", async () => {
    const sandbox = new MemorySandbox({ "src/a.js": "x" });
    const { deps } = harness(new ScriptedModelClient([call("run_command", { command: "rm -rf src" })]), sandbox);
    const { outcome, state } = await runAgent(start(), profile, deps);
    expect(outcome.kind).toBe("awaiting_approval");
    expect(outcome.kind === "awaiting_approval" && outcome.pending.reason).toContain("rm");
    expect(sandbox.commands).toEqual([]);

    const after = harness(new ScriptedModelClient([call("finish", { summary: "done" })]), sandbox);
    const resumed = await resume(roundTrip(state), { approved: true }, profile, after.deps);
    expect(sandbox.commands).toEqual(["rm -rf src"]);
    expect(resumed.outcome.kind).toBe("awaiting_approval"); // back at the finish gate
  });

  it("runs the remaining tool calls of a turn after the gated one resolves", async () => {
    const sandbox = new MemorySandbox({ "a.js": "x" });
    const turn = { calls: [{ name: "run_command", args: { command: "rm a.js" } }, { name: "run_command", args: { command: "npm test" } }] };
    const { deps } = harness(new ScriptedModelClient([turn]), sandbox);
    const { state } = await runAgent(start(), profile, deps);
    expect(sandbox.commands).toEqual([]);
    const after = harness(new ScriptedModelClient([call("finish", { summary: "d" })]), sandbox);
    await resume(roundTrip(state), { approved: true }, profile, after.deps);
    expect(sandbox.commands).toEqual(["rm a.js", "npm test"]);
  });
});

describe("S5: budgets stop the loop visibly", () => {
  it("step cap stops with budget_exceeded", async () => {
    const model = new ScriptedModelClient(Array.from({ length: 5 }, () => call("list_files")));
    const { events, deps } = harness(model, new MemorySandbox({ "a.js": "" }), {}, { ...defaultConfig, maxSteps: 3 });
    const { outcome } = await runAgent(start(), profile, deps);
    expect(outcome).toEqual({ kind: "budget_exceeded" });
    expect(model.requests).toHaveLength(3);
    expect(events.find((e) => e.type === "error")).toMatchObject({ source: "budget" });
    expect(events.at(-1)).toMatchObject({ type: "status", status: "budget_exceeded" });
  });

  it("token cap stops with budget_exceeded", async () => {
    const model = new ScriptedModelClient(Array.from({ length: 5 }, () => call("list_files", {}, { in: 500, out: 100 })));
    const { events, deps } = harness(model, new MemorySandbox({ "a.js": "" }), {}, { ...defaultConfig, maxTokens: 1000 });
    const { outcome } = await runAgent(start(), profile, deps);
    expect(outcome).toEqual({ kind: "budget_exceeded" });
    expect(model.requests).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: "status", status: "budget_exceeded" });
  });
});

describe("S6: tool errors return to the model; 3 strikes asks the user", () => {
  it("tool errors fed back; 3 consecutive failures ask user", async () => {
    const model = new ScriptedModelClient([
      call("read_file", { path: "missing.js" }),
      call("read_file", { path: "missing.js" }),
      call("read_file", { path: "missing.js" }),
    ]);
    const { events, deps } = harness(model, new MemorySandbox());
    const { outcome } = await runAgent(start(), profile, deps);

    const toolMsgs = model.requests.map((r) => r.messages.at(-1)!).filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(2);
    for (const m of toolMsgs) expect(m.role === "tool" && m.content).toContain("ENOENT");
    expect(events.filter((e) => e.type === "error" && e.source === "tool").length).toBeGreaterThanOrEqual(2);

    expect(outcome.kind).toBe("awaiting_approval");
    if (outcome.kind !== "awaiting_approval") throw new Error();
    expect(outcome.pending.kind).toBe("strikes");
    expect(outcome.pending.reason).toBe("read_file failed 3 times");
  });

  it("a success in between resets the counter", async () => {
    const model = new ScriptedModelClient([
      call("read_file", { path: "missing.js" }),
      call("read_file", { path: "missing.js" }),
      call("read_file", { path: "a.js" }),
      call("read_file", { path: "missing.js" }),
      call("read_file", { path: "missing.js" }),
      call("finish", { summary: "done" }),
    ]);
    const { deps } = harness(model, new MemorySandbox({ "a.js": "x" }));
    const { outcome } = await runAgent(start(), profile, deps);
    expect(outcome.kind === "awaiting_approval" && outcome.pending.kind).toBe("tool");
  });

  it("malformed tool args are fed back", async () => {
    const bad = { calls: [{ name: "read_file", args: "{not json" }] };
    const model = new ScriptedModelClient([bad, bad, bad]);
    const { deps } = harness(model, new MemorySandbox());
    const { outcome } = await runAgent(start(), profile, deps);
    const fed = model.requests[1]!.messages.at(-1)!;
    expect(fed.role === "tool" && fed.content).toContain("invalid arguments");
    expect(outcome.kind === "awaiting_approval" && outcome.pending.kind).toBe("strikes");
  });

  it("approving a strikes pause lets the agent continue", async () => {
    const fail = call("read_file", { path: "missing.js" });
    const { state } = await runAgent(start(), profile, harness(new ScriptedModelClient([fail, fail, fail]), new MemorySandbox()).deps);
    const model = new ScriptedModelClient([call("finish", { summary: "gave up" })]);
    const r = await resume(roundTrip(state), { approved: true }, profile, harness(model, new MemorySandbox()).deps);
    expect(r.outcome.kind === "awaiting_approval" && r.outcome.pending.kind).toBe("tool");
    expect(r.state.failures).toBeNull();
  });
});

describe("S10: checkpoint every step, resumable from any step", () => {
  const script = (): ScriptStep[] => [
    call("list_files"),
    call("read_file", { path: "src/a.js" }),
    call("write_file", { path: "src/a.js", content: "fixed\n" }),
    call("run_command", { command: "npm test" }),
    call("read_file", { path: "src/a.js" }),
    call("finish", { summary: "All good." }),
  ];

  it("resume from any checkpoint yields same outcome", async () => {
    const base = new MemorySandbox({ "src/a.js": "broken\n", "test/a.test.js": "t\n" });
    const checkpoints: { state: AgentState; files: Map<string, string> }[] = [];
    let live = base.clone();
    const full = await runAgent(start(), profile, {
      ...harness(new ScriptedModelClient(script()), live).deps,
      checkpoint: (s) => checkpoints.push({ state: s, files: new Map(live.files) }),
    });
    expect(checkpoints).toHaveLength(6);
    expect(checkpoints.map((c) => c.state.step)).toEqual([1, 2, 3, 4, 5, 6]);
    const fullDiff = await live.diff();

    for (const cp of checkpoints.slice(0, 5)) {
      live = new MemorySandbox(cp.files, undefined, base.baseline);
      const r = await runAgent(roundTrip(cp.state), profile, harness(new ScriptedModelClient(script().slice(cp.state.step)), live).deps);
      expect(r.outcome.kind).toBe(full.outcome.kind);
      expect(r.outcome.kind === "awaiting_approval" && r.outcome.pending.kind === "tool" && r.outcome.pending.summary).toBe("All good.");
      expect(await live.diff()).toBe(fullDiff);
    }
  });
});

describe("loop edge cases", () => {
  it("text-only turn nudges then gates", async () => {
    const model = new ScriptedModelClient([{ text: "I think it is fixed." }, { text: "Yes, it is done." }]);
    const { events, deps } = harness(model, new MemorySandbox());
    const { outcome } = await runAgent(start(), profile, deps);
    const nudge = model.requests[1]!.messages.at(-1)!;
    expect(nudge.role).toBe("user");
    expect(nudge.role === "user" && nudge.content).toContain("call a tool or finish");
    expect(outcome.kind === "awaiting_approval" && outcome.pending.kind).toBe("implicit_finish");
    expect(events.filter((e) => e.type === "message" && e.role === "assistant")).toHaveLength(2);
  });

  it("drained user message injected before next model call", async () => {
    let queue = ["Use tabs, not spaces."];
    const model = new ScriptedModelClient([call("list_files"), call("finish", { summary: "d" })]);
    const { events, deps } = harness(model, new MemorySandbox({ "a.js": "" }), {
      drainUserMessages: () => {
        const q = queue;
        queue = [];
        return q;
      },
    });
    await runAgent(start(), profile, deps);
    const userMsgs = model.requests[1]!.messages.filter((m) => m.role === "user").map((m) => m.content);
    expect(userMsgs).toContain("Use tabs, not spaces.");
    expect(events.find((e) => e.type === "message" && e.role === "user")).toMatchObject({ text: "Use tabs, not spaces." });
    expect(model.requests[0]!.messages.filter((m) => m.role === "user")).toHaveLength(2); // task + drained before 1st call
  });

  it("abort stops loop visibly", async () => {
    const ctrl = new AbortController();
    const model = new ScriptedModelClient(Array.from({ length: 5 }, () => call("list_files")));
    const { events, deps } = harness(model, new MemorySandbox({ "a.js": "" }), {
      signal: ctrl.signal,
      checkpoint: () => ctrl.abort("sandbox destroyed"),
    });
    const { outcome } = await runAgent(start(), profile, deps);
    expect(outcome.kind).toBe("failed");
    expect(model.requests).toHaveLength(1);
    const err = events.find((e) => e.type === "error");
    expect(err && err.type === "error" && ["sandbox", "model"]).toContain(err && err.type === "error" && err.source);
    expect(err && err.type === "error" && err.message).toContain("sandbox destroyed");
    expect(events.at(-1)).toMatchObject({ type: "status", status: "failed" });
  });

  it("a run_command timeout is a visible tool error", async () => {
    const sandbox = new MemorySandbox({}, () => ({ exitCode: null, timedOut: true }));
    const model = new ScriptedModelClient([call("run_command", { command: "npm test" }), call("finish", { summary: "d" })]);
    const { events, deps } = harness(model, sandbox);
    await runAgent(start(), profile, deps);
    expect(events.find((e) => e.type === "tool_output" && e.exitCode !== undefined)).toMatchObject({ exitCode: null });
    const fed = model.requests[1]!.messages.at(-1)!;
    expect(fed.role === "tool" && fed.content).toMatch(/timed out/);
  });

  it("createSession seeds system prompt and task", () => {
    const s = start();
    expect(s).toMatchObject({ sessionId: "sess-1", mode: "code", status: "idle", step: 0, tokensUsed: 0, pending: null });
    expect(s.messages[0]).toMatchObject({ role: "system" });
    expect(s.messages[0]!.role === "system" && s.messages[0]!.content).toMatch(/test/i);
    expect(s.messages[1]).toEqual({ role: "user", content: "Make the failing test pass." });
  });
});
