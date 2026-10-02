import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig, type AgentConfig } from "../../src/core/config";
import type { AgentEvent } from "../../src/core/events";
import { ModelError, type ChatMessage, type ModelClient, type ModelRequest, type ModelResponse } from "../../src/core/types";
import { CloudflareSandboxAdapter } from "../../src/sandbox/cloudflare-sandbox";
import { SessionEngine } from "../../src/session/engine";
import type { EngineDeps } from "../../src/session/ports";
import type { ClientFrame, ServerFrame, SessionSummary } from "../../src/session/protocol";
import { SessionStore } from "../../src/session/store";
import { FakeContainer } from "../support/fake-container";
import { nodeSql } from "../support/node-sql";
import { ScriptedModelClient, call, type ScriptStep } from "../support/scripted-model";
import { fixtureTarball, streamOf } from "../support/tarball";

const FIXTURE = join(import.meta.dirname, "../../eval/fixtures/sum-off-by-one");
const TARBALL = fixtureTarball(FIXTURE);
const REPO = { name: "TseHang/andrun-demo", sha: "0df6f53ec8a51785899d574c43db212513347537" };
const ID = "5b0e7a52-4a2f-4f0a-9d1c-0c3f1a2b3c4d";
const TASK = "make the failing test pass";
const COMMENT = "also add a test for the empty array case";

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

const EMPTY_TEST = [
  'import { test } from "node:test";',
  'import assert from "node:assert/strict";',
  'import { sum } from "../src/sum.js";',
  "",
  'test("empty array", () => {',
  "  assert.equal(sum([]), 0);",
  "});",
  "",
].join("\n");

const HAPPY = (): ScriptStep[] => [
  { text: "Running the tests first.", calls: [{ name: "run_command", args: { command: "npm test" } }] },
  call("read_file", { path: "src/sum.js" }),
  call("apply_patch", { patch: FIX_PATCH }),
  call("run_command", { command: "npm test" }),
  call("finish", { summary: "Fixed the loop bound in sum()." }),
];

const AFTER_REJECT = (): ScriptStep[] => [
  call("write_file", { path: "test/empty.test.js", content: EMPTY_TEST }),
  call("run_command", { command: "npm test" }),
  call("finish", { summary: "Added the empty array test." }),
];

const containers: FakeContainer[] = [];
afterEach(async () => {
  await Promise.all(containers.splice(0).map((c) => c.cleanup()));
});

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function world(opts: { tarball?: Uint8Array; config?: AgentConfig } = {}) {
  const db = nodeSql();
  const container = new FakeContainer();
  containers.push(container);
  const frames: ServerFrame[] = [];
  const upserts: SessionSummary[] = [];
  const alarms: (number | null)[] = [];
  const closed: { code: number; reason: string }[] = [];
  const tarballRequests: { repo: string; sha: string }[] = [];

  /** A new adapter each time, like a Durable Object that was evicted and woke up again. */
  const adapter = () =>
    new CloudflareSandboxAdapter({ container, files: container.files, workdir: container.workdir, tmpDir: container.tmpDir });

  const engine = (model: ModelClient, over: Partial<EngineDeps> = {}) =>
    new SessionEngine({
      sql: db.sql,
      sandbox: adapter(),
      fetchTarball: async (repo, sha) => {
        tarballRequests.push({ repo, sha });
        return streamOf(opts.tarball ?? TARBALL);
      },
      model,
      config: opts.config ?? defaultConfig,
      repo: REPO,
      broadcast: (frame) => frames.push(frame),
      index: {
        upsert: async (row) => {
          upserts.push(row);
        },
      },
      setAlarm: (at) => alarms.push(at),
      closeSockets: (code, reason) => closed.push({ code, reason }),
      deleteAll: () => db.deleteAll(),
      ...over,
    });

  const store = () => new SessionStore(db.sql);
  const events = (): AgentEvent[] => store().eventsAfter(0);
  return { db, container, frames, upserts, alarms, closed, tarballRequests, adapter, engine, store, events };
}

/** Sends one client frame and waits for the run it may have started. */
async function send(engine: SessionEngine, frame: ClientFrame | Record<string, unknown>): Promise<ServerFrame[]> {
  const replies: ServerFrame[] = [];
  engine.handleFrame(JSON.stringify(frame), (r) => replies.push(r));
  await engine.idle();
  return replies;
}

/** A session that ran the happy script and is waiting at the approval gate. */
async function atGate(extra: ScriptStep[] = [], opts: Parameters<typeof world>[0] = {}) {
  const w = world(opts);
  const model = new ScriptedModelClient([...HAPPY(), ...extra]);
  const engine = w.engine(model);
  engine.create({ id: ID, mode: "code", task: TASK });
  await engine.idle();
  const snapshot = engine.snapshot();
  if (!snapshot?.pending) throw new Error(`expected a pending approval, got ${JSON.stringify(snapshot)}`);
  return { ...w, makeEngine: w.engine, model, engine, approvalId: snapshot.pending.approvalId };
}

const types = (events: AgentEvent[]) => events.map((e) => e.type);
const statuses = (events: AgentEvent[]) => events.flatMap((e) => (e.type === "status" ? [e.status] : []));
const ofType = <T extends AgentEvent["type"]>(events: AgentEvent[], type: T) =>
  events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);

function expectIncreasingSeq(events: AgentEvent[]): void {
  const seqs = events.map((e) => e.seq);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  expect(new Set(seqs).size).toBe(seqs.length);
}

