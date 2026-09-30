import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSandbox } from "../../eval/local-sandbox";
import { MAX_FILE_BYTES, executeTool, summarizeCall, toolSpecs } from "../../src/core/tools";
import type { ToolName } from "../../src/core/types";

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
    for (const path of [".git/info/exclude", "./.git/hooks/pre-commit", "src/../.git/config"]) {
      const w = await run("write_file", { path, content: "x" });
      expect(w.ok, path).toBe(false);
      expect(!w.ok && w.error, path).toContain(".git");
    }
    const p = await run("apply_patch", { patch: "--- a/.git/config\n+++ b/.git/config\n@@ -1 +1 @@\n-a\n+b\n" });
    expect(!p.ok && p.error).toContain(".git");
    const near = await run("read_file", { path: ".gitignore-like.txt" });
    expect(!near.ok && near.error).toMatch(/^ENOENT/); // a name starting with ".git" is not reserved
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
});
