import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSandbox } from "../../eval/local-sandbox";
import { MAX_FILE_BYTES, executeTool, summarizeCall, toolSpecs } from "../../src/core/tools";
import { SandboxLostError, type SandboxAdapter, type ToolName } from "../../src/core/types";

const FIXTURE = join(import.meta.dirname, "../../eval/fixtures/sum-off-by-one");
const CODE_TOOLS: ToolName[] = ["list_files", "read_file", "write_file", "apply_patch", "run_command", "finish"];

let sandbox: LocalSandbox;
beforeEach(async () => {
  sandbox = await LocalSandbox.fromFixture(FIXTURE);
});
afterEach(async () => {
  await sandbox.destroy();
});

const run = (name: string, args: unknown, allowed: ToolName[] = CODE_TOOLS) =>
  executeTool(
    { name, rawArgs: typeof args === "string" ? args : JSON.stringify(args) },
    { sandbox, allowed, timeoutMs: 30_000 },
  );

describe("tools", () => {
  it("reads, lists, writes and runs commands", async () => {
    const list = await run("list_files", {});
    expect(list.ok && list.output).toContain("src/sum.js");
    expect(list.ok && list.output).not.toContain(".git/");

    const read = await run("read_file", { path: "src/sum.js" });
    expect(read.ok && read.output).toContain("values.length - 1");

    const write = await run("write_file", { path: "src/new.js", content: "export const x = 1;\n" });
    expect(write).toMatchObject({ ok: true, changedPaths: ["src/new.js"] });

    const test = await run("run_command", { command: "node --test" });
    expect(test).toMatchObject({ ok: true, exitCode: 1 });
  });

  it("failed patch returns stderr", async () => {
    const bad = `--- a/src/sum.js\n+++ b/src/sum.js\n@@ -1,1 +1,1 @@\n-this line does not exist\n+nope\n`;
    const r = await run("apply_patch", { patch: bad });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/patch/i);
    expect(!r.ok && r.error.length).toBeGreaterThan(20);
  });

  it("applies a valid patch and reports changed paths", async () => {
    const patch = [
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
    const r = await run("apply_patch", { patch });
    expect(r).toMatchObject({ ok: true, changedPaths: ["src/sum.js"] });
    expect(await sandbox.readFile("src/sum.js")).toContain("i < values.length;");
  });

  it("tolerates a missing final newline and wrong hunk header (seen from deepseek-v4-flash)", async () => {
    // Real model output: header starts at line 2 instead of 1, and no trailing newline.
    const sloppy = [
      "--- a/src/sum.js",
      "+++ b/src/sum.js",
      "@@ -2,7 +2,7 @@",
      " export function sum(values) {",
      "   let total = 0;",
      "-  for (let i = 0; i < values.length - 1; i++) {",
      "+  for (let i = 0; i < values.length; i++) {",
      "     total += values[i];",
      "   }",
      "   return total;",
      " }",
    ].join("\n");
    const r = await run("apply_patch", { patch: sloppy });
    expect(r).toMatchObject({ ok: true, changedPaths: ["src/sum.js"] });
    expect(await sandbox.readFile("src/sum.js")).toContain("i < values.length;");
  });

  it("rejects paths outside workspace", async () => {
    for (const path of ["../../etc/passwd", "/etc/passwd", "src/../../x", "a\0b"]) {
      const r = await run("read_file", { path });
      expect(r.ok, path).toBe(false);
      expect(!r.ok && r.error, path).toContain("outside workspace");
      const w = await run("write_file", { path, content: "x" });
      expect(w.ok, path).toBe(false);
    }
    const p = await run("apply_patch", { patch: "--- a/../x\n+++ b/../x\n@@ -0,0 +1 @@\n+x\n" });
    expect(!p.ok && p.error).toContain("outside workspace");
    // Normalized paths inside the workspace are fine.
    expect((await run("read_file", { path: "./src/../src/sum.js" })).ok).toBe(true);
  });

  it("rejects writes into .git so the approval diff can't be tampered with", async () => {
    for (const path of [".git/info/exclude", "./.git/hooks/pre-commit", "src/../.git/config", ".GIT/config", ".Git/hooks/pre-commit", "sub/.git/HEAD", "sub/.GIT/config"]) {
      const w = await run("write_file", { path, content: "x" });
      expect(w.ok, path).toBe(false);
      expect(!w.ok && w.error, path).toContain(".git");
    }
    const p = await run("apply_patch", { patch: "--- a/.git/config\n+++ b/.git/config\n@@ -1 +1 @@\n-a\n+b\n" });
    expect(!p.ok && p.error).toContain(".git");
    const near = await run("read_file", { path: ".gitignore-like.txt" });
    expect(!near.ok && near.error).toMatch(/^ENOENT/); // a name starting with ".git" is not reserved
  });

  it("a miscounted hunk cannot smuggle a second file's deletion past the parser", async () => {
    // The first hunk claims 3 lines but has 2, so the next file header would sit inside it.
    const smuggle = [
      "--- a/src/sum.js",
      "+++ b/src/sum.js",
      "@@ -1,3 +1,3 @@",
      "-export function sum(values) {",
      "+export function sum(values) { // x",
      "--- a/package.json",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-{",
      "",
    ].join("\n");
    const r = await run("apply_patch", { patch: smuggle });
    expect(r.ok).toBe(false); // git (with --recount) reads the header as hunk lines, just like our parser
    expect(await sandbox.readFile("package.json")).toContain("node --test");
  });

  it("caps list_files output", async () => {
    const many = Array.from({ length: 20_000 }, (_, i) => `vendor/pkg-${i}/index.js`);
    const stub = { listFiles: async () => many } as unknown as LocalSandbox;
    const r = await executeTool({ name: "list_files", rawArgs: "{}" }, { sandbox: stub, allowed: CODE_TOOLS, timeoutMs: 1000 });
    expect(r.ok && r.output.length).toBeLessThanOrEqual(8192);
    expect(r.ok && r.output).toContain("elided");
    expect(r.ok && r.output).toContain("narrower path");
  });

  it("rejects files over 1 MB", async () => {
    const r = await run("write_file", { path: "big.txt", content: "x".repeat(MAX_FILE_BYTES + 1) });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("1 MB");
  });

  it("rejects tools not in the profile and invalid arguments", async () => {
    const r = await run("apply_patch", { patch: "" }, ["read_file", "finish"]);
    expect(r).toEqual({ ok: false, error: "unknown tool: apply_patch" });

    const bad = await run("read_file", "{not json");
    expect(!bad.ok && bad.error).toContain("invalid arguments");
    const missing = await run("read_file", {});
    expect(!missing.ok && missing.error).toContain("invalid arguments");
  });

  it("describes tools for the model and summarizes calls for the timeline", () => {
    const specs = toolSpecs(CODE_TOOLS);
    expect(specs.map((s) => s.name)).toEqual(CODE_TOOLS);
    for (const s of specs) expect(s.parameters).toMatchObject({ type: "object" });
    expect(summarizeCall("read_file", { path: "src/sum.js" })).toBe("Read src/sum.js");
    expect(summarizeCall("run_command", { command: "npm test" })).toBe("Run npm test");
  });

  describe("update_plan (HI-a)", () => {
    const PLAN_TOOLS: ToolName[] = [...CODE_TOOLS, "update_plan"];
    const plan = (args: unknown) => run("update_plan", args, PLAN_TOOLS);

    it("update_plan rejects a malformed plan", async () => {
      const good = [
        { step: "Read the code", status: "completed" },
        { step: "Make the change", status: "in_progress" },
        { step: "Run the tests", status: "pending" },
      ];
      expect(await plan({ plan: good })).toEqual({ ok: true, output: "Plan updated", plan: good });

      const cases: [unknown, RegExp][] = [
        [{ plan: "read, then fix" }, /plan/],
        [{}, /plan/],
        [{ plan: ["read the code"] }, /step/],
        [{ plan: [{ status: "pending" }] }, /step/],
        [{ plan: [{ step: "", status: "pending" }] }, /step/],
        [{ plan: [{ step: "Read the code" }] }, /status/],
        [{ plan: [{ step: "Read the code", status: "done" }] }, /status/],
      ];
      for (const [args, names] of cases) {
        const r = await plan(args);
        expect(r.ok, JSON.stringify(args)).toBe(false);
        expect(!r.ok && r.error, JSON.stringify(args)).toContain("invalid arguments");
        expect(!r.ok && r.error, JSON.stringify(args)).toMatch(names);
        expect(r).not.toHaveProperty("plan");
      }

      // Not a Review tool (S4).
      expect(await run("update_plan", { plan: good }, ["list_files", "read_file", "run_command", "report_finding", "finish"])).toEqual({ ok: false, error: "unknown tool: update_plan" });
    });

    it("update_plan does not enforce one step in progress", async () => {
      const two = [
        { step: "Write the page", status: "in_progress" },
        { step: "Write the styles", status: "in_progress" },
      ];
      expect(await plan({ plan: two })).toEqual({ ok: true, output: "Plan updated", plan: two });
      // An empty list clears the plan.
      expect(await plan({ plan: [] })).toEqual({ ok: true, output: "Plan updated", plan: [] });

      const spec = toolSpecs(["update_plan"])[0]!;
      expect(spec.description).toMatch(/at most one/i);
      expect(JSON.stringify(spec.parameters)).toContain("in_progress");
    });
  });

  describe("read_file ranges (HI-f)", () => {
    const LINES = Array.from({ length: 2000 }, (_, i) => `line ${i + 1} ${"x".repeat(20)}`);
    const BIG = `${LINES.join("\n")}\n`; // about 60 KB
    const NOTE = /\n\[lines (\d+)-(\d+) of (\d+) shown; continue with offset (\d+)\]$/;
    const body = (output: string) => output.replace(NOTE, "").replace(/\n$/, "");

    it("read_file returns whole lines with a continuation note, and honors offset and limit", async () => {
      await sandbox.writeFile("big.txt", BIG);
      const bytes = new TextEncoder().encode(BIG).length;

      const first = await run("read_file", { path: "big.txt" });
      if (!first.ok) throw new Error(first.error);
      expect(first.output.length).toBeLessThanOrEqual(8192);
      const note = NOTE.exec(first.output)!;
      expect(note, first.output.slice(-120)).not.toBeNull();
      const [from, to, total, next] = note.slice(1).map(Number) as [number, number, number, number];
      expect([from, total, next]).toEqual([1, 2000, to + 1]);
      expect(to).toBeGreaterThan(200); // most of the 8 KB is used
      expect(body(first.output)).toBe(LINES.slice(0, to).join("\n"));
      expect(first.meta).toEqual({ bytes });

      const second = await run("read_file", { path: "big.txt", offset: next });
      if (!second.ok) throw new Error(second.error);
      expect(second.output.startsWith(`${LINES[next - 1]}\n`)).toBe(true);
      const note2 = NOTE.exec(second.output)!;
      expect(Number(note2[1])).toBe(next);
      expect(Number(note2[4])).toBe(Number(note2[2]) + 1);
      expect(body(second.output)).toBe(LINES.slice(next - 1, Number(note2[2])).join("\n"));
      expect(second.meta).toEqual({ bytes });

      const third = await run("read_file", { path: "big.txt", offset: 1990, limit: 5 });
      if (!third.ok) throw new Error(third.error);
      expect(third.output.replace(/\n$/, "")).toBe(LINES.slice(1989, 1994).join("\n"));
      expect(third.meta).toEqual({ bytes });

      // The end of the file needs no note.
      const tail = await run("read_file", { path: "big.txt", offset: 1995 });
      expect(tail.ok && tail.output.replace(/\n$/, "")).toBe(LINES.slice(1994).join("\n"));

      // A limit that does not fit in 8 KB is cut at a line, with the note.
      const wide = await run("read_file", { path: "big.txt", offset: 100, limit: 1000 });
      if (!wide.ok) throw new Error(wide.error);
      expect(wide.output.length).toBeLessThanOrEqual(8192);
      expect(Number(NOTE.exec(wide.output)![1])).toBe(100);

      // A file under the cap comes back unchanged.
      const small = await run("read_file", { path: "src/sum.js" });
      expect(small.ok && small.output).toBe(await sandbox.readFile("src/sum.js"));

      const spec = toolSpecs(["read_file"])[0]!;
      expect(Object.keys((spec.parameters as { properties: Record<string, unknown> }).properties).sort()).toEqual(["limit", "offset", "path"]);
      expect((spec.parameters as { required: string[] }).required).toEqual(["path"]);
    });

    it("read_file rejects bad ranges and cuts an over-long line", async () => {
      await sandbox.writeFile("big.txt", BIG);
      const bad = [{ offset: 2001 }, { offset: 0 }, { offset: -3 }, { offset: 1.5 }, { offset: "3" }, { limit: 0 }, { limit: -1 }, { limit: 2.5 }, { limit: "10" }];
      for (const range of bad) {
        const r = await run("read_file", { path: "big.txt", ...range });
        expect(r.ok, JSON.stringify(range)).toBe(false);
        expect(!r.ok && r.error, JSON.stringify(range)).toContain("invalid arguments");
      }

      await sandbox.writeFile("long.txt", `HEAD${"x".repeat(50_000)}TAIL`);
      const long = await run("read_file", { path: "long.txt" });
      if (!long.ok) throw new Error(long.error);
      expect(long.output.length).toBeLessThanOrEqual(8192);
      expect(long.output.startsWith("HEAD")).toBe(true);
      expect(long.output).toMatch(/\[… \d+ bytes elided\]/);
    });
  });

  it("SandboxLostError is rethrown, not fed back", async () => {
    const lost: SandboxAdapter = {
      exec: () => Promise.reject(new SandboxLostError("the sandbox was lost while running the command")),
      readFile: () => Promise.reject(new SandboxLostError()),
      writeFile: (path, content) => sandbox.writeFile(path, content),
      listFiles: (dir) => sandbox.listFiles(dir),
      applyPatch: (patch) => sandbox.applyPatch(patch),
      diff: (path) => sandbox.diff(path),
    };
    const ctx = { sandbox: lost, allowed: CODE_TOOLS, timeoutMs: 30_000 };

    await expect(executeTool({ name: "run_command", rawArgs: JSON.stringify({ command: "npm test" }) }, ctx)).rejects.toBeInstanceOf(
      SandboxLostError,
    );
    await expect(executeTool({ name: "read_file", rawArgs: JSON.stringify({ path: "src/sum.js" }) }, ctx)).rejects.toThrow(/sandbox/i);
    // Ordinary failures are still tool results the model can react to.
    expect(await run("read_file", { path: "missing.js" })).toMatchObject({ ok: false });
  });
});