/** Every tool_call in the transcript has exactly one tool message (a provider rejects anything else). */
function expectValidTranscript(messages: ChatMessage[]): void {
  const answered = messages.flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : []));
  const asked = messages.flatMap((m) => (m.role === "assistant" ? (m.tool_calls ?? []).map((c) => c.id) : []));
  expect([...answered].sort()).toEqual([...asked].sort());
}

/** Delegates to a script, then never answers: a model call that is still in flight. */
class HangingModel implements ModelClient {
  hanging = false;
  signal: AbortSignal | undefined;
  private readonly inner: ScriptedModelClient;
  constructor(steps: ScriptStep[]) {
    this.inner = new ScriptedModelClient(steps);
  }
  complete(req: ModelRequest, onDelta?: (text: string) => void): Promise<ModelResponse> {
    if (this.inner.remaining > 0) return this.inner.complete(req, onDelta);
    this.hanging = true;
    this.signal = req.signal;
    return new Promise(() => {});
  }
}

describe("S1: a created session runs to the approval gate and is persisted", () => {
  it("create runs to the gate and persists events, transcript and changes", async () => {
    const w = world();
    const engine = w.engine(new ScriptedModelClient(HAPPY()));
    expect(engine.snapshot()).toBeNull();

    engine.create({ id: ID, mode: "code", task: TASK });
    expect(engine.snapshot()).toMatchObject({ id: ID, status: "running" }); // visible before the run ends
    await engine.idle();

    const snapshot = engine.snapshot()!;
    expect(snapshot).toMatchObject({
      id: ID,
      mode: "code",
      title: TASK,
      status: "awaiting_approval",
      pending: { tool: "finish", summary: "Fixed the loop bound in sum()." },
    });
    expect(snapshot.pending!.diffSummary).toEqual({ files: [{ path: "src/sum.js", additions: 1, deletions: 1 }] });

    const events = w.events();
    expectIncreasingSeq(events);
    expect(events[0]).toMatchObject({ type: "message", role: "user", text: TASK, sessionId: ID });
    expect(events[1]).toMatchObject({ type: "status", status: "running" });
    // Host-side sandbox setup is shown as an ordinary step (P2-g, spike finding 3).
    expect(events[2]).toMatchObject({ type: "tool_call", name: "sandbox_setup", summary: "Starting sandbox…" });
    const setupCall = events[2] as Extract<AgentEvent, { type: "tool_call" }>;
    expect(events[3]).toMatchObject({ type: "tool_output", callId: setupCall.callId, stream: "result" });
    expect((events[3] as Extract<AgentEvent, { type: "tool_output" }>).chunk).toMatch(/^ready in \d+(\.\d+)? s$/);
    expect(types(events.slice(-2))).toEqual(["approval_required", "status"]);
    expect(statuses(events)).toEqual(["running", "awaiting_approval"]);
    expect(ofType(events, "file_changed").map((e) => e.path)).toEqual(["src/sum.js"]);
    const testRuns = ofType(events, "tool_output").filter((e) => e.exitCode !== undefined);
    expect(testRuns.map((e) => e.exitCode)).toEqual([1, 0]);
    expect(types(events)).not.toContain("message_delta");

    // Clients got every persisted event once, in order, plus the streamed deltas.
    expect(w.frames.filter((f) => f.type !== "message_delta")).toEqual(events);
    expect(w.frames.some((f) => f.type === "message_delta")).toBe(true);

    const state = w.store().loadState()!;
    expect(state.status).toBe("awaiting_approval");
    expect(state.messages[0]!.role).toBe("system");
    expect(state.messages[1]).toEqual({ role: "user", content: TASK });
    expect(state.pending).toMatchObject({ kind: "tool", approvalId: snapshot.pending!.approvalId });
    expect(state.step).toBe(5);
    expect(state.nextSeq).toBeGreaterThan(events.at(-1)!.seq);

    const changes = w.store().changes();
    expect(changes.map((c) => c.path)).toEqual(["src/sum.js"]);
    expect(changes[0]).toMatchObject({ deleted: false, skipped: false });
    expect(changes[0]!.content).toContain("i < values.length; i++");

    expect(w.store().meta()).toMatchObject({ id: ID, repo: REPO.name, sha: REPO.sha, title: TASK });
    expect(w.tarballRequests).toEqual([{ repo: REPO.name, sha: REPO.sha }]);
    expect(w.container.starts).toEqual([{ enableInternet: false }]);
    expect(typeof w.alarms[0]).toBe("number"); // the watchdog was armed (P2-f)
  });

  it("refuses to create a session twice", async () => {
    const { engine } = await atGate();
    expect(() => engine.create({ id: ID, mode: "code", task: TASK })).toThrow();
  });
});

describe("S2: a reconnecting client gets exactly the events it missed", () => {
  it("replay sends only events after lastSeq, never deltas", async () => {
    const { engine, events, frames, approvalId } = await atGate();
    const all = events();
    const k = all[5]!.seq;

    expect(engine.replay(k)).toEqual(all.filter((e) => e.seq > k));
    expect(engine.replay(0)).toEqual(all);
    expect(engine.replay(all.at(-1)!.seq)).toEqual([]);
    expect(types(engine.replay(0)!)).not.toContain("message_delta");
    expect(frames.some((f) => f.type === "message_delta")).toBe(true);

    // Reducing the replay gives the same state a live client has.
    const replayed = engine.replay(0)!;
    expect(statuses(replayed).at(-1)).toBe(engine.snapshot()!.status);
    const resolved = new Set(ofType(replayed, "approval_resolved").map((e) => e.approvalId));
    const open = ofType(replayed, "approval_required").filter((e) => !resolved.has(e.approvalId));
    expect(open.map((e) => e.approvalId)).toEqual([approvalId]);

    // A client that is up to date receives only what happens next.
    const last = all.at(-1)!.seq;
    await send(engine, { type: "approve", approvalId });
    const next = engine.replay(last)!;
    expect(types(next)).toEqual(["approval_resolved", "status", "status"]);
    expect(statuses(next)).toEqual(["running", "done"]);
    expect(next.every((e) => e.seq > last)).toBe(true);
  });

  it("a session that does not exist has nothing to replay", () => {
    const w = world();
    expect(w.engine(new ScriptedModelClient([])).replay(0)).toBeNull();
  });
});

