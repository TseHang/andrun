import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../src/core/events";
import type { AgentState } from "../../src/core/types";
import type { SessionMeta } from "../../src/session/ports";
import { SessionStore } from "../../src/session/store";
import { nodeSql } from "../support/node-sql";

const meta: SessionMeta = {
  id: "s1",
  mode: "code",
  title: "make the failing test pass",
  repo: "TseHang/andrun-demo",
  sha: "0df6f53ec8a51785899d574c43db212513347537",
  created_at: 1000,
  updated_at: 1000,
};

const state = (over: Partial<AgentState> = {}): AgentState => ({
  sessionId: "s1",
  mode: "code",
  status: "running",
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "make the failing test pass" },
  ],
  step: 0,
  tokensUsed: 0,
  nextSeq: 1,
  failures: null,
  nudged: false,
  pending: null,
  ...over,
});

const ev = (seq: number, body: Record<string, unknown> = { type: "status", status: "running" }) =>
  ({ ...body, seq, ts: 1, sessionId: "s1" }) as AgentEvent;

function fresh() {
  const db = nodeSql();
  return { db, store: new SessionStore(db.sql) };
}

describe("SessionStore (ADR D8)", () => {
  it("reads on an empty store create nothing", () => {
    const { db, store } = fresh();
    expect(store.exists()).toBe(false);
    expect(store.meta()).toBeNull();
    expect(store.loadState()).toBeNull();
    expect(store.eventsAfter(0)).toEqual([]);
    expect(store.changes()).toEqual([]);
    expect(db.tables()).toEqual([]);
  });

  it("round-trips meta, transcript, counters and the pending approval across saves", () => {
    const { db, store } = fresh();
    store.create(meta, state());
    expect(store.exists()).toBe(true);
    expect(store.meta()).toEqual(meta);
    expect(store.loadState()).toEqual(state());
    expect(db.tables().sort()).toEqual(["changes", "events", "messages", "pending_approval", "session"]);

    const call = { id: "call_1", type: "function" as const, function: { name: "finish", arguments: '{"summary":"done"}' } };
    const later = state({
      status: "awaiting_approval",
      step: 3,
      tokensUsed: 1234,
      nextSeq: 20,
      failures: { tool: "read_file", count: 2 },
      nudged: true,
      messages: [
        ...state().messages,
        { role: "assistant", content: null, tool_calls: [call] },
      ],
      pending: {
        kind: "tool",
        approvalId: "a1",
        reason: "finishing requires approval",
        call,
        remaining: [],
        summary: "done",
        diffSummary: { files: [{ path: "src/sum.js", additions: 1, deletions: 1 }] },
      },
    });
    store.saveState(later, 2000);
    store.saveState(later, 2000); // saving twice must not duplicate transcript rows
    expect(new SessionStore(db.sql).loadState()).toEqual(later);
    expect(store.meta()).toEqual({ ...meta, updated_at: 2000 });

    const resolved = state({ ...later, status: "done", pending: null, nextSeq: 22 });
    store.saveState(resolved, 3000);
    expect(store.loadState()).toEqual(resolved);
  });

  it("returns events after a seq, in order, and never stores message_delta", () => {
    const { store } = fresh();
    store.create(meta, state());
    store.appendEvent(ev(1, { type: "message", id: "m0", role: "user", text: "hi" }));
    store.appendEvent(ev(2, { type: "message_delta", id: "m1", text: "Run" }));
    store.appendEvent(ev(3));
    store.appendEvent(ev(7, { type: "status", status: "done" }));
    expect(store.eventsAfter(0).map((e) => e.seq)).toEqual([1, 3, 7]);
    expect(store.eventsAfter(1).map((e) => e.seq)).toEqual([3, 7]);
    expect(store.eventsAfter(7)).toEqual([]);
    expect(store.eventsAfter(0)[0]).toEqual(ev(1, { type: "message", id: "m0", role: "user", text: "hi" }));
  });

  it("next_seq never collides with stored events", () => {
    const { db, store } = fresh();
    store.create(meta, state());
    store.saveState(state({ nextSeq: 5 }), 2000);
    // The DO died after writing these events and before the next checkpoint.
    for (const seq of [5, 6, 7, 8]) store.appendEvent(ev(seq));
    expect(new SessionStore(db.sql).loadState()!.nextSeq).toBe(9);
  });

  it("caps oversized event payloads", () => {
    const { store } = fresh();
    store.create(meta, state());
    const diff = "+x\n".repeat(400_000); // 1.2 MB
    store.appendEvent(ev(1, { type: "file_changed", path: "big.txt", diff }));
    const stored = store.eventsAfter(0)[0]!;
    if (stored.type !== "file_changed") throw new Error("wrong event");
    expect(stored.path).toBe("big.txt");
    expect(stored.diff.length).toBeLessThanOrEqual(260_000);
    expect(stored.diff).toMatch(/elided/);
    expect(stored.diff.startsWith("+x\n")).toBe(true);
  });

  it("stores, replaces and removes changes", () => {
    const { store } = fresh();
    store.create(meta, state());
    const a = { path: "src/sum.js", beforeSha: "a".repeat(40), afterSha: "b".repeat(40), content: "new\n", deleted: false, skipped: false };
    store.putChange(a);
    store.putChange({ ...a, afterSha: "c".repeat(40), content: "newer\n" });
    store.putChange({ path: "old.txt", beforeSha: "d".repeat(40), afterSha: null, content: null, deleted: true, skipped: false });
    store.putChange({ path: "big.bin", beforeSha: null, afterSha: "e".repeat(40), content: null, deleted: false, skipped: true });
    expect(store.changes()).toEqual([
      { path: "big.bin", beforeSha: null, afterSha: "e".repeat(40), content: null, deleted: false, skipped: true },
      { path: "old.txt", beforeSha: "d".repeat(40), afterSha: null, content: null, deleted: true, skipped: false },
      { ...a, afterSha: "c".repeat(40), content: "newer\n" },
    ]);
    store.removeChange("old.txt");
    expect(store.changes().map((c) => c.path)).toEqual(["big.bin", "src/sum.js"]);
  });
});
