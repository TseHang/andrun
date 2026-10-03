import { describe, expect, it } from "vitest";
import { parseDiff } from "../../web/src/state/diff";

const MODIFIED = [
  "diff --git a/src/sum.js b/src/sum.js",
  "index 1111111..2222222 100644",
  "--- a/src/sum.js",
  "+++ b/src/sum.js",
  "@@ -1,7 +1,7 @@",
  " export function sum(values) {",
  "   let total = 0;",
  "-  for (let i = 0; i < values.length - 1; i++) {",
  "+  for (let i = 0; i < values.length; i++) {",
  "     total += values[i];",
  "   }",
  "   return total;",
  " }",
  "@@ -20,2 +20,3 @@ export function mean(values) {",
  " const a = 1;",
  "+const b = 2;",
  " const c = 3;",
  "\\ No newline at end of file",
  "",
].join("\n");

const NEW_FILE = [
  "diff --git a/test/empty.test.js b/test/empty.test.js",
  "new file mode 100644",
  "index 0000000..e69de29",
  "--- /dev/null",
  "+++ b/test/empty.test.js",
  "@@ -0,0 +1,3 @@",
  '+import { test } from "node:test";',
  "+",
  "+test();",
  "",
].join("\n");

const DELETED = [
  "diff --git a/src/old.js b/src/old.js",
  "deleted file mode 100644",
  "index e69de29..0000000",
  "--- a/src/old.js",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-export const old = 1;",
  "-export const older = 2;",
  "",
].join("\n");

describe("diff parser (P3-g)", () => {
  it("parses hunks, new files and deletions", () => {
    const m = parseDiff(MODIFIED);
    expect(m).toMatchObject({ isNew: false, isDeleted: false, elided: false, additions: 2, deletions: 1 });
    // Headers are not lines; hunk headers are, with no numbers.
    expect(m.lines.map((l) => l.kind)).toEqual([
      "hunk", "context", "context", "del", "add", "context", "context", "context", "context",
      "hunk", "context", "add", "context",
    ]);
    expect(m.lines[1]).toEqual({ kind: "context", oldNo: 1, newNo: 1, text: "export function sum(values) {" });
    expect(m.lines[3]).toEqual({ kind: "del", oldNo: 3, newNo: null, text: "  for (let i = 0; i < values.length - 1; i++) {" });
    expect(m.lines[4]).toEqual({ kind: "add", oldNo: null, newNo: 3, text: "  for (let i = 0; i < values.length; i++) {" });
    expect(m.lines[5]).toMatchObject({ oldNo: 4, newNo: 4 });
    expect(m.lines[9]).toMatchObject({ kind: "hunk", oldNo: null, newNo: null });
    expect(m.lines[10]).toMatchObject({ oldNo: 20, newNo: 20, text: "const a = 1;" });
    expect(m.lines[11]).toMatchObject({ kind: "add", oldNo: null, newNo: 21, text: "const b = 2;" });
    expect(m.lines[12]).toMatchObject({ oldNo: 21, newNo: 22 });

    const n = parseDiff(NEW_FILE);
    expect(n).toMatchObject({ isNew: true, isDeleted: false, additions: 3, deletions: 0 });
    expect(n.lines.filter((l) => l.kind === "add").map((l) => l.newNo)).toEqual([1, 2, 3]);
    expect(n.lines[2]).toMatchObject({ kind: "add", text: "" });

    const d = parseDiff(DELETED);
    expect(d).toMatchObject({ isNew: false, isDeleted: true, additions: 0, deletions: 2 });
    expect(d.lines.filter((l) => l.kind === "del").map((l) => l.oldNo)).toEqual([1, 2]);

    expect(parseDiff("")).toMatchObject({ lines: [], additions: 0, deletions: 0, elided: false });
  });

  it("elided diff", () => {
    // What the store writes when a diff is over its row limit (src/session/store.ts).
    const cut = `${MODIFIED.slice(0, MODIFIED.indexOf("+  for") - 1)}\n[… 12345 bytes elided]`;
    const v = parseDiff(cut);
    expect(v.elided).toBe(true);
    expect(v.lines.some((l) => l.text.includes("elided"))).toBe(false);
    expect(v.lines.at(-1)).toMatchObject({ kind: "del" });
  });
});