describe("S3: approve and reject work over the socket", () => {
  it("approve finishes, reject loops back to the gate, stale and duplicate decisions are refused", async () => {
    // Approve
    {
      const { engine, events, container, upserts, approvalId } = await atGate();
      const before = events().length;
      expect(await send(engine, { type: "approve", approvalId })).toEqual([]);
      const added = events().slice(before);
      expect(added).toMatchObject([
        { type: "approval_resolved", approvalId, approved: true },
        { type: "status", status: "running" },
        { type: "status", status: "done" },
      ]);
      expect(engine.snapshot()).toMatchObject({ status: "done", pending: null });
      expect(container.destroyed).toBe(1); // destroyed on done (ADR D10)
      expect(container.running).toBe(false);
      expect(upserts.at(-1)).toMatchObject({ id: ID, status: "done" });
    }

    // Reject with a comment
    {
      const { engine, events, model, approvalId } = await atGate(AFTER_REJECT());
      const requestsBefore = model.requests.length;
      await send(engine, { type: "reject", approvalId, comment: COMMENT });

      const feedback = model.requests[requestsBefore]!.messages.at(-1)!;
      expect(feedback.role).toBe("tool");
      expect(feedback.content).toContain(COMMENT);

      const snapshot = engine.snapshot()!;
      expect(snapshot.status).toBe("awaiting_approval");
      expect(snapshot.pending!.approvalId).not.toBe(approvalId);
      expect(snapshot.pending!.summary).toBe("Added the empty array test.");
      expect(snapshot.pending!.diffSummary!.files.map((f) => f.path).sort()).toEqual(["src/sum.js", "test/empty.test.js"]);
      expect(ofType(events(), "approval_resolved")).toMatchObject([{ approvalId, approved: false, comment: COMMENT }]);
      expect(statuses(events())).toEqual(["running", "awaiting_approval", "running", "awaiting_approval"]);
      expectIncreasingSeq(events());
    }

    // Stale approval id
    {
      const { engine, events } = await atGate();
      const before = events();
      expect(await send(engine, { type: "approve", approvalId: "stale" })).toEqual([
        { type: "rejected", reason: "no such pending approval" },
      ]);
      expect(events()).toEqual(before);
      expect(engine.snapshot()!.status).toBe("awaiting_approval");
    }

    // The same approval twice (double click, or two tabs)
    {
      const { engine, events, approvalId } = await atGate();
      const first: ServerFrame[] = [];
      const second: ServerFrame[] = [];
      engine.handleFrame(JSON.stringify({ type: "approve", approvalId }), (r) => first.push(r));
      engine.handleFrame(JSON.stringify({ type: "approve", approvalId }), (r) => second.push(r));
      await engine.idle();
      expect(first).toEqual([]);
      expect(second).toEqual([{ type: "rejected", reason: "no such pending approval" }]);
      expect(ofType(events(), "approval_resolved")).toHaveLength(1);
      expect(engine.snapshot()!.status).toBe("done");
    }
  });

  it("a decision sent the instant the gate appears is applied, not refused", async () => {
    // Found at runtime: the gate is broadcast while the run segment is still saving changes.
    const w = world();
    const replies: ServerFrame[] = [];
    const ref: { engine?: SessionEngine } = {};
    let approvalId = "";
    const engine = (ref.engine = w.engine(new ScriptedModelClient(HAPPY()), {
      broadcast: (frame) => {
        w.frames.push(frame);
        if (frame.type === "approval_required") approvalId = frame.approvalId;
        if (frame.type === "status" && frame.status === "awaiting_approval") {
          const approve = JSON.stringify({ type: "approve", approvalId });
          ref.engine!.handleFrame(approve, (r) => replies.push(r));
          ref.engine!.handleFrame(approve, (r) => replies.push(r)); // a double click in the same instant
        }
      },
    }));
    engine.create({ id: ID, mode: "code", task: TASK });
    await engine.idle();

    expect(engine.snapshot()).toMatchObject({ status: "done", pending: null });
    expect(ofType(w.events(), "approval_resolved")).toHaveLength(1);
    expect(replies).toEqual([{ type: "rejected", reason: "no such pending approval" }]);
    // The changes were still saved before the decision was applied.
    expect(w.store().changes().map((c) => c.path)).toEqual(["src/sum.js"]);
  });

  it("refuses frames it cannot parse and keeps going", async () => {
    const { engine, events } = await atGate();
    const before = events();
    for (const raw of ["not json", JSON.stringify({ type: "nope" }), JSON.stringify({ type: "reject", approvalId: "x" })]) {
      const replies: ServerFrame[] = [];
      engine.handleFrame(raw, (r) => replies.push(r));
      expect(replies).toHaveLength(1);
      expect(replies[0]!.type).toBe("rejected");
    }
    expect(events()).toEqual(before);
  });
});

