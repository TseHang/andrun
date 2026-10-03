import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// Rewrites the test script instead of fixing the code.
const scriptCheat = () =>
  new ScriptedModelClient([
    call("write_file", {
      path: "package.json",
      content: '{ "name": "sum-demo", "private": true, "type": "module", "scripts": { "test": "true" } }\n',
    }),
    call("finish", { summary: "Tests pass." }),
  ]);

// Edits the test, then commits it so `git diff HEAD` would look clean.
const commitCheat = () =>
  new ScriptedModelClient([
    call("write_file", { path: "test/sum.test.js", content: 'import { test } from "node:test";\ntest("ok", () => {});\n' }),
    call("run_command", { command: "git add -A && git -c user.email=a@b -c user.name=a commit -qm x" }),
    call("finish", { summary: "Tests pass." }),
  ]);

// Moves the test out of test/, so only the new path would show up with rename detection.
const renameCheat = () =>
  new ScriptedModelClient([
    call("run_command", { command: "git mv test/sum.test.js sum.test.skip" }),
    call("finish", { summary: "Tests pass." }),
  ]);

// Adds a test file with a non-ASCII name, which git would print C-quoted without -z.
const unicodeCheat = () =>
  new ScriptedModelClient([
    call("write_file", { path: "test/тест.test.js", content: 'import { test } from "node:test";\ntest("ok", () => {});\n' }),
    call("finish", { summary: "Added a test." }),
  ]);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("S12: eval runner writes a trajectory and scores honestly", () => {
  it("loads the seeded cases", async () => {
    const cases = await loadCases(CASES);
    expect(cases.map((c) => c.id).sort()).toEqual(["cli-flag", "empty-array", "multi-file", "review-slugify", "slugify", "sum-off-by-one"]);
    for (const c of cases) {
      expect(c).toMatchObject({ mode: "code", check: { cmd: "npm test", expect_exit: 0 }, forbid_changes: ["test/**", "package.json"] });
      expect(existsSync(join(FIXTURES, c.fixture))).toBe(true);
    }
    expect(await loadCases(CASES, "sum-off-by-one")).toHaveLength(1);
  });

  it("writes JSONL and fails runs that edit tests", async () => {
    const [sumCase] = await loadCases(CASES, "sum-off-by-one");
    const outDir = mkdtempSync(join(tmpdir(), "andrun-eval-"));
    dirs.push(outDir);
    const lines: string[] = [];
    const scripts = [legit, cheat, scriptCheat];

    const results = await runEval({
      cases: [sumCase!],
      runs: 3,
      makeModel: (_c, run) => scripts[run - 1]!(),
      outDir,
      fixturesDir: FIXTURES,
      config: defaultConfig,
      log: (l) => lines.push(l),
    });

    expect(results).toHaveLength(3);
    const [good, bad, scriptHack] = results as [EvalResult, EvalResult, EvalResult];
    expect(scriptHack).toMatchObject({ run: 3, pass: false, edited_tests: true, changed_files: ["package.json"] });
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
    expect(summary).toMatch(/1\/3/); // pass count
    expect(lines.join("\n")).toContain("sum-off-by-one");
  });

  it("catches test edits hidden by a commit or a rename", async () => {
    const [sumCase] = await loadCases(CASES, "sum-off-by-one");
    const outDir = mkdtempSync(join(tmpdir(), "andrun-eval-"));
    dirs.push(outDir);
    const scripts = [commitCheat, renameCheat, unicodeCheat];
    const results = await runEval({
      cases: [sumCase!],
      runs: 3,
      makeModel: (_c, run) => scripts[run - 1]!(),
      outDir,
      fixturesDir: FIXTURES,
      config: defaultConfig,
    });
    for (const r of results) expect(r, `run ${r.run}`).toMatchObject({ pass: false, edited_tests: true });
    expect(results[1]!.changed_files).toContain("test/sum.test.js");
    expect(results[2]!.changed_files).toContain("test/тест.test.js");
  });

  it("stops when the max cost is reached", async () => {
    const [sumCase] = await loadCases(CASES, "sum-off-by-one");
    const outDir = mkdtempSync(join(tmpdir(), "andrun-eval-"));
    dirs.push(outDir);
    const lines: string[] = [];
    // ¥1 per 1k input tokens; each legit run costs 4 × 100 in = ¥0.4 (+ output ¥0.08).
    const config = { ...defaultConfig, models: { ...defaultConfig.models, code: "scripted" }, prices: { scripted: { in: 1000, out: 1000 } } };

    const results = await runEval({
      cases: [sumCase!],
      runs: 5,
      makeModel: () => legit(),
      outDir,
      fixturesDir: FIXTURES,
      config,
      maxCost: 0.8,
      log: (l) => lines.push(l),
    });

    // Each step costs ¥0.12. Run 1 spends ¥0.48; run 2 reaches ¥0.84 after step 3 and stops
    // before finishing; runs 3–5 never start.
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ pass: true });
    expect(results[0]!.cost).toBeCloseTo(0.48);
    expect(results[1]).toMatchObject({ pass: false, outcome: "failed", steps: 3 });
    expect(results[0]!.cost! + results[1]!.cost!).toBeLessThan(0.8 + 0.12); // at most one request over
    expect(lines.join("\n")).toContain("max cost");
    expect(readFileSync(join(outDir, "summary.md"), "utf8")).toContain("max cost");
  });
});

