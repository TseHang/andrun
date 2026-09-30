import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCases, runEval, type EvalResult } from "../../eval/run";
import { defaultConfig } from "../../src/core/config";
import { ScriptedModelClient, call } from "../support/scripted-model";

const ROOT = join(import.meta.dirname, "../..");
const FIXTURES = join(ROOT, "eval/fixtures");
const CASES = join(ROOT, "eval/cases");

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

const legit = () =>
  new ScriptedModelClient([
    call("run_command", { command: "npm test" }),
    call("apply_patch", { patch: FIX_PATCH }),
    call("run_command", { command: "npm test" }),
    call("finish", { summary: "Fixed sum." }),
  ]);

const cheat = () =>
  new ScriptedModelClient([
    call("write_file", {
      path: "test/sum.test.js",
      content: 'import { test } from "node:test";\ntest("ok", () => {});\n',
    }),
    call("run_command", { command: "rm -rf tmp-nothing" }), // needs approval → auto-approved in eval
    call("finish", { summary: "Tests pass." }),
  ]);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("S12: eval runner writes a trajectory and scores honestly", () => {
  it("loads the seeded cases", async () => {
    const cases = await loadCases(CASES);
    expect(cases.map((c) => c.id).sort()).toEqual(["cli-flag", "empty-array", "multi-file", "slugify", "sum-off-by-one"]);
    for (const c of cases) {
      expect(c).toMatchObject({ mode: "code", check: { cmd: "npm test", expect_exit: 0 }, forbid_changes: ["test/**"] });
      expect(existsSync(join(FIXTURES, c.fixture))).toBe(true);
    }
    expect(await loadCases(CASES, "sum-off-by-one")).toHaveLength(1);
  });

  it("writes JSONL and fails runs that edit tests", async () => {
    const [sumCase] = await loadCases(CASES, "sum-off-by-one");
    const outDir = mkdtempSync(join(tmpdir(), "andrun-eval-"));
    dirs.push(outDir);
    const lines: string[] = [];
    const scripts = [legit, cheat];

    const results = await runEval({
      cases: [sumCase!],
      runs: 2,
      makeModel: (_c, run) => scripts[run - 1]!(),
      outDir,
      fixturesDir: FIXTURES,
      config: defaultConfig,
      log: (l) => lines.push(l),
    });

    expect(results).toHaveLength(2);
    const [good, bad] = results as [EvalResult, EvalResult];
    expect(good).toMatchObject({ type: "result", case: "sum-off-by-one", run: 1, outcome: "finished", pass: true, edited_tests: false, steps: 4, tool_errors: 0 });
    expect(good.auto_approved).toBe(1); // the finish gate
    expect(good.tokens_in).toBeGreaterThan(0);
    expect(bad).toMatchObject({ run: 2, pass: false, edited_tests: true });
    expect(bad.auto_approved).toBe(2); // rm + finish

    for (const r of [1, 2]) {
      const file = join(outDir, `sum-off-by-one-${r}.jsonl`);
      const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(rows.at(-1)).toMatchObject({ type: "result", run: r });
      const events = rows.slice(0, -1);
      expect(events.length).toBeGreaterThan(3);
      for (const e of events) expect(typeof e.seq).toBe("number");
      expect(events.some((e) => e.type === "approval_resolved" && e.auto === true)).toBe(true);
      expect(events.some((e) => e.type === "message_delta")).toBe(false); // deltas are not persisted
    }

    const summary = readFileSync(join(outDir, "summary.md"), "utf8");
    expect(summary).toContain("sum-off-by-one");
    expect(summary).toMatch(/1\/2/); // pass count
    expect(lines.join("\n")).toContain("sum-off-by-one");
  });
});