describe("S4: the pause survives an evicted Durable Object", () => {
  it("a fresh engine over the same store resumes from the gate", async () => {
    const w = await atGate();
    const before = w.events();

    const woken = w.makeEngine(new ScriptedModelClient([])); // new object, same SQLite, same container
    expect(woken.snapshot()).toMatchObject({ status: "awaiting_approval", pending: { approvalId: w.approvalId } });
    expect(woken.replay(0)).toEqual(before);

    await send(woken, { type: "approve", approvalId: w.approvalId });
    const after = w.events();
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length)).toMatchObject([
      { type: "approval_resolved", approved: true },
      { type: "status", status: "running" },
      { type: "status", status: "done" },
    ]);
    expectIncreasingSeq(after);
    expect(woken.snapshot()).toMatchObject({ status: "done", pending: null });
  });
});

describe("S6: the state machine accepts messages in every state (D6)", () => {
  const TEXT = "also rename the helper";

  it("messages start a new turn, queue a redirect, or reject the gate, by state", async () => {
    // done → running (new turn, same transcript)
    {
      const { engine, events, model, approvalId } = await atGate([call("finish", { summary: "Nothing to rename." })]);
      await send(engine, { type: "approve", approvalId });
      const requestsBefore = model.requests.length;
      const eventsBefore = events().length;

      expect(await send(engine, { type: "message", text: TEXT })).toEqual([]);
      const request = model.requests[requestsBefore]!;
      expect(request.messages.at(-1)).toEqual({ role: "user", content: TEXT });
      expect(request.messages.length).toBeGreaterThan(model.requests[requestsBefore - 1]!.messages.length);
      expectValidTranscript(request.messages);

      const added = events().slice(eventsBefore);
      expect(added[0]).toMatchObject({ type: "message", role: "user", text: TEXT });
      expect(added[1]).toMatchObject({ type: "status", status: "running" });
      expect(engine.snapshot()!.status).toBe("awaiting_approval");
      // The sandbox was destroyed on done, so the new turn works in a rebuilt one with the fix in place.
      expect(engine.snapshot()!.pending!.diffSummary!.files.map((f) => f.path)).toEqual(["src/sum.js"]);
    }

    // failed → running
    {
      const w = world();
      const model = new ScriptedModelClient([new ModelError("ai& returned HTTP 500", 500), call("finish", { summary: "ok" })]);
      const engine = w.engine(model);
      engine.create({ id: ID, mode: "code", task: TASK });
      await engine.idle();
      expect(engine.snapshot()!.status).toBe("failed");

      await send(engine, { type: "message", text: TEXT });
      expect(model.requests.at(-1)!.messages.at(-1)).toEqual({ role: "user", content: TEXT });
      expect(engine.snapshot()!.status).toBe("awaiting_approval");
      expect(statuses(w.events())).toEqual(["running", "failed", "running", "awaiting_approval"]);
    }

    // budget_exceeded → running. The budget is per session (spec §6), so the turn stops again at once.
    {
      const w = world({ config: { ...defaultConfig, maxSteps: 1 } });
      const model = new ScriptedModelClient([call("list_files", {})]);
      const engine = w.engine(model);
      engine.create({ id: ID, mode: "code", task: TASK });
      await engine.idle();
      expect(engine.snapshot()!.status).toBe("budget_exceeded");

      await send(engine, { type: "message", text: TEXT });
      expect(ofType(w.events(), "message").at(-1)).toMatchObject({ role: "user", text: TEXT });
      expect(statuses(w.events())).toEqual(["running", "budget_exceeded", "running", "budget_exceeded"]);
      expect(model.requests).toHaveLength(1);
    }

    // running → queued, injected at the next step boundary
    {
      const w = world();
      const ref: { engine?: SessionEngine } = {};
      const replies: ServerFrame[] = [];
      const model = new ScriptedModelClient([
        call("list_files", {}),
        () => {
          // The user types while the model is answering step 2.
          ref.engine!.handleFrame(JSON.stringify({ type: "message", text: TEXT }), (r) => replies.push(r));
          return call("read_file", { path: "src/sum.js" });
        },
        call("finish", { summary: "ok" }),
      ]);
      const engine = (ref.engine = w.engine(model));
      engine.create({ id: ID, mode: "code", task: TASK });
      await engine.idle();

      expect(replies).toEqual([]);
      expect(model.requests[1]!.messages.some((m) => m.role === "user" && m.content === TEXT)).toBe(false);
      expect(model.requests[2]!.messages.at(-1)).toEqual({ role: "user", content: TEXT });
      expect(ofType(w.events(), "message").filter((e) => e.text === TEXT)).toHaveLength(1);
      expect(statuses(w.events())).toEqual(["running", "awaiting_approval"]);
    }

    // awaiting_approval → handled as Reject + comment
    {
      const { engine, events, model, approvalId } = await atGate(AFTER_REJECT());
      const requestsBefore = model.requests.length;
      expect(await send(engine, { type: "message", text: COMMENT })).toEqual([]);
      expect(ofType(events(), "approval_resolved")).toMatchObject([{ approvalId, approved: false, comment: COMMENT }]);
      expect(model.requests[requestsBefore]!.messages.at(-1)!.content).toContain(COMMENT);
      expect(engine.snapshot()!.status).toBe("awaiting_approval");
      expect(engine.snapshot()!.pending!.approvalId).not.toBe(approvalId);
    }
  });

  it("refuses a decision while the agent is running", async () => {
    const w = world();
    const ref: { engine?: SessionEngine } = {};
    const replies: ServerFrame[] = [];
    const model = new ScriptedModelClient([
      () => {
        ref.engine!.handleFrame(JSON.stringify({ type: "approve", approvalId: "anything" }), (r) => replies.push(r));
        return call("finish", { summary: "ok" });
      },
    ]);
    const engine = (ref.engine = w.engine(model));
    engine.create({ id: ID, mode: "code", task: TASK });
    await engine.idle();
    expect(replies).toEqual([{ type: "rejected", reason: "no such pending approval" }]);
    expect(engine.snapshot()!.status).toBe("awaiting_approval");
  });
});