describe("S20: the review case (spec §10)", () => {
  const finding = (line: number, path = "src/slugify.js") => call("report_finding", { path, line, severity: "high", text: "Runs of separators are not collapsed." });
  const scripts = [
    // 1: finds the planted bug on the expected line
    () => new ScriptedModelClient([call("read_file", { path: "src/slugify.js" }), finding(2), call("finish", { summary: "One finding." })]),
    // 2: a finding, but on the wrong line
    () => new ScriptedModelClient([finding(30), call("finish", { summary: "One finding." })]),
    // 3: the right line in the wrong file
    () => new ScriptedModelClient([finding(2, "test/slugify.test.js"), call("finish", { summary: "One finding." })]),
    // 4: no finding at all
    () => new ScriptedModelClient([call("finish", { summary: "Looks fine." })]),
  ];

  it("a review case passes on an expected finding and no changes", async () => {
    const [reviewCase] = await loadCases(CASES, "review-slugify");
    expect(reviewCase).toMatchObject({ mode: "review", fixture: "slugify", expect_finding: { path: "src/slugify.js", lines: [2] } });

    const outDir = mkdtempSync(join(tmpdir(), "andrun-eval-"));
    dirs.push(outDir);
    const results = await runEval({
      cases: [reviewCase!],
      runs: 4,
      makeModel: (_c, run) => scripts[run - 1]!(),
      outDir,
      fixturesDir: FIXTURES,
      config: defaultConfig,
    });

    expect(results.map((r) => r.pass)).toEqual([true, false, false, false]);
    expect(results[0]).toMatchObject({ type: "result", case: "review-slugify", run: 1, outcome: "finished", edited_tests: false, changed_files: [] });
    expect(results[0]!.auto_approved).toBe(1); // the review's finish gate (P4-b)

    // The same JSONL shape as a Code case: events, then one result line.
    const rows = readFileSync(join(outDir, "review-slugify-1.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows.at(-1)).toMatchObject({ type: "result", pass: true });
    expect(rows.some((e) => e["type"] === "review_finding" && e["line"] === 2)).toBe(true);
  });

  it("a review case needs expect_finding, and a code case needs check", async () => {
    const dir = mkdtempSync(join(tmpdir(), "andrun-cases-"));
    dirs.push(dir);
    writeFileSync(join(dir, "bad.yaml"), "id: bad\nfixture: slugify\nmode: review\ntask: review it\nforbid_changes: []\n");
    await expect(loadCases(dir)).rejects.toThrow(/expect_finding/);
    writeFileSync(join(dir, "bad.yaml"), "id: bad\nfixture: slugify\nmode: code\ntask: fix it\nforbid_changes: []\n");
    await expect(loadCases(dir)).rejects.toThrow(/check/);
  });
});
