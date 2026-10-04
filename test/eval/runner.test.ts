import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCases, runEval, type EvalResult } from "../../eval/run";
import { defaultConfig } from "../../src/core/config";
import { REPO_CONTEXT_HEADER } from "../../src/core/repo-context";
import { ScriptedModelClient, call } from "../support/scripted-model";

const ROOT = join(import.meta.dirname, "../..");
const FIX_THE_TEST = ["cli-flag", "empty-array", "multi-file", "slugify", "sum-off-by-one"];
const ALL_CASES = [...FIX_THE_TEST, "add-tests", "discuss-first", "feature-clamp", "refactor-format", "review-clean", "review-slugify", "static-page", "task-page"].sort();
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
    call("run_command", { command: "rm -rf tmp-nothing" }),
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
    expect(cases.map((c) => c.id).sort()).toEqual(ALL_CASES);
    for (const c of cases) {
      // The review case (Phase 4) is checked in the S20 describe below, the cases of HI-i in the last one.
      if (FIX_THE_TEST.includes(c.id)) expect(c).toMatchObject({ check: { cmd: "npm test", expect_exit: 0 }, forbid_changes: ["test/**", "package.json"] });
      if (c.mode !== "task") expect(existsSync(join(FIXTURES, c.fixture!))).toBe(true);
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
    expect(bad.auto_approved).toBe(1); // only the finish gate: Code mode asks for no command (HI-j)

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

describe("HI-i: cases beyond 'fix the test'", () => {
  const finish = () => call("finish", { summary: "Done." });
  const write = (path: string, content: string) => call("write_file", { path, content });

  const FORMAT_JS = [
    "export function formatPrice(amount) {",
    '  return "$" + amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });',
    "}",
    "",
  ].join("\n");
  const REPORT_JS = [
    'import { formatPrice } from "./format.js";',
    "",
    "export function invoiceLine(item) {",
    "  return `${item.name} x${item.quantity}: ${formatPrice(item.price * item.quantity)}`;",
    "}",
    "",
    "export function invoiceTotal(items) {",
    "  return `Total: ${formatPrice(items.reduce((sum, item) => sum + item.price * item.quantity, 0))}`;",
    "}",
    "",
  ].join("\n");
  const RANGE_TEST = [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { range } from "../src/range.js";',
    "",
    'test("range", () => {',
    "  assert.deepEqual(range(0, 3), [0, 1, 2]);",
    "  assert.deepEqual(range(3, 0, -1), [3, 2, 1]);",
    "  assert.deepEqual(range(2, 2), []);",
    "  assert.throws(() => range(0, 1, 0), RangeError);",
    "});",
    "",
  ].join("\n");
  const page = (body: string) => `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Tide Tables</title></head>\n<body>\n${body}\n</body>\n</html>\n`;

  /** A correct change for each new Code case. */
  const CORRECT: Record<string, () => ScriptedModelClient> = {
    "feature-clamp": () =>
      new ScriptedModelClient([
        call("read_file", { path: "src/math.js" }),
        call("run_command", { command: "printf '\\nexport function clamp(value, min, max) {\\n  return Math.min(Math.max(value, min), max);\\n}\\n' >> src/math.js" }),
        call("run_command", { command: "npm test" }),
        finish(),
      ]),
    "refactor-format": () => new ScriptedModelClient([write("src/format.js", FORMAT_JS), write("src/report.js", REPORT_JS), call("run_command", { command: "npm test" }), finish()]),
    "add-tests": () => new ScriptedModelClient([write("test/range.test.js", RANGE_TEST), call("run_command", { command: "npm test" }), finish()]),
    "static-page": () =>
      new ScriptedModelClient([
        call("run_command", { command: "mkdir -p site" }),
        write("site/index.html", page('<h1>Tide Tables</h1>\n<p>High and low water, day by day.</p>\n<a href="about.html">About</a>')),
        write("site/about.html", page('<h1>About</h1>\n<a href="index.html">Back</a>')),
        finish(),
      ]),
  };

  async function evalRuns(caseId: string, scripts: (() => ScriptedModelClient)[], over: Record<string, unknown> = {}) {
    const [found] = await loadCases(CASES, caseId);
    const outDir = mkdtempSync(join(tmpdir(), "andrun-eval-"));
    dirs.push(outDir);
    const models: ScriptedModelClient[] = [];
    const results = await runEval({
      cases: [{ ...found!, ...over }],
      runs: scripts.length,
      makeModel: (_c, run) => {
        const model = scripts[run - 1]!();
        models.push(model);
        return model;
      },
      outDir,
      fixturesDir: FIXTURES,
      config: defaultConfig,
    });
    return { results, models };
  }

  it("scores feature, refactor, add-tests, static-page and clean-review cases", async () => {
    const cases = await loadCases(CASES);
    expect(cases.map((c) => c.id).sort()).toEqual(ALL_CASES);
    expect(cases).toHaveLength(12);
    expect(cases.find((c) => c.id === "add-tests")).toMatchObject({ mode: "code", expect_changes: ["test/**"], forbid_changes: ["src/**", "package.json"] });
    expect(cases.find((c) => c.id === "review-clean")).toMatchObject({ mode: "review", expect_no_findings: true });
    expect(cases.find((c) => c.id === "static-page")!.max_steps).toBeUndefined();

    // Every new Code case fails on the untouched fixture and passes on a correct change.
    for (const id of Object.keys(CORRECT)) {
      const { results, models } = await evalRuns(id, [() => new ScriptedModelClient([finish()]), CORRECT[id]!]);
      expect(results.map((r) => r.pass), id).toEqual([false, true]);
      expect(results[1], id).toMatchObject({ outcome: "finished", edited_tests: false, tool_errors: 0 });
      // The eval run starts from the same repo context as a session (HI-e).
      const first = models[1]!.requests[0]!.messages;
      expect(first.map((m) => m.role), id).toEqual(["system", "user", "user"]);
      expect(first[2]!.content!.startsWith(REPO_CONTEXT_HEADER), id).toBe(true);
    }

    // The static page case has no package.json: adding one fails the run.
    const added = await evalRuns("static-page", [
      () =>
        new ScriptedModelClient([
          call("run_command", { command: "mkdir -p site" }),
          write("site/index.html", page('<h1>Tide Tables</h1>\n<a href="about.html">About</a>')),
          write("site/about.html", page('<a href="index.html">Back</a>')),
          write("package.json", '{ "name": "site", "scripts": { "test": "vitest" } }\n'),
          finish(),
        ]),
    ]);
    expect(added.results[0]).toMatchObject({ pass: false, changed_files: expect.arrayContaining(["package.json"]) as string[] });

    // expect_changes: a change that passes the check is still a fail when no file matches a glob.
    const patch = call("apply_patch", { patch: FIX_PATCH });
    const withTest = await evalRuns(
      "sum-off-by-one",
      [
        () => new ScriptedModelClient([patch, finish()]),
        () => new ScriptedModelClient([patch, write("test/empty.test.js", 'import { test } from "node:test";\ntest("ok", () => {});\n'), finish()]),
      ],
      { expect_changes: ["test/**"], forbid_changes: ["package.json"] },
    );
    expect(withTest.results.map((r) => r.pass)).toEqual([false, true]);
    expect(withTest.results[0]).toMatchObject({ outcome: "finished", changed_files: ["src/sum.js"] });

    // The clean review passes with no findings and fails with one.
    const review = await evalRuns("review-clean", [
      () => new ScriptedModelClient([call("read_file", { path: "src/chunk.js" }), call("run_command", { command: "npm test" }), call("finish", { summary: "No problems found." })]),
      () => new ScriptedModelClient([call("report_finding", { path: "src/chunk.js", line: 5, severity: "low", text: "Could use a while loop." }), call("finish", { summary: "One finding." })]),
    ]);
    expect(review.results.map((r) => r.pass)).toEqual([true, false]);
    expect(review.results[0]).toMatchObject({ outcome: "finished", changed_files: [] });
  });

  it("all cases load", async () => {
    const cases = await loadCases(CASES);
    expect(cases).toHaveLength(12);
    const discuss = cases.find((c) => c.id === "discuss-first")!;
    expect(discuss).toMatchObject({ mode: "code", expect_reply: true, task: "I want to add a small game to this repo. What would you suggest?" });
    expect(discuss.check).toBeUndefined();
    expect(existsSync(join(FIXTURES, discuss.fixture))).toBe(true);
  });

  it("runs that end waiting for the user are scored", async () => {
    const patch = call("apply_patch", { patch: FIX_PATCH });
    const QUESTION = { question: "Which fix?", options: [{ label: "Loop bound" }, { label: "Use reduce" }] };
    const { results, models } = await evalRuns("sum-off-by-one", [
      // (a) Ends with a reply and no finish: the check decides.
      () => new ScriptedModelClient([patch, { text: "Fixed the loop bound." }]),
      () => new ScriptedModelClient([{ text: "I would fix the loop bound. Shall I?" }]),
      // (b) Nobody is there to answer a question, so it is answered with a fixed text and the run goes on.
      () => new ScriptedModelClient([call("ask_user", QUESTION), patch, finish()]),
    ]);
    expect(results.map((r) => r.pass)).toEqual([true, false, true]);
    expect(results.map((r) => r.outcome)).toEqual(["awaiting_input", "awaiting_input", "finished"]);
    const answer = models[2]!.requests[1]!.messages.at(-1)!;
    expect(answer).toEqual({ role: "tool", tool_call_id: expect.any(String) as string, content: JSON.stringify({ answer: "No one is available to answer. Use your best judgment and continue." }) });
    expect(models[2]!.requests).toHaveLength(3);
  });

  it("expect_reply passes only a reply with no changes", async () => {
    const QUESTION = { question: "Which game?", options: [{ label: "Mental math" }, { label: "Guess the number" }] };
    const { results, models } = await evalRuns("discuss-first", [
      // (c) A reply, or a question, and nothing changed.
      () => new ScriptedModelClient([call("list_files", {}), { text: "Two ideas: mental math, or guess the number. Which one?" }]),
      () => new ScriptedModelClient([call("ask_user", QUESTION), { text: "never asked" }]),
      // (d) It built something before asking, or finished without a word.
      () => new ScriptedModelClient([write("game.js", "export const game = 1;\n"), { text: "I made a game. Like it?" }]),
      () => new ScriptedModelClient([finish()]),
    ]);
    expect(results.map((r) => r.pass)).toEqual([true, true, false, false]);
    expect(results.map((r) => r.outcome)).toEqual(["awaiting_input", "awaiting_input", "awaiting_input", "finished"]);
    expect(models[1]!.requests).toHaveLength(1); // the question is the expected ending, so it is not answered
    expect(results[2]).toMatchObject({ changed_files: ["game.js"] });

    const dir = mkdtempSync(join(tmpdir(), "andrun-cases-"));
    dirs.push(dir);
    const base = "id: bad\nfixture: slugify\ntask: do it\nforbid_changes: []\n";
    writeFileSync(join(dir, "bad.yaml"), `${base}mode: review\nexpect_no_findings: true\nexpect_reply: true\n`);
    await expect(loadCases(dir)).rejects.toThrow(/expect_reply/);
    writeFileSync(join(dir, "bad.yaml"), `${base}mode: code\nexpect_reply: yes please\n`);
    await expect(loadCases(dir)).rejects.toThrow(/expect_reply/);
    writeFileSync(join(dir, "bad.yaml"), `${base}mode: code\nexpect_reply: true\n`);
    expect(await loadCases(dir)).toHaveLength(1);
  });

  it("the new fields are validated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "andrun-cases-"));
    dirs.push(dir);
    const base = "id: bad\nfixture: slugify\ntask: do it\nforbid_changes: []\n";
    writeFileSync(join(dir, "bad.yaml"), `${base}mode: code\ncheck: { cmd: npm test, expect_exit: 0 }\nexpect_changes: src\n`);
    await expect(loadCases(dir)).rejects.toThrow(/expect_changes/);
    writeFileSync(join(dir, "bad.yaml"), `${base}mode: code\ncheck: { cmd: npm test, expect_exit: 0 }\nexpect_no_findings: true\n`);
    await expect(loadCases(dir)).rejects.toThrow(/expect_no_findings/);
    writeFileSync(join(dir, "bad.yaml"), `${base}mode: review\nexpect_no_findings: true\nexpect_finding: { path: src/slugify.js, lines: [2] }\n`);
    await expect(loadCases(dir)).rejects.toThrow(/expect_no_findings/);
    writeFileSync(join(dir, "bad.yaml"), `${base}mode: review\nexpect_no_findings: true\n`);
    expect(await loadCases(dir)).toHaveLength(1);
  });
});