describe("S9: a sandbox killed mid-run ends the session as failed (spec test D)", () => {
  const SLOW = fixtureTarball(FIXTURE, {
    "package.json": JSON.stringify({ name: "slow", private: true, type: "module", scripts: { test: "sleep 10" } }),
  });
  const SCRIPT = (): ScriptStep[] => [call("run_command", { command: "npm test" }), call("finish", { summary: "never reached" })];
  const running = (w: ReturnType<typeof world>) => () =>
    w.frames.some((f) => f.type === "tool_call" && f.name === "run_command");

  it("sandbox loss mid-run fails visibly", async () => {
    const w = world({ tarball: SLOW });
    const model = new ScriptedModelClient(SCRIPT());
    const engine = w.engine(model);
    engine.create({ id: ID, mode: "code", task: TASK });
    await until(running(w));
    await new Promise((r) => setTimeout(r, 200));

    const killed = Date.now();
    await w.container.destroy(); // the platform took the container away mid-command
    await engine.idle();
    expect(Date.now() - killed).toBeLessThan(5000);

    const events = w.events();
    expect(events.slice(-2)).toMatchObject([
      { type: "error", source: "sandbox" },
      { type: "status", status: "failed" },
    ]);
    expect((events.at(-2) as Extract<AgentEvent, { type: "error" }>).message).toMatch(/sandbox/i);
    expect(engine.snapshot()).toMatchObject({ status: "failed", pending: null });
    expect(w.upserts.at(-1)).toMatchObject({ status: "failed" });

    expectValidTranscript(w.store().loadState()!.messages);
    expect(model.requests).toHaveLength(1); // no further model call
    const testRuns = w.container.calls.filter((c) => c.argv.join(" ").includes("npm test"));
    expect(testRuns).toHaveLength(1); // the command is not retried
    expect(w.container.running).toBe(false);
  });

  it("the debug kill fails a running session the same way", async () => {
    const w = world({ tarball: SLOW });
    const engine = w.engine(new ScriptedModelClient(SCRIPT()));
    engine.create({ id: ID, mode: "code", task: TASK });
    await until(running(w));

    expect(await engine.killSandbox()).toBe(true);
    await engine.idle();
    expect(w.events().slice(-2)).toMatchObject([
      { type: "error", source: "sandbox" },
      { type: "status", status: "failed" },
    ]);
  });

  it("model failure fails visibly", async () => {
    const w = world();
    const engine = w.engine(new ScriptedModelClient([new ModelError("ai& returned HTTP 500", 500)]));
    engine.create({ id: ID, mode: "code", task: TASK });
    await engine.idle();

    const events = w.events();
    expect(events.slice(-2)).toMatchObject([
      { type: "error", source: "model", message: "ai& returned HTTP 500" },
      { type: "status", status: "failed" },
    ]);
    expect(w.frames.slice(-2)).toEqual(events.slice(-2));
    expect(engine.snapshot()!.status).toBe("failed");
    expect(w.container.running).toBe(false); // destroyed on failed (ADR D10)
  });

  it("tarball failure fails the session visibly", async () => {
    const w = world();
    const model = new ScriptedModelClient(HAPPY());
    const engine = w.engine(model, {
      fetchTarball: async () => {
        throw new Error("could not download TseHang/andrun-demo: HTTP 404");
      },
    });
    engine.create({ id: ID, mode: "code", task: TASK });
    await engine.idle();

    const events = w.events();
    expect(events.slice(-2)).toMatchObject([
      { type: "error", source: "sandbox" },
      { type: "status", status: "failed" },
    ]);
    expect((events.at(-2) as Extract<AgentEvent, { type: "error" }>).message).toContain("404");
    expect(model.requests).toHaveLength(0);
    expect(w.container.running).toBe(false);
    expect(engine.snapshot()!.status).toBe("failed");
  });
});

