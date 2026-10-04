// Eval harness (ADR D12): seeded cases through the real agent loop with LocalSandbox.
// Writes one JSONL trajectory per run (§5 events + a final result line) and a summary table.
// A case (eval/cases/*.yaml) has id, fixture, mode, task, forbid_changes and optional max_steps, plus:
//   code case:   check { cmd, expect_exit }, which must exit as expected after the run.
//   review case: exactly one of expect_finding { path, lines } (a review_finding on that path and one of
//                those lines, spec §10) or expect_no_findings: true (no review_finding at all);
//                no file may change; check is optional.
// Either mode may not use the other's fields; code cases may add:
//   expect_changes: a list of globs; for every glob at least one changed file must match it.
//   expect_reply: true, for a task the agent should discuss, not do: the run passes only if it ends waiting for
//                 the user (a reply or a question, which is not answered) with no file changed; check is not needed.
// Without expect_reply, a question from the agent is answered with a fixed text, and a run that ends with a reply passes
// on the same conditions as one that finishes.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import picomatch from "picomatch";
import { parse } from "yaml";
import { createSession, resume, runAgent } from "../src/core/agent";
import { defaultConfig, type AgentConfig } from "../src/core/config";
import { getProfile } from "../src/core/modes";
import { OpenAICompatModelClient } from "../src/core/model";
import { buildRepoContext } from "../src/core/repo-context";
import { autoApprove } from "../src/core/policy";
import type { AgentDeps, ModelClient, RunOutcome } from "../src/core/types";
import { LocalSandbox } from "./local-sandbox";

export interface EvalCase {
  id: string;
  fixture: string;
  mode: "code" | "review";
  task: string;
  check?: { cmd: string; expect_exit: number };
  expect_finding?: { path: string; lines: number[] };
  expect_changes?: string[];
  expect_no_findings?: boolean;
  expect_reply?: boolean;
  forbid_changes: string[];
  max_steps?: number;
}

export interface EvalResult {
  type: "result";
  case: string;
  run: number;
  outcome: RunOutcome["kind"];
  pass: boolean;
  steps: number;
  tokens_in: number;
  tokens_out: number;
  cost: number | null;
  tool_errors: number;
  edited_tests: boolean;
  auto_approved: number;
  changed_files: string[];
  duration_ms: number;
}

const MAX_AUTO_RESUMES = 5;
const NO_ONE_TEXT = "No one is available to answer. Use your best judgment and continue.";
/** For cases without `max_steps`, when run from the command line. The slowest passing run so far took 10 steps. */
const EVAL_MAX_STEPS = 40;

// ---------- Cases ----------

function invalid(file: string, why: string): Error {
  return new Error(`invalid eval case ${file}: ${why}`);
}

function validateCase(file: string, raw: unknown): EvalCase {
  if (!raw || typeof raw !== "object") throw invalid(file, "expected a YAML mapping");
  const c = raw as Record<string, unknown>;
  for (const key of ["id", "fixture", "task"]) {
    if (typeof c[key] !== "string" || !c[key]) throw invalid(file, `"${key}" must be a non-empty string`);
  }
  if (c["mode"] !== "code" && c["mode"] !== "review") throw invalid(file, `"mode" must be "code" or "review"`);
  if (c["expect_reply"] !== undefined) {
    if (c["mode"] !== "code") throw invalid(file, `"expect_reply" is only for code cases`);
    if (c["expect_reply"] !== true) throw invalid(file, `"expect_reply" must be true`);
  }
  const check = c["check"] as Record<string, unknown> | null | undefined;
  if (check === undefined || check === null ? c["mode"] === "code" && c["expect_reply"] !== true : typeof check["cmd"] !== "string" || typeof check["expect_exit"] !== "number") {
    throw invalid(file, `"check" needs a string "cmd" and a number "expect_exit"`);
  }
  const expect = c["expect_finding"] as Record<string, unknown> | null | undefined;
  if (c["mode"] === "code") {
    if (expect !== undefined) throw invalid(file, `"expect_finding" is only for review cases`);
    if (c["expect_no_findings"] !== undefined) throw invalid(file, `"expect_no_findings" is only for review cases`);
  } else {
    if (c["expect_no_findings"] !== undefined && c["expect_no_findings"] !== true) {
      throw invalid(file, `"expect_no_findings" must be true`);
    }
    if (c["expect_no_findings"] === true) {
      if (expect !== undefined) throw invalid(file, `a review case takes "expect_finding" or "expect_no_findings", not both`);
    } else {
      validateExpectFinding(file, expect);
    }
  }
  const changes = c["expect_changes"];
  if (changes !== undefined && (!Array.isArray(changes) || !changes.every((g) => typeof g === "string"))) {
    throw invalid(file, `"expect_changes" must be a list of glob strings`);
  }
  const forbid = c["forbid_changes"];
  if (!Array.isArray(forbid) || !forbid.every((g) => typeof g === "string")) {
    throw invalid(file, `"forbid_changes" must be a list of glob strings`);
  }
  if (c["max_steps"] !== undefined && typeof c["max_steps"] !== "number") throw invalid(file, `"max_steps" must be a number`);
  return raw as EvalCase;
}