it("a task case runs in an empty workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "andrun-task-case-"));
  const outDir = mkdtempSync(join(tmpdir(), "andrun-task-run-"));
  dirs.push(dir, outDir);
  const yaml = 'id: task-test\nmode: task\ntask: Make a page\ncheck:\n  cmd: "test -f index.html && git rev-list --max-parents=0 HEAD"\n  expect_exit: 0\n';
  writeFileSync(join(dir, "case.yaml"), yaml);
  const cases = await loadCases(dir);
  const model = new ScriptedModelClient([call("list_files", {}), call("write_file", { path: "index.html", content: "<h1>Done</h1>" }), { text: "Done: index.html" }]);
  const results = await runEval({ cases, runs: 1, makeModel: () => model, outDir, fixturesDir: "/does-not-exist", config: defaultConfig });
  expect(results[0]).toMatchObject({ pass: true, outcome: "awaiting_input", changed_files: ["index.html"], auto_approved: 0 });
  expect(model.requests[0]!.messages).toHaveLength(2);
  expect(model.requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", content: "" });
  for (const extra of ["fixture: something\n", "forbid_changes: []\n"]) {
    writeFileSync(join(dir, "case.yaml"), yaml + extra);
    await expect(loadCases(dir)).rejects.toThrow(/task/i);
  }
});
