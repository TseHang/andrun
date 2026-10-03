// The session state machine (ADR D3, D6, D7, D10, D11, D18): hosts the agent loop for one session.
// All state lives in SessionStore; only the in-flight run, its queue and the `deleted` flag are in memory,
// so a new engine over the same SQLite behaves like the old one (the Durable Object can be evicted at any time).

import { createSession, resume, runAgent, type RunResult } from "../core/agent";
import type { AgentEvent, EventBody } from "../core/events";
import { getProfile } from "../core/modes";
import { MAX_FILE_BYTES } from "../core/tools";
import { SandboxLostError, type AgentDeps, type AgentState, type ApprovalDecision, type PendingApproval } from "../core/types";
import { OutputCoalescer } from "./coalesce";
import { parseClientFrame, titleOf } from "./frames";
import type { EngineDeps } from "./ports";
import { RESTORED_NOTE, type PendingView, type ServerFrame, type SessionSnapshot } from "./protocol";
import { SessionStore } from "./store";

const WATCHDOG_MS = 60_000;
const COALESCE_WINDOW_MS = 250;

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The tool name a pending approval shows to the user (same mapping as `pause()` in the core). */
function toolOf(pending: PendingApproval): string {
  return pending.kind === "tool" ? pending.call.function.name : pending.kind === "strikes" ? pending.tool : "finish";
}

/** Approving a finish needs no sandbox: the run just ends. */
function approvesFinish(pending: PendingApproval, decision: ApprovalDecision): boolean {
  return decision.approved && (pending.kind === "implicit_finish" || (pending.kind === "tool" && pending.call.function.name === "finish"));
}