describe("S10: a sandbox lost between runs is rebuilt (D11)", () => {
  it("rebuilds the workspace from tarball and changes before resuming", async () => {
    const w = world();
    let sawFixAtModelCall = false;
    const model = new ScriptedModelClient([
      ...HAPPY(),
      () => {
        // By the time the model is asked again, the fix is back on disk.
        const file = join(w.container.workdir, "src/sum.js");
        sawFixAtModelCall = existsSync(file) && readFileSync(file, "utf8").includes("i < values.length; i++");
        return call("run_command", { command: "npm test" });
      },
      call("finish", { summary: "Still passing." }),
    ]);
    const engine = w.engine(model);
    engine.create({ id: ID, mode: "code", task: TASK });
    await engine.idle();
    const approvalId = engine.snapshot()!.pending!.approvalId;
    const gateDiff = await w.adapter().diff();
    expect(gateDiff).toContain("values.length; i++");

    await w.container.destroy(); // idle timeout during a long approval wait
    const before = w.events().length;
    await send(w.engine(model), { type: "reject", approvalId, comment: "run the tests once more" });

    expect(sawFixAtModelCall).toBe(true);
    expect(w.tarballRequests).toHaveLength(2);
    expect(w.tarballRequests[1]).toEqual({ repo: REPO.name, sha: REPO.sha });
    expect(await w.adapter().diff()).toBe(gateDiff);

    const added = w.events().slice(before);
    const note = ofType(added, "error").find((e) => e.source === "sandbox");
    expect(note).toBeDefined();
    expect(note!.message).toMatch(/restored/i);
    expect(note!.next).toMatch(/continu/i);
    expect(ofType(added, "tool_call").some((e) => e.name === "sandbox_setup")).toBe(true);
    const lastRun = ofType(added, "tool_output").filter((e) => e.exitCode !== undefined);
    expect(lastRun.map((e) => e.exitCode)).toEqual([0]); // the tests pass in the rebuilt workspace
    expect(statuses(added)).toEqual(["running", "awaiting_approval"]);
  });

  it("approving finish does not rebuild a sandbox it no longer needs", async () => {
    const w = await atGate();
    await w.container.destroy();
    await send(w.makeEngine(new ScriptedModelClient([])), { type: "approve", approvalId: w.approvalId });
    expect(w.tarballRequests).toHaveLength(1);
    expect(statuses(w.events()).at(-1)).toBe("done");
  });

  it("a deleted file stays deleted after a rebuild", async () => {
    const tarball = fixtureTarball(FIXTURE, { "junk.txt": "junk\n" });
    const w = world({ tarball });
    const deletePatch = ["--- a/junk.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-junk", ""].join("\n");
    let junkExistsAtModelCall: boolean | undefined;
    const model = new ScriptedModelClient([
      call("apply_patch", { patch: deletePatch }),
      call("finish", { summary: "Removed junk.txt." }),
      () => {
        junkExistsAtModelCall = existsSync(join(w.container.workdir, "junk.txt"));
        return call("finish", { summary: "Still removed." });
      },
    ]);
    const engine = w.engine(model);
    engine.create({ id: ID, mode: "code", task: "remove junk.txt" });
    await engine.idle();

    // Deleting a file needs approval (spec §6).
    const first = engine.snapshot()!.pending!;
    expect(first.tool).toBe("apply_patch");
    await send(engine, { type: "approve", approvalId: first.approvalId });
    expect(engine.snapshot()!.pending!.tool).toBe("finish");
    expect(w.store().changes()).toMatchObject([{ path: "junk.txt", deleted: true, content: null }]);

    await w.container.destroy();
    await send(engine, { type: "reject", approvalId: engine.snapshot()!.pending!.approvalId, comment: "double check" });
    expect(junkExistsAtModelCall).toBe(false);
    expect(await w.adapter().listFiles()).not.toContain("junk.txt");
  });

  it("oversized changes are skipped and reported", async () => {
    const tarball = fixtureTarball(FIXTURE, {
      "package.json": JSON.stringify({
        name: "big",
        private: true,
        type: "module",
        scripts: { test: `node -e "require('fs').writeFileSync('big.bin', 'x'.repeat(1100000))"` },
      }),
    });
    const w = world({ tarball });
    const model = new ScriptedModelClient([
      call("run_command", { command: "npm test" }),
      call("finish", { summary: "Wrote big.bin." }),
      call("finish", { summary: "Again." }),
    ]);
    const engine = w.engine(model);
    engine.create({ id: ID, mode: "code", task: "write a big file" });
    await engine.idle();
    expect(w.store().changes()).toMatchObject([{ path: "big.bin", skipped: true, content: null, deleted: false }]);

    await w.container.destroy();
    const before = w.events().length;
    await send(engine, { type: "reject", approvalId: engine.snapshot()!.pending!.approvalId, comment: "again" });
    const note = ofType(w.events().slice(before), "error").find((e) => e.source === "sandbox");
    expect(note!.message).toContain("big.bin");
    expect(existsSync(join(w.container.workdir, "big.bin"))).toBe(false);
  });
});

