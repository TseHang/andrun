import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalSandbox } from "../../eval/local-sandbox";
import { createSession, resume, runAgent } from "../../src/core/agent";
import { defaultConfig, type AgentConfig } from "../../src/core/config";
import type { AgentEvent } from "../../src/core/events";
import { getProfile } from "../../src/core/modes";
import { autoApprove } from "../../src/core/policy";
import type { AgentDeps, AgentState, Decision, ModelClient, PolicyInput, SandboxAdapter } from "../../src/core/types";
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
    // Since P4-b a review's finish asks, so the auto-approving policy of the eval is what lets it through.
    const deps = { ...harness(new ScriptedModelClient([turn]), new MemorySandbox()).deps, policy: autoApprove(reviewProfile.policy) };
    const { state } = await runAgent(start("review"), reviewProfile, deps);
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

describe("S3: gated tool calls", () => {
  // HI-j: Code mode asks for no command, so these use a policy that asks before `rm`.
  const askBeforeRm = {
    decide: (input: PolicyInput): Decision => {
      const command = typeof input.args.command === "string" ? input.args.command : "";
      return input.tool === "run_command" && command.startsWith("rm") ? { kind: "ask", reason: "rm needs approval" } : profile.policy.decide(input);
    },
  };

  it("gated command is not executed before approval", async () => {
    const sandbox = new MemorySandbox({ "src/a.js": "x" });
    const { deps } = harness(new ScriptedModelClient([call("run_command", { command: "rm -rf src" })]), sandbox, { policy: askBeforeRm });
    const { outcome, state } = await runAgent(start(), profile, deps);
    expect(outcome.kind).toBe("awaiting_approval");
    expect(outcome.kind === "awaiting_approval" && outcome.pending.reason).toContain("rm");
    expect(sandbox.commands).toEqual([]);

    const after = harness(new ScriptedModelClient([call("finish", { summary: "done" })]), sandbox, { policy: askBeforeRm });
    const resumed = await resume(roundTrip(state), { approved: true }, profile, after.deps);
    expect(sandbox.commands).toEqual(["rm -rf src"]);
    expect(resumed.outcome.kind).toBe("awaiting_approval"); // back at the finish gate
  });

  it("runs the remaining tool calls of a turn after the gated one resolves", async () => {
    const sandbox = new MemorySandbox({ "a.js": "x" });
    const turn = { calls: [{ name: "run_command", args: { command: "rm a.js" } }, { name: "run_command", args: { command: "npm test" } }] };
    const { deps } = harness(new ScriptedModelClient([turn]), sandbox, { policy: askBeforeRm });
    const { state } = await runAgent(start(), profile, deps);
    expect(sandbox.commands).toEqual([]);
    const after = harness(new ScriptedModelClient([call("finish", { summary: "d" })]), sandbox, { policy: askBeforeRm });
    await resume(roundTrip(state), { approved: true }, profile, after.deps);
    expect(sandbox.commands).toEqual(["rm a.js", "npm test"]);
  });

  it("a Code run asks for no command, only for finish (HI-j)", async () => {
    const sandbox = new MemorySandbox({ "src/a.js": "x" });
    const model = new ScriptedModelClient([call("run_command", { command: "rm -rf src" }), call("run_command", { command: "mkdir -p site && node build.js" }), call("finish", { summary: "d" })]);
    const { events, deps } = harness(model, sandbox);
    const { outcome } = await runAgent(start(), profile, deps);
    expect(sandbox.commands).toEqual(["rm -rf src", "mkdir -p site && node build.js"]);
    expect(events.filter((e) => e.type === "approval_required")).toMatchObject([{ tool: "finish" }]);
    expect(outcome.kind).toBe("awaiting_approval");
  });
});

