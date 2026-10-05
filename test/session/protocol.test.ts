import { describe, expect, it } from "vitest";
import { MAX_TASK_CHARS } from "../../src/session/protocol";
import { parseClientFrame, titleOf } from "../../src/session/frames";

const parse = (v: unknown) => parseClientFrame(typeof v === "string" ? v : JSON.stringify(v));

describe("S15: client frames are validated", () => {
  it("parses client frames and rejects the rest", () => {
    expect(parse({ type: "approve", approvalId: "a1" })).toEqual({ ok: true, frame: { type: "approve", approvalId: "a1" } });
    expect(parse({ type: "reject", approvalId: "a1", comment: "add a test" })).toEqual({
      ok: true,
      frame: { type: "reject", approvalId: "a1", comment: "add a test" },
    });
    expect(parse({ type: "message", text: "also rename the helper" })).toEqual({
      ok: true,
      frame: { type: "message", text: "also rename the helper" },
    });
    // Unknown fields are dropped, not passed on.
    expect(parse({ type: "approve", approvalId: "a1", admin: true })).toEqual({ ok: true, frame: { type: "approve", approvalId: "a1" } });
    // The pull request title and summary the human edited: trimmed, and dropped when empty.
    expect(parse({ type: "approve", approvalId: "a1", title: "  Fix   sum ", summary: " Adds every value. \n" })).toEqual({ ok: true, frame: { type: "approve", approvalId: "a1", title: "Fix sum", summary: "Adds every value." } });
    expect(parse({ type: "approve", approvalId: "a1", title: " ", summary: "" })).toEqual({ ok: true, frame: { type: "approve", approvalId: "a1" } });
    expect(parse({ type: "approve", approvalId: "a1", title: "x".repeat(101) })).toMatchObject({ ok: false });
    expect(parse({ type: "approve", approvalId: "a1", summary: 3 })).toMatchObject({ ok: false });

    const bad: unknown[] = [
      "not json",
      "[]",
      "null",
      { type: "nope" },
      { type: "approve" },
      { type: "approve", approvalId: 7 },
      { type: "reject", approvalId: "a1" },
      { type: "reject", approvalId: "a1", comment: "   " },
      { type: "message" },
      { type: "message", text: "" },
      { type: "message", text: "x".repeat(MAX_TASK_CHARS + 1) },
    ];
    for (const v of bad) {
      const r = parse(v);
      expect(r.ok, JSON.stringify(v)).toBe(false);
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
    }
    expect(parseClientFrame(new ArrayBuffer(4)).ok).toBe(false);
    expect(parse({ type: "message", text: "x".repeat(MAX_TASK_CHARS) }).ok).toBe(true);
  });

  it("parses a stop frame", () => {
    expect(parse({ type: "stop" })).toEqual({ ok: true, frame: { type: "stop" } });
    // Unknown fields are dropped, not passed on.
    expect(parse({ type: "stop", force: true, approvalId: "a1" })).toEqual({ ok: true, frame: { type: "stop" } });
    expect(parse({ type: "stopp" }).ok).toBe(false);
  });

  it("titles are the first 80 characters of the task on one line", () => {
    expect(titleOf("make the failing test pass")).toBe("make the failing test pass");
    expect(titleOf("  fix\nthe   bug  ")).toBe("fix the bug");
    const long = "a".repeat(100);
    expect(titleOf(long)).toBe("a".repeat(80));
  });
});