function validateExpectFinding(file: string, expect: Record<string, unknown> | null | undefined): void {
  const lines = expect?.["lines"];
  if (!expect || typeof expect["path"] !== "string" || !Array.isArray(lines) || lines.length === 0 || !lines.every((n) => Number.isInteger(n) && n > 0)) {
    throw invalid(file, `a review case needs "expect_finding" with a string "path" and a non-empty list of positive integer "lines", or "expect_no_findings: true"`);
  }
}

export async function loadCases(dir: string, filter?: string): Promise<EvalCase[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".yaml")).sort();
  const cases: EvalCase[] = [];
  for (const f of files) {
    let raw: unknown;
    try {
      raw = parse(await readFile(join(dir, f), "utf8"));
    } catch (e) {
      throw invalid(f, e instanceof Error ? e.message : String(e));
    }
    cases.push(validateCase(f, raw));
  }
  return cases.filter((c) => filter === undefined || c.id === filter).sort((a, b) => a.id.localeCompare(b.id));
}

// ---------- Running ----------

interface Tally {
  tokens_in: number;
  tokens_out: number;
  cost: number | null;
  tool_errors: number;
  auto_approved: number;
}

export async function runEval(opts: {
  cases: EvalCase[];
  runs: number;
  makeModel: (c: EvalCase, run: number) => ModelClient;
  outDir: string;
  fixturesDir: string;
  config: AgentConfig;
  /** Stop once this much has been spent (yen). The request that crosses it still completes. */
  maxCost?: number;
  log?: (line: string) => void;
}): Promise<EvalResult[]> {
  const { outDir } = opts;
  const log = opts.log ?? (() => {});
  mkdirSync(outDir, { recursive: true });
  const results: EvalResult[] = [];
  const spent = { total: 0 };
  const overBudget = () => opts.maxCost !== undefined && spent.total >= opts.maxCost;

  runs: for (const c of opts.cases) {
    for (let run = 1; run <= opts.runs; run++) {
      if (overBudget()) break runs;
      const result = await runOne(c, run, opts, spent);
      appendFileSync(join(outDir, `${c.id}-${run}.jsonl`), JSON.stringify(result) + "\n");
      results.push(result);
      log(
        `${result.pass ? "✓" : "✗"} ${c.id} #${run}  ${result.outcome} steps=${result.steps} ` +
          `tokens=${result.tokens_in + result.tokens_out} tool_errors=${result.tool_errors}` +
          `${result.edited_tests ? " EDITED TESTS" : ""}`,
      );
    }
  }

  const stopped = overBudget() ? `\n\nStopped early: max cost ¥${opts.maxCost} reached (spent ¥${spent.total.toFixed(2)}).` : "";
  const table = summaryTable(opts.cases, results) + stopped;
  writeFileSync(join(outDir, "summary.md"), table + "\n");
  log(table);
  return results;
}