describe("S5: one safety limit per turn, in money (HI-h)", () => {
  // ¥6 per million input tokens, so a call that reports 1,000,000 input tokens costs ¥6.
  const PRICED: AgentConfig = { ...defaultConfig, models: { ...defaultConfig.models, code: "priced" }, prices: { priced: { in: 6, out: 0 } }, maxTurnCost: 50 };
  const pricedProfile = getProfile("code", PRICED);
  const sixYen = { in: 1_000_000, out: 0 };
  const listing = (n: number, usage = sixYen) => Array.from({ length: n }, () => call("list_files", {}, usage));
  const budgetError = (events: AgentEvent[]) => events.find((e): e is Extract<AgentEvent, { type: "error" }> => e.type === "error" && e.source === "budget");

  it("a turn stops at its cost limit, not at a step count", async () => {
    expect(defaultConfig.maxSteps).toBeUndefined();
    expect(defaultConfig).toMatchObject({ maxTurnCost: 50, maxTurnTokens: 4_000_000, costNotice: 10 });
    expect(defaultConfig).not.toHaveProperty("maxTokens");

    const model = new ScriptedModelClient(listing(20));
    const { events, deps } = harness(model, new MemorySandbox({ "a.js": "" }), {}, PRICED);
    const { outcome, state } = await runAgent(start(), pricedProfile, deps);

    // 8 calls are ¥48; the 9th brings the turn to ¥54 and is the last one.
    expect(outcome).toEqual({ kind: "budget_exceeded" });
    expect(model.requests).toHaveLength(9);
    expect(state.step).toBe(9);
    expect(state.turnCost).toBeCloseTo(54);
    expect(budgetError(events)).toMatchObject({ message: "This turn reached its ¥50 safety limit", next: "Send a message to continue." });
    expect(events.at(-1)).toMatchObject({ type: "status", status: "budget_exceeded" });

    // An eval case still sets a step limit.
    const capped = new ScriptedModelClient(listing(5, { in: 100, out: 20 }));
    const eval_ = harness(capped, new MemorySandbox({ "a.js": "" }), {}, { ...PRICED, maxSteps: 3 });
    expect((await runAgent(start(), pricedProfile, eval_.deps)).outcome).toEqual({ kind: "budget_exceeded" });
    expect(capped.requests).toHaveLength(3);
    expect(budgetError(eval_.events)).toMatchObject({ message: "step limit reached (3)" });
    expect(eval_.events.at(-1)).toMatchObject({ type: "status", status: "budget_exceeded" });
  });

  it("a gate keeps the turn's cost; an unpriced model falls back to a token limit", async () => {
    // (a) ¥45 spent, then the run waits at the finish gate.
    const sandbox = new MemorySandbox({ "a.js": "" });
    const first = harness(new ScriptedModelClient([call("finish", { summary: "d" }, { in: 7_500_000, out: 0 })]), sandbox, {}, PRICED);
    const { state: paused, outcome: gate } = await runAgent(start(), pricedProfile, first.deps);
    expect(gate.kind).toBe("awaiting_approval");
    expect(paused.turnCost).toBeCloseTo(45);

    // Reject + comment continues the same turn: one ¥6 call reaches ¥51.
    const model = new ScriptedModelClient(listing(5));
    const second = harness(model, sandbox, {}, PRICED);
    const rejected = await resume(roundTrip(paused), { approved: false, comment: "one more thing" }, pricedProfile, second.deps);
    expect(rejected.outcome).toEqual({ kind: "budget_exceeded" });
    expect(model.requests).toHaveLength(1);
    expect(rejected.state.turnCost).toBeCloseTo(51);
    expect(budgetError(second.events)).toMatchObject({ message: "This turn reached its ¥50 safety limit" });

    // (b) No price for the model: the turn is limited by tokens.
    const UNPRICED: AgentConfig = { ...defaultConfig, models: { ...defaultConfig.models, code: "unpriced" }, maxTurnTokens: 4_000_000 };
    const big = new ScriptedModelClient(listing(6, { in: 1_400_000, out: 100_000 }));
    const third = harness(big, new MemorySandbox({ "a.js": "" }), {}, UNPRICED);
    const unpriced = await runAgent(start(), getProfile("code", UNPRICED), third.deps);
    expect(unpriced.outcome).toEqual({ kind: "budget_exceeded" });
    expect(big.requests).toHaveLength(3); // 1.5M, 3M, 4.5M
    expect(unpriced.state.turnTokens).toBe(4_500_000);
    expect(unpriced.state.turnCost).toBe(0);
    expect(budgetError(third.events)).toMatchObject({ message: "This turn reached its 4,000,000 token safety limit", next: "Send a message to continue." });
  });
});

