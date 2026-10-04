import { describe, expect, it } from "vitest";
import { commentableLines, numberedPatch } from "../../src/github";

const PATCH = [
  "@@ -1,4 +1,5 @@",
  " export function slugify(text) {",
  "-  return text.trim();",
  "+  return text",
  "+    .toLowerCase();",
  " }",
  " ",
  "@@ -20,2 +21,3 @@ function tail() {",
  " const a = 1;",
  "+const b = 2;",
  " const c = 3;",
].join("\n");

describe("diff lines (D9: comments must be on a diff line)", () => {
  it("only added and context lines on the right side can take a comment", () => {
    expect([...commentableLines(PATCH)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 21, 22, 23]);
    expect(commentableLines("@@ -1,2 +0,0 @@\n-a\n-b").size).toBe(0); // a deleted file
  });

  it("a file without a patch has no commentable lines", () => {
    expect(commentableLines(null).size).toBe(0);
    expect(commentableLines(undefined).size).toBe(0);
    expect(numberedPatch(null)).toBe("");
  });

  it("numbers each line with its line in the new file", () => {
    const lines = numberedPatch(PATCH).split("\n");
    expect(lines.find((l) => l.includes("return text") && !l.includes("trim"))).toMatch(/^\s*2\s+\+\s{2}return text$/);
    expect(lines.find((l) => l.includes(".toLowerCase()"))).toMatch(/^\s*3\s+\+/);
    expect(lines.find((l) => l.includes("const b = 2;"))).toMatch(/^\s*22\s+\+/);
    expect(lines.find((l) => l.includes("const c = 3;"))).toMatch(/^\s*23\s/);
    const removed = lines.find((l) => l.includes("text.trim()"))!;
    expect(removed).toMatch(/^\s+-/); // a removed line has no number
    expect(removed).not.toMatch(/\d/);
  });
});