async function runOne(
  c: EvalCase,
  run: number,
  opts: Parameters<typeof runEval>[0],
  spent: { total: number },
): Promise<EvalResult> {
  const started = Date.now();
  const file = join(opts.outDir, `${c.id}-${run}.jsonl`);
  writeFileSync(file, "");
  const findings: { path: string; line: number }[] = [];
  const tally: Tally = { tokens_in: 0, tokens_out: 0, cost: null, tool_errors: 0, auto_approved: 0 };
  const result = (r: Partial<EvalResult>): EvalResult => ({
    type: "result",
    case: c.id,
    run,
    outcome: "failed",
    pass: false,
    steps: 0,
    ...tally,
    edited_tests: false,
    changed_files: [],
    duration_ms: Date.now() - started,
    ...r,
  });

  let sandbox: LocalSandbox | undefined;
  try {
    sandbox = await LocalSandbox.fromFixture(join(opts.fixturesDir, c.fixture));
    const config: AgentConfig = { ...opts.config, maxSteps: c.max_steps ?? opts.config.maxSteps };
    const profile = getProfile(c.mode, config);
    const budget = new AbortController();
    const deps: AgentDeps = {
      signal: budget.signal,
      model: opts.makeModel(c, run),
      sandbox,
      policy: autoApprove(profile.policy),
      config,
      emit: (e) => {
        if (e.type === "message_delta" || e.type === "reasoning_delta") return; // never persisted (D7)
        appendFileSync(file, JSON.stringify(e) + "\n");
        if (e.type === "review_finding") findings.push({ path: e.path, line: e.line });
        if (e.type === "usage") {
          tally.tokens_in += e.tokens_in;
          tally.tokens_out += e.tokens_out;
          if (e.cost !== undefined) {
            tally.cost = (tally.cost ?? 0) + e.cost;
            spent.total += e.cost;
            if (opts.maxCost !== undefined && spent.total >= opts.maxCost) budget.abort("max cost reached");
          }
        } else if (e.type === "error" && e.source === "tool") {
          tally.tool_errors++;
        } else if (e.type === "approval_resolved" && e.auto === true) {
          tally.auto_approved++;
        }
      },
    };

    const state0 = createSession({ sessionId: `${c.id}-${run}`, mode: c.mode, task: c.task }, profile);
    state0.messages.push({ role: "user", content: await buildRepoContext(sandbox, { agentsMd: profile.sandboxSetup !== "pr-head@sha" }) });
    let { state, outcome } = await runAgent(state0, profile, deps);
    // A human approves everything in eval (slice decision S-a): strikes and implicit finishes too.
    // A question is answered with a fixed text, unless the case expects the agent to stop and ask.
    for (let resumes = 0; resumes < MAX_AUTO_RESUMES; resumes++) {
      if (outcome.kind === "awaiting_approval") {
        tally.auto_approved++;
        ({ state, outcome } = await resume(state, { approved: true }, profile, deps));
      } else if (outcome.kind === "awaiting_input" && state.pending?.kind === "question" && !c.expect_reply) {
        ({ state, outcome } = await resume(state, { approved: true, comment: NO_ONE_TEXT }, profile, deps));
      } else break;
    }

    await sandbox.exec("git add -A");
    // --no-renames: a moved test shows up as a deletion of its old path, not only the new one.
    // Diff against the fixture commit (the agent may have moved HEAD). -z keeps non-ASCII paths unquoted.
    const diff = await sandbox.exec(`git diff --cached --name-only --no-renames -z ${sandbox.baseline}`, {
      timeoutMs: config.commandTimeoutMs,
    });
    const changed = diff.stdout.split("\0").filter(Boolean);
    const isForbidden = picomatch(c.forbid_changes);
    // If the baseline is gone (history rewritten), we can't prove the tests are untouched.
    const editedTests = diff.exitCode !== 0 || changed.some((f) => isForbidden(f));
    const check = c.check ? await sandbox.exec(c.check.cmd, { timeoutMs: config.commandTimeoutMs }) : undefined;
    const checkOk = !c.check || check?.exitCode === c.check.expect_exit;
    const want = c.expect_finding;
    const found = !want || findings.some((f) => f.path === want.path && want.lines.includes(f.line));
    const noFindings = !c.expect_no_findings || findings.length === 0;
    const wantChanges = !c.expect_changes || c.expect_changes.every((g) => changed.some((f) => picomatch(g)(f)));
    const untouched = c.mode !== "review" || (changed.length === 0 && diff.exitCode === 0);

    const pass = c.expect_reply
      ? outcome.kind === "awaiting_input" && changed.length === 0 && diff.exitCode === 0
      : (outcome.kind === "finished" || (outcome.kind === "awaiting_input" && c.mode === "code")) &&
        checkOk && found && noFindings && wantChanges && untouched && !editedTests;

    return result({
      outcome: outcome.kind,
      pass,
      steps: state.step,
      edited_tests: editedTests,
      changed_files: changed,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    opts.log?.(`! ${c.id} #${run} errored: ${message}`);
    return result({});
  } finally {
    await sandbox?.destroy();
  }
}

function summaryTable(cases: EvalCase[], results: EvalResult[]): string {
  const rows = [
    "| case | passes | avg steps | avg tokens | cost | tool errors | edited tests |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  const row = (name: string, rs: EvalResult[]): string => {
    const n = rs.length || 1;
    const sum = (f: (r: EvalResult) => number) => rs.reduce((a, r) => a + f(r), 0);
    const costs = rs.map((r) => r.cost).filter((x): x is number => x !== null);
    const cost = costs.length ? `¥${costs.reduce((a, b) => a + b, 0).toFixed(2)}` : "—";
    return (
      `| ${name} | ${rs.filter((r) => r.pass).length}/${rs.length} | ${(sum((r) => r.steps) / n).toFixed(1)} | ` +
      `${Math.round(sum((r) => r.tokens_in + r.tokens_out) / n)} | ${cost} | ${sum((r) => r.tool_errors)} | ` +
      `${rs.filter((r) => r.edited_tests).length} |`
    );
  };
  for (const c of cases) rows.push(row(c.id, results.filter((r) => r.case === c.id)));
  rows.push(row("**total**", results));
  return rows.join("\n");
}

// ---------- CLI ----------

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const here = dirname(fileURLToPath(import.meta.url));
  const envFile = join(here, "..", ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const apiKey = process.env["AIAND_API_KEY"];
  const baseUrl = process.env["AIAND_BASE_URL"];
  if (!apiKey || !baseUrl) {
    console.error("Set AIAND_API_KEY and AIAND_BASE_URL (in the environment or a git-ignored .env at the repo root).");
    return 1;
  }

  const runs = Number(arg(argv, "runs") ?? 1);
  if (!Number.isInteger(runs) || runs < 1) {
    console.error("--runs must be a positive integer");
    return 1;
  }
  const maxCost = Number(arg(argv, "max-cost") ?? 5);
  if (!(maxCost > 0)) {
    console.error("--max-cost must be a positive number of yen");
    return 1;
  }
  const model = arg(argv, "model") ?? defaultConfig.models.code;
  if (!defaultConfig.prices?.[model]) {
    console.error(`no price for "${model}" in src/core/config.ts, so --max-cost can't be enforced; add it first`);
    return 1;
  }
  const outDir = arg(argv, "out") ?? join(here, "runs", new Date().toISOString().replaceAll(":", "-"));
  const caseId = arg(argv, "case");

  const cases = await loadCases(join(here, "cases"), caseId);
  if (cases.length === 0) {
    console.error(caseId ? `no case with id "${caseId}"` : "no cases found");
    return 1;
  }

  await runEval({
    cases,
    runs,
    makeModel: () => new OpenAICompatModelClient({ baseUrl, apiKey }),
    outDir,
    fixturesDir: join(here, "fixtures"),
    // Sessions have no step limit (the turn's cost limit stops them); an eval run gets one, so a stuck case ends early.
    config: { ...defaultConfig, maxSteps: EVAL_MAX_STEPS, models: { ...defaultConfig.models, code: model, review: model } },
    maxCost,
    log: (l) => console.log(l),
  });
  console.log(`\nTrajectories and summary.md written to ${outDir}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