describe("HI-a, HI-b: the plan tool", () => {
  const PLAN = [
    { step: "Read the code", status: "in_progress" },
    { step: "Make the change", status: "pending" },
    { step: "Run the tests", status: "pending" },
  ];

  it("update_plan answers 'Plan updated' and emits plan_updated", async () => {
    const model = new ScriptedModelClient([call("update_plan", { plan: PLAN }), call("finish", { summary: "d" })]);
    const { events, deps } = harness(model, new MemorySandbox());
    const { state, outcome } = await runAgent(start(), profile, deps);

    expect(model.requests[0]!.tools.map((t) => t.name)).toContain("update_plan");
    expect(model.requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", content: "Plan updated" });

    const iCall = indexOf(events, (e) => e.type === "tool_call" && e.name === "update_plan");
    const iPlan = indexOf(events, (e) => e.type === "plan_updated");
    const iNextTurn = indexOf(events, (e) => e.type === "usage" && e.stepId === "s2");
    expect(iCall).toBeGreaterThanOrEqual(0);
    expect(iPlan).toBeGreaterThan(iCall);
    expect(iNextTurn).toBeGreaterThan(iPlan);
    expect(events[iPlan]).toMatchObject({ type: "plan_updated", plan: PLAN, stepId: "s1" });
    expect(events.filter((e) => e.type === "plan_updated")).toHaveLength(1);

    // The plan asks for no approval and is not a failure.
    expect(events.filter((e) => e.type === "approval_required")).toMatchObject([{ tool: "finish" }]);
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(outcome.kind).toBe("awaiting_approval");
    expect(state.failures).toBeNull();
    // The plan is not kept in the state: it lives in the assistant message (HI-b).
    expect(state).not.toHaveProperty("plan");
    const planCall = state.messages.find((m) => m.role === "assistant" && m.tool_calls?.[0]?.function.name === "update_plan");
    expect(planCall && planCall.role === "assistant" && JSON.parse(planCall.tool_calls![0]!.function.arguments)).toEqual({ plan: PLAN });
  });

  it("three malformed plans in a row pause the run, with no plan_updated", async () => {
    const bad = call("update_plan", { plan: [{ step: "x", status: "done" }] });
    const model = new ScriptedModelClient([bad, bad, bad]);
    const { events, deps } = harness(model, new MemorySandbox());
    const { outcome } = await runAgent(start(), profile, deps);
    const fed = model.requests[1]!.messages.at(-1)!;
    expect(fed.role === "tool" && fed.content).toContain("invalid arguments");
    expect(events.filter((e) => e.type === "plan_updated")).toEqual([]);
    expect(outcome.kind === "awaiting_approval" && outcome.pending.kind).toBe("strikes");
    expect(outcome.kind === "awaiting_approval" && outcome.pending.reason).toBe("update_plan failed 3 times");
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
    expect(s).toMatchObject({ sessionId: "sess-1", mode: "code", status: "idle", step: 0, tokensUsed: 0, turnCost: 0, turnTokens: 0, pending: null });
    expect(s.messages[0]).toMatchObject({ role: "system" });
    expect(s.messages[0]!.role === "system" && s.messages[0]!.content).toMatch(/test/i);
    expect(s.messages[1]).toEqual({ role: "user", content: "Make the failing test pass." });
  });
});

describe("S18 (Phase 3, P3-n): tool results carry their size and count", () => {
  it("read_file and list_files results carry their size and count", async () => {
    const big = "é".repeat(2500); // 2,500 characters, 5,000 bytes in UTF-8
    const sandbox = new MemorySandbox({ "big.txt": big, "a.js": "a", "lib/b.js": "b" });
    const model = new ScriptedModelClient([
      call("read_file", { path: "big.txt" }),
      call("list_files", {}),
      call("finish", { summary: "done" }),
    ]);
    const { events, deps } = harness(model, sandbox);
    await runAgent(start(), profile, deps);

    const callIdOf = (name: string) => events.find((e) => e.type === "tool_call" && e.name === name)!;
    const resultOf = (name: string) => {
      const c = callIdOf(name) as Extract<AgentEvent, { type: "tool_call" }>;
      return events.find((e) => e.type === "tool_output" && e.callId === c.callId && e.stream === "result") as
        | (Extract<AgentEvent, { type: "tool_output" }> & { meta?: { bytes?: number; files?: number } })
        | undefined;
    };
    const read = resultOf("read_file")!;
    expect(read.chunk.length).toBeLessThan(big.length); // the UI copy is cut
    expect(read.meta).toEqual({ bytes: 5000 }); // the size is of the whole file, in bytes
    expect(resultOf("list_files")!.meta).toEqual({ files: 3 });

    // Nothing extra is sent to the model.
    const toolMessages = model.requests[2]!.messages.filter((m) => m.role === "tool");
    expect(toolMessages[0]!.content).toBe(big);
    for (const m of toolMessages) expect(String(m.content)).not.toMatch(/"bytes"|"meta"/);
  });
});