describe("review: a failed session can always be continued", () => {
  it("a sandbox that cannot be rebuilt at the gate leaves a transcript the next turn can use", async () => {
    const w = await atGate();
    await w.container.destroy();
    let tarballWorks = false;
    const model = new ScriptedModelClient([call("finish", { summary: "Recovered." })]);
    const engine = w.makeEngine(model, {
      fetchTarball: async () => {
        if (!tarballWorks) throw new Error("could not download TseHang/andrun-demo: HTTP 503");
        return streamOf(TARBALL);
      },
    });

    // Reject needs the sandbox; rebuilding it fails while the finish call is still unanswered.
    await send(engine, { type: "reject", approvalId: w.approvalId, comment: "one more check" });
    expect(engine.snapshot()).toMatchObject({ status: "failed", pending: null });

    tarballWorks = true;
    await send(engine, { type: "message", text: "please continue" });
    expectValidTranscript(model.requests[0]!.messages);
    expect(model.requests[0]!.messages.at(-1)).toEqual({ role: "user", content: "please continue" });
    expect(engine.snapshot()!.status).toBe("awaiting_approval");
  });

  it("a message typed during the agent's last step is applied when the run pauses, not lost", async () => {
    const w = world();
    const ref: { engine?: SessionEngine } = {};
    const replies: ServerFrame[] = [];
    const model = new ScriptedModelClient([
      () => {
        // Too late to be injected: the model is already answering with finish.
        ref.engine!.handleFrame(JSON.stringify({ type: "message", text: COMMENT }), (r) => replies.push(r));
        return call("finish", { summary: "Done without the extra test." });
      },
      ...AFTER_REJECT(),
    ]);
    const engine = (ref.engine = w.engine(model));
    engine.create({ id: ID, mode: "code", task: TASK });
    await engine.idle();

    expect(replies).toEqual([]);
    // At the gate a message is a Reject + comment, so the agent goes on with it.
    expect(ofType(w.events(), "approval_resolved")).toMatchObject([{ approved: false, comment: COMMENT }]);
    expect(model.requests[1]!.messages.at(-1)!.content).toContain(COMMENT);
    expect(engine.snapshot()).toMatchObject({ status: "awaiting_approval", pending: { summary: "Added the empty array test." } });
  });

  it("several long late messages are all delivered, none dropped by the length limit", async () => {
    const w = world();
    const ref: { engine?: SessionEngine } = {};
    const first = `first: ${"a".repeat(2500)}`;
    const second = `second: ${"b".repeat(2500)}`; // together over the 4,000 character frame limit
    const model = new ScriptedModelClient([
      () => {
        ref.engine!.handleFrame(JSON.stringify({ type: "message", text: first }), () => {});
        ref.engine!.handleFrame(JSON.stringify({ type: "message", text: second }), () => {});
        return call("finish", { summary: "Done." });
      },
      call("finish", { summary: "Done again." }),
    ]);
    const engine = (ref.engine = w.engine(model));
    engine.create({ id: ID, mode: "code", task: TASK });
    await engine.idle();

    // The first is the Reject comment at the gate; the second is injected into the run that follows.
    expect(ofType(w.events(), "approval_resolved")).toMatchObject([{ approved: false, comment: first }]);
    const request = model.requests[1]!.messages;
    expect(request.some((m) => m.role === "tool" && m.content.includes(first))).toBe(true);
    expect(request.at(-1)).toEqual({ role: "user", content: second });
    expect(engine.snapshot()!.status).toBe("awaiting_approval");
  });

  it("a file that could not be saved is reported after every rebuild, not only the first", async () => {
    const tarball = fixtureTarball(FIXTURE, {
      "package.json": JSON.stringify({
        name: "big",
        private: true,
        type: "module",
        scripts: { test: `node -e "require('fs').writeFileSync('big.bin', 'x'.repeat(1100000))"` },
      }),
    });
    const w = world({ tarball });
    const engine = w.engine(
      new ScriptedModelClient([
        call("run_command", { command: "npm test" }),
        call("finish", { summary: "1" }),
        call("finish", { summary: "2" }),
        call("finish", { summary: "3" }),
      ]),
    );
    engine.create({ id: ID, mode: "code", task: "write a big file" });
    await engine.idle();

    for (const round of [1, 2]) {
      await w.container.destroy();
      const before = w.events().length;
      await send(engine, { type: "reject", approvalId: engine.snapshot()!.pending!.approvalId, comment: `again ${round}` });
      const note = ofType(w.events().slice(before), "error").find((e) => e.source === "sandbox");
      expect(note?.message, `rebuild ${round}`).toContain("big.bin");
    }
  });

  it("a message sent while the sandbox is being rebuilt after an approval is queued for the run", async () => {
    const tarball = fixtureTarball(FIXTURE, { "junk.txt": "junk\n" });
    const w = world({ tarball });
    const deletePatch = ["--- a/junk.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-junk", ""].join("\n");
    const model = new ScriptedModelClient([
      call("apply_patch", { patch: deletePatch }),
      call("list_files", {}),
      call("finish", { summary: "Removed junk.txt." }),
    ]);
    const replies: ServerFrame[] = [];
    const ref: { engine?: SessionEngine } = {};
    const engine = (ref.engine = w.engine(model, {
      fetchTarball: async () => {
        // The second download is the rebuild after the approval: the user types during it.
        if (w.tarballRequests.push({ repo: "", sha: "" }) === 2) {
          ref.engine!.handleFrame(JSON.stringify({ type: "message", text: "also rename the helper" }), (r) => replies.push(r));
        }
        return streamOf(tarball);
      },
    }));
    engine.create({ id: ID, mode: "code", task: "remove junk.txt" });
    await engine.idle();
    await w.container.destroy();

    await send(engine, { type: "approve", approvalId: engine.snapshot()!.pending!.approvalId });
    expect(replies).toEqual([]);
    // Injected as a redirect at the next step, not replayed later as a rejection of the finish gate.
    expect(model.requests[1]!.messages.at(-1)).toEqual({ role: "user", content: "also rename the helper" });
    expect(ofType(w.events(), "approval_resolved").map((e) => e.approved)).toEqual([true]);
    expect(engine.snapshot()).toMatchObject({ status: "awaiting_approval", pending: { tool: "finish" } });
  });

  it("multi-byte and binary files are judged by bytes and never stored corrupted", async () => {
    const cjk = "測".repeat(400_000); // 400k characters, 1.2 MB in UTF-8
    const tarball = fixtureTarball(FIXTURE, {
      "package.json": JSON.stringify({
        name: "bytes",
        private: true,
        type: "module",
        scripts: { test: `node -e "const fs=require('fs');fs.writeFileSync('cjk.txt','測'.repeat(400000));fs.writeFileSync('img.bin',Buffer.from([0xff,0xfe,0x00,0x80,0xc3,0x28]));fs.writeFileSync('ok.txt','fine')"` },
      }),
    });
    const w = world({ tarball });
    const engine = w.engine(new ScriptedModelClient([call("run_command", { command: "npm test" }), call("finish", { summary: "x" })]));
    engine.create({ id: ID, mode: "code", task: "write files" });
    await engine.idle();

    expect(cjk.length).toBeLessThan(1_000_000);
    expect(w.store().changes()).toMatchObject([
      { path: "cjk.txt", skipped: true, content: null },
      { path: "img.bin", skipped: true, content: null },
      { path: "ok.txt", skipped: false, content: "fine" },
    ]);
  });
});

