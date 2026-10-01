import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../src/core/events";
import { OutputCoalescer } from "../../src/session/coalesce";

let seq = 0;
const envelope = () => ({ seq: ++seq, ts: Date.now(), sessionId: "s1", stepId: "s1" });
const out = (chunk: string, stream: "stdout" | "stderr" = "stdout", callId = "c1"): AgentEvent => ({
  type: "tool_output",
  callId,
  stream,
  chunk,
  ...envelope(),
});
const result = (callId = "c1"): AgentEvent => ({
  type: "tool_output",
  callId,
  stream: "result",
  chunk: "exit code 0",
  exitCode: 0,
  ...envelope(),
});

function setup() {
  const sunk: AgentEvent[] = [];
  const coalescer = new OutputCoalescer({ windowMs: 250, sink: (e) => sunk.push(e) });
  return { sunk, coalescer };
}

beforeEach(() => {
  seq = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("S5: command output is coalesced and stays in order", () => {
  it("merges chunks within 250 ms and flushes before any other event", () => {
    const { sunk, coalescer } = setup();
    coalescer.push({ type: "tool_call", callId: "c1", name: "run_command", args: {}, summary: "Run npm test", ...envelope() });
    expect(sunk).toHaveLength(1); // other events pass straight through

    const chunks: string[] = [];
    for (let i = 0; i < 40; i++) {
      chunks.push(`line ${i}\n`);
      coalescer.push(out(chunks[i]!));
      vi.advanceTimersByTime(25);
    }
    const lastChunkSeq = seq;
    const final = result();
    coalescer.push(final);

    const stdout = sunk.filter((e) => e.type === "tool_output" && e.stream === "stdout");
    expect(stdout.length).toBeGreaterThan(0);
    expect(stdout.length).toBeLessThanOrEqual(5);
    expect(stdout.map((e) => (e.type === "tool_output" ? e.chunk : "")).join("")).toBe(chunks.join(""));
    // A merged row carries the seq of its last part, so replay from any lastSeq loses nothing.
    expect(stdout.at(-1)!.seq).toBe(lastChunkSeq);
    expect(sunk.at(-1)).toEqual(final);
    for (const e of stdout) expect(e.seq).toBeLessThan(final.seq);
    const seqs = sunk.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("flushes on the timer when nothing else arrives", () => {
    const { sunk, coalescer } = setup();
    coalescer.push(out("a"));
    coalescer.push(out("b"));
    expect(sunk).toHaveLength(0);
    vi.advanceTimersByTime(250);
    expect(sunk).toHaveLength(1);
    expect(sunk[0]).toMatchObject({ type: "tool_output", stream: "stdout", chunk: "ab", seq: 2 });
  });

  it("does not merge across streams or calls, and keeps their order", () => {
    const { sunk, coalescer } = setup();
    coalescer.push(out("a"));
    coalescer.push(out("b", "stderr"));
    coalescer.push(out("c"));
    coalescer.push(out("d", "stdout", "c2"));
    coalescer.flush();
    expect(sunk.map((e) => (e.type === "tool_output" ? `${e.callId}:${e.stream}:${e.chunk}` : ""))).toEqual([
      "c1:stdout:a",
      "c1:stderr:b",
      "c1:stdout:c",
      "c2:stdout:d",
    ]);
  });

  it("flush with nothing buffered does nothing, and no timer fires afterwards", () => {
    const { sunk, coalescer } = setup();
    coalescer.push(out("a"));
    coalescer.flush();
    coalescer.flush();
    vi.advanceTimersByTime(1000);
    expect(sunk).toHaveLength(1);
  });
});