export class SessionEngine {
  private readonly store: SessionStore;
  private readonly coalescer: OutputCoalescer;
  private inflight: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private queued: string[] = [];
  private deleted = false;
  /** Frames waiting for a segment that is winding down. */
  private deferred = 0;
  /** The status last emitted in this object's lifetime; the core's reaches SQLite only at its next checkpoint. */
  private liveStatus: AgentState["status"] | null = null;
  private reconcileChain: Promise<void> = Promise.resolve();
  private readonly upserts = new Set<Promise<void>>();
  private indexChain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: EngineDeps) {
    this.store = new SessionStore(deps.sql);
    this.coalescer = new OutputCoalescer({ windowMs: COALESCE_WINDOW_MS, sink: (event) => this.persistAndBroadcast(event) });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  // ---------- Public API ----------

  create(input: { id: string; mode: "code"; task: string; model?: string }): void {
    if (this.store.exists()) throw new Error("session already exists");
    const profile = getProfile(input.mode, this.deps.config);
    const state = createSession({ sessionId: input.id, mode: input.mode, task: input.task }, profile);
    const now = this.now();
    this.store.create(
      {
        id: input.id,
        mode: input.mode,
        title: titleOf(input.task),
        repo: this.deps.repo.name,
        sha: this.deps.repo.sha,
        created_at: now,
        updated_at: now,
        ...(input.model !== undefined && { model: input.model }),
      },
      state,
    );
    this.ownEmit({ type: "message", id: crypto.randomUUID(), role: "user", text: input.task });
    this.setStatus("running");
    this.startSegment(null, true);
  }

  snapshot(): SessionSnapshot | null {
    const meta = this.store.meta();
    const state = this.store.loadState();
    if (!meta || !state) return null;
    return {
      id: meta.id,
      mode: meta.mode,
      title: meta.title,
      status: state.status,
      pending: state.pending ? pendingView(state.pending) : null,
      sandboxRunning: this.deps.sandbox.isRunning(),
    };
  }

  replay(lastSeq: number): AgentEvent[] | null {
    if (!this.store.exists()) return null;
    return this.store.eventsAfter(lastSeq);
  }

  handleFrame(raw: string | ArrayBuffer, reply: (frame: ServerFrame) => void): void {
    const parsed = parseClientFrame(raw);
    if (!parsed.ok) return reply({ type: "rejected", reason: parsed.reason });
    const state = this.deleted ? null : this.store.loadState();
    if (!state) return reply({ type: "rejected", reason: "no such session" });
    const { frame } = parsed;

    // The gate (or the end of a run) is broadcast while its segment is still saving changes; a frame
    // that arrives in that window waits for the segment instead of being refused.
    if (this.inflight && (this.liveStatus ?? state.status) !== "running") {
      this.deferred++;
      void this.inflight.then(() => {
        this.deferred--;
        this.handleFrame(raw, reply);
      });
      return;
    }

    if (frame.type === "message") {
      if (this.inflight) {
        this.queued.push(frame.text);
        return;
      }
      if (state.status !== "awaiting_approval") return this.newTurn(state, frame.text);
      if (!state.pending) return reply({ type: "rejected", reason: "no such pending approval" });
      return this.decide(state, { approved: false, comment: frame.text }, reply, state.pending.approvalId);
    }

    const decision: ApprovalDecision = frame.type === "approve" ? { approved: true } : { approved: false, comment: frame.comment };
    this.decide(state, decision, reply, frame.approvalId);
  }

  async remove(): Promise<boolean> {
    if (this.deleted || !this.store.exists()) return false;
    this.deleted = true;
    this.queued = [];
    // The run is not awaited: a model call may never return.
    this.controller?.abort("session deleted");
    await this.deps.sandbox.destroy().catch(() => {});
    this.deps.closeSockets(1000, "session deleted");
    this.deps.setAlarm(null);
    await this.deps.deleteAll();
    return true;
  }

  async killSandbox(): Promise<boolean> {
    if (this.deleted || !this.store.exists()) return false;
    await this.deps.sandbox.destroy();
    return true;
  }

  /** The watchdog (P2-f): a `running` session with no loop in memory was interrupted by an eviction. */
  async alarm(): Promise<void> {
    if (this.deleted || !this.store.exists()) return;
    if (this.inflight) {
      this.deps.setAlarm(this.now() + WATCHDOG_MS);
      return;
    }
    if (this.store.loadState()?.status !== "running") return;
    this.ownEmit({ type: "error", source: "sandbox", message: "the run was interrupted", next: "send a message to continue" });
    this.setStatus("failed");
    await this.deps.sandbox.destroy().catch(() => {});
  }

  async idle(): Promise<void> {
    while (this.inflight || this.upserts.size > 0 || this.deferred > 0) {
      await Promise.all([this.inflight, ...this.upserts]);
      if (this.deferred > 0) await Promise.resolve();
    }
  }

  // ---------- Frames ----------

  /** Approve/reject of the pending approval `approvalId`; refused unless it is the one waiting and no run is in flight. */
  private decide(state: AgentState, decision: ApprovalDecision, reply: (frame: ServerFrame) => void, approvalId: string): void {
    const pending = state.pending;
    if (this.inflight || !pending || pending.approvalId !== approvalId) {
      return reply({ type: "rejected", reason: "no such pending approval" });
    }
    this.startSegment(decision, !approvesFinish(pending, decision));
  }

  /** A message to a session that is not running: the transcript continues, nothing else is reset. */
  private newTurn(state: AgentState, text: string): void {
    // A run can fail with tool calls still open (the sandbox could not be rebuilt at a gate); a provider
    // rejects a transcript like that, so they are answered here, like `guarded()` does in the core.
    const answered = new Set(state.messages.flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : [])));
    for (const m of [...state.messages]) {
      if (m.role !== "assistant") continue;
      for (const c of m.tool_calls ?? []) {
        if (!answered.has(c.id)) state.messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify({ error: "the run failed" }) });
      }
    }
    state.messages.push({ role: "user", content: text });
    state.pending = null;
    state.failures = null;
    state.nudged = false;
    this.store.saveState(state, this.now());
    this.ownEmit({ type: "message", id: crypto.randomUUID(), role: "user", text });
    this.setStatus("running");
    this.startSegment(null, true);
  }

  // ---------- Events ----------

  /** Where every event ends up: persisted (deltas are skipped by the store), then sent to clients. */
  private persistAndBroadcast(event: AgentEvent): void {
    if (this.deleted) return;
    this.store.appendEvent(event);
    this.deps.broadcast(event);
  }

  /** An event the engine itself emits; only while no core run is executing, because the core owns `nextSeq` then. */
  private emitFor(state: AgentState, body: EventBody): void {
    this.coalescer.push({
      ...body,
      seq: state.nextSeq++,
      ts: Date.now(),
      sessionId: state.sessionId,
      ...(state.step > 0 && { stepId: `s${state.step}` }),
    });
  }

  private ownEmit(body: EventBody): void {
    if (this.deleted) return;
    const state = this.store.loadState();
    if (!state) return;
    this.emitFor(state, body);
    this.store.saveState(state, this.now());
  }

  /** Emit, save, then tell the index. */
  private setStatus(status: AgentState["status"]): void {
    if (this.deleted) return;
    const state = this.store.loadState();
    if (!state) return;
    state.status = status;
    // A failed run has nothing left to approve (the sandbox could not be rebuilt at a gate, for example).
    if (status === "failed") state.pending = null;
    this.liveStatus = status;
    this.emitFor(state, { type: "status", status });
    this.store.saveState(state, this.now());
    this.upsertIndex(status);
  }

  /** Not awaited and never thrown into the session (D16); `idle()` waits for it so tests can look. */
  private upsertIndex(status: AgentState["status"]): void {
    const meta = this.deleted ? null : this.store.meta();
    if (!meta) return;
    const row = { id: meta.id, mode: meta.mode, title: meta.title, status, created_at: meta.created_at, updated_at: this.now() };
    // One write at a time: calls to the WorkspaceDO are not delivered in order, and a late
    // "running" would overwrite a newer status in the sidebar.
    const tracked: Promise<void> = this.indexChain
      .then(() => this.deps.index.upsert(row))
      .catch((err) => console.error("session index upsert failed:", err))
      .finally(() => this.upserts.delete(tracked));
    this.indexChain = tracked;
    this.upserts.add(tracked);
  }


  /** What the core emits. Its status changes reach the index here; its file changes trigger a reconcile. */
  private onCoreEvent(event: AgentEvent): void {
    if (event.type === "status") this.liveStatus = event.status;
    this.coalescer.push(event);
    if (event.type === "status") this.upsertIndex(event.status);
    if (event.type === "file_changed") void this.queueReconcile();
  }

  // ---------- Run segments ----------

  /** Registers the segment as in flight synchronously, so a second identical frame is refused. */
  private startSegment(decision: ApprovalDecision | null, needSandbox: boolean): void {
    const controller = new AbortController();
    this.controller = controller;
    // From here the session is running for incoming frames, also while the sandbox is being rebuilt.
    this.liveStatus = "running";
    // Started on a microtask, so the segment is registered as in flight before any of it runs.
    const run: Promise<void> = Promise.resolve()
      .then(() => this.segment(controller, decision, needSandbox))
      .catch((err) => console.error("run segment failed:", err))
      .finally(() => {
        if (this.inflight === run) {
          this.inflight = null;
          this.controller = null;
        }
        this.finishSegment();
      });
    this.inflight = run;
  }

  private finishSegment(): void {
    if (this.deleted) return;
    try {
      const status = this.store.loadState()?.status;
      this.liveStatus = status ?? null;
      if (status !== "running") this.deps.setAlarm(null);
      // Messages typed too late to be injected into the run are applied now, as if just sent:
      // a Reject + comment at a gate, or a new turn after the run ended.
      // Only the first is dispatched; it starts a run, and the rest stay queued for that run to pick up.
      const first = this.queued.shift();
      if (first !== undefined) this.handleFrame(JSON.stringify({ type: "message", text: first }), () => {});
    } catch (err) {
      console.error("finishing a run segment failed:", err);
    }
  }

  private async segment(controller: AbortController, decision: ApprovalDecision | null, needSandbox: boolean): Promise<void> {
    const { deps, store } = this;
    deps.setAlarm(this.now() + WATCHDOG_MS);
    if (needSandbox && !(await this.ensureSandbox())) return;

    const state = this.deleted ? null : store.loadState();
    if (!state) return;
    const base = getProfile(state.mode, deps.config);
    const profile = { ...base, model: store.meta()?.model ?? base.model };
    const agentDeps: AgentDeps = {
      model: deps.model,
      sandbox: deps.sandbox,
      config: deps.config,
      signal: controller.signal,
      emit: (event) => this.onCoreEvent(event),
      checkpoint: (s) => {
        if (!this.deleted) store.saveState(s, this.now());
      },
      drainUserMessages: () => this.queued.splice(0),
    };

    let result: RunResult;
    try {
      result = decision ? await resume(state, decision, profile, agentDeps) : await runAgent(state, profile, agentDeps);
    } catch (err) {
      this.coalescer.flush();
      await this.failSession(messageOf(err));
      return;
    }
    this.coalescer.flush();
    if (this.deleted) return;
    store.saveState(result.state, this.now());

    if (deps.sandbox.isRunning()) await this.queueReconcile();
    else await this.reconcileChain;

    if (result.state.status === "done" || result.state.status === "failed") await deps.sandbox.destroy().catch(() => {});
  }

  /** Ends the session as failed with a sandbox-source error (also for an unexpected throw from the core). */
  private async failSession(message: string): Promise<void> {
    this.ownEmit({ type: "error", source: "sandbox", message });
    this.setStatus("failed");
    await this.deps.sandbox.destroy().catch(() => {});
  }

  /** Starts the sandbox if it is not running and restores saved changes into it. False when the segment must end. */
  private async ensureSandbox(): Promise<boolean> {
    const { deps, store } = this;
    if (deps.sandbox.isRunning()) return true;
    const meta = store.meta();
    if (!meta) return false;

    const callId = crypto.randomUUID();
    this.ownEmit({
      type: "tool_call",
      callId,
      name: "sandbox_setup",
      args: { repo: meta.repo, sha: meta.sha },
      summary: "Starting sandbox…",
    });
    try {
      const tarball = await deps.fetchTarball(meta.repo, meta.sha);
      const { readyMs } = await deps.sandbox.setup(tarball);
      if (this.deleted) {
        await deps.sandbox.destroy().catch(() => {});
        return false;
      }

      const changes = store.changes();
      const notRestored: string[] = [];
      for (const change of changes) {
        if (change.deleted) await deps.sandbox.removeFile(change.path);
        else if (change.skipped || change.content === null) notRestored.push(change.path);
        else await deps.sandbox.writeFile(change.path, change.content);
      }

      this.ownEmit({ type: "tool_output", callId, stream: "result", chunk: `ready in ${(readyMs / 1000).toFixed(1)} s` });
      if (changes.length > 0) {
        // The sandbox was lost and rebuilt (D11): say so, the user may have waited a long time.
        const skipped = notRestored.length > 0 ? ` Not restored (over 1 MB or binary): ${notRestored.join(", ")}.` : "";
        this.ownEmit({ type: "error", source: "sandbox", message: RESTORED_NOTE + skipped, next: "The run continues." });
      }
      return true;
    } catch (err) {
      this.ownEmit({ type: "tool_output", callId, stream: "result", chunk: "failed" });
      await this.failSession(messageOf(err));
      return false;
    }
  }

  // ---------- Changes (P2-e) ----------

  /** Reconciles never overlap and never block `emit`. */
  private queueReconcile(): Promise<void> {
    this.reconcileChain = this.reconcileChain
      .then(() => this.reconcile())
      .catch((err) => {
        // A lost sandbox is expected here; anything else means changes are not being saved.
        if (!(err instanceof SandboxLostError)) console.error("saving workspace changes failed:", err);
      });
    return this.reconcileChain;
  }

  /** Makes the `changes` table match the sandbox, so a rebuilt sandbox can get the workspace back. */
  private async reconcile(): Promise<void> {
    const { sandbox } = this.deps;
    const files = await sandbox.changedFiles();
    const stored = new Map(this.store.changes().map((c) => [c.path, c]));

    for (const file of files) {
      if (stored.get(file.path)?.afterSha === file.afterSha && stored.has(file.path)) continue;
      if (file.status === "deleted") {
        if (this.deleted) return;
        this.store.putChange({ path: file.path, beforeSha: file.beforeSha, afterSha: null, content: null, deleted: true, skipped: false });
        continue;
      }
      const change = { path: file.path, beforeSha: file.beforeSha, afterSha: file.afterSha, deleted: false };
      // Not saved: over 1 MB (never read), or not valid UTF-8 text (a binary file would come back corrupted).
      if (file.size !== null && file.size > MAX_FILE_BYTES) {
        this.store.putChange({ ...change, content: null, skipped: true });
        continue;
      }
      const content = await sandbox.readFile(file.path);
      if (this.deleted) return;
      const skipped = content.includes("\uFFFD") || new TextEncoder().encode(content).length > MAX_FILE_BYTES;
      try {
        this.store.putChange({ ...change, content: skipped ? null : content, skipped });
      } catch (err) {
        console.error(`saving ${file.path} failed:`, err);
        this.store.putChange({ ...change, content: null, skipped: true });
      }
    }

    // A row for a file that could not be saved is kept even when the file is gone: after a rebuild it is
    // the only record that something is missing, and every later rebuild must say so again.
    const present = new Set(files.map((f) => f.path));
    for (const [path, row] of stored) {
      if (this.deleted) return;
      if (!present.has(path) && !row.skipped) this.store.removeChange(path);
    }
  }
}

function pendingView(pending: PendingApproval): PendingView {
  return {
    approvalId: pending.approvalId,
    reason: pending.reason,
    tool: toolOf(pending),
    ...(pending.kind !== "strikes" && pending.summary !== undefined && { summary: pending.summary }),
    ...(pending.kind !== "strikes" && pending.diffSummary && { diffSummary: pending.diffSummary }),
  };
}