describe("S11: an interrupted run is reported, not left spinning", () => {
  it("watchdog fails a running session that has no loop", async () => {
    const w = world();
    const hanging = new HangingModel([call("list_files", {})]);
    const evicted = w.engine(hanging);
    evicted.create({ id: ID, mode: "code", task: TASK });
    await until(() => hanging.hanging);

    // While the loop is in memory the alarm changes nothing and re-arms itself.
    const eventsBefore = w.events().length;
    const alarmsBefore = w.alarms.length;
    await evicted.alarm();
    expect(w.events()).toHaveLength(eventsBefore);
    expect(w.alarms.length).toBeGreaterThan(alarmsBefore);
    expect(typeof w.alarms.at(-1)).toBe("number");
    expect(evicted.snapshot()!.status).toBe("running");

    // The Durable Object is evicted: a new engine finds `running` in SQLite and no loop in memory.
    const model = new ScriptedModelClient([call("finish", { summary: "Picked up again." })]);
    const woken = w.engine(model);
    expect(woken.snapshot()!.status).toBe("running");
    await woken.alarm();

    const tail = w.events().slice(-2);
    expect(tail).toMatchObject([
      { type: "error", source: "sandbox", message: "the run was interrupted", next: "send a message to continue" },
      { type: "status", status: "failed" },
    ]);
    expect(w.frames.slice(-2)).toEqual(tail);
    expect(woken.snapshot()!.status).toBe("failed");
    expect(w.upserts.at(-1)).toMatchObject({ status: "failed" });
    expectIncreasingSeq(w.events());

    // A message continues from the last checkpoint: step 1's result is still in the transcript.
    await send(woken, { type: "message", text: "please continue" });
    const request = model.requests[0]!;
    expect(request.messages.at(-1)).toEqual({ role: "user", content: "please continue" });
    expect(request.messages.some((m) => m.role === "tool" && m.content.includes("src/sum.js"))).toBe(true);
    expectValidTranscript(request.messages);
    expect(woken.snapshot()!.status).toBe("awaiting_approval");
    expectIncreasingSeq(w.events());
  });

  it("the alarm leaves sessions that are not running alone", async () => {
    const { engine, events, alarms } = await atGate();
    const before = events();
    const armed = alarms.length;
    await engine.alarm();
    expect(events()).toEqual(before);
    expect(alarms.slice(armed).filter((a) => typeof a === "number")).toEqual([]);
  });
});

describe("S13: delete frees everything, and a deleted session is 404 (D18)", () => {
  it("delete tears down and later calls 404 without recreating", async () => {
    const w = await atGate();
    expect(await w.engine.remove()).toBe(true);
    expect(w.closed).toHaveLength(1);
    expect(w.closed[0]!.code).toBe(1000);
    expect(w.container.destroyed).toBe(1);
    expect(w.container.running).toBe(false);
    expect(w.db.tables()).toEqual([]);

    for (const engine of [w.engine, w.makeEngine(new ScriptedModelClient([]))]) {
      expect(engine.snapshot()).toBeNull();
      expect(engine.replay(0)).toBeNull();
      expect(await engine.remove()).toBe(false);
      expect(await engine.killSandbox()).toBe(false);
      const replies = await send(engine, { type: "message", text: "hello?" });
      expect(replies).toEqual([{ type: "rejected", reason: "no such session" }]);
      await engine.alarm();
    }
    expect(w.db.tables()).toEqual([]); // nothing was recreated
    expect(w.closed).toHaveLength(1);
  });

  it("delete aborts a run that is in flight", async () => {
    const w = world();
    const hanging = new HangingModel([call("list_files", {})]);
    const engine = w.engine(hanging);
    engine.create({ id: ID, mode: "code", task: TASK });
    await until(() => hanging.hanging);

    expect(await engine.remove()).toBe(true);
    expect(hanging.signal?.aborted).toBe(true);
    expect(w.container.running).toBe(false);
    expect(w.db.tables()).toEqual([]);
    expect(engine.snapshot()).toBeNull();
  });

  it("a run that is still winding down after delete writes nothing", async () => {
    const slow = fixtureTarball(FIXTURE, {
      "package.json": JSON.stringify({ name: "slow", private: true, type: "module", scripts: { test: "sleep 10" } }),
    });
    const w = world({ tarball: slow });
    const engine = w.engine(new ScriptedModelClient([call("run_command", { command: "npm test" }), call("finish", { summary: "x" })]));
    engine.create({ id: ID, mode: "code", task: TASK });
    await until(() => w.frames.some((f) => f.type === "tool_call" && f.name === "run_command"));

    const framesBefore = w.frames.length;
    expect(await engine.remove()).toBe(true);
    await engine.idle();
    expect(w.db.tables()).toEqual([]);
    expect(w.frames).toHaveLength(framesBefore);
    expect(w.upserts.every((u) => u.status === "running")).toBe(true);
  });
});
