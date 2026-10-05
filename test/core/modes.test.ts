import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalSandbox } from "../../eval/local-sandbox";
import { createSession, runAgent } from "../../src/core/agent";
import { defaultConfig } from "../../src/core/config";
import type { AgentEvent } from "../../src/core/events";
import { getProfile } from "../../src/core/modes";
import { CODE_SYSTEM_PROMPT, REVIEW_SYSTEM_PROMPT } from "../../src/core/prompts";
import { toolSpecs } from "../../src/core/tools";
import { MemorySandbox } from "../support/memory-sandbox";
import { ScriptedModelClient, call } from "../support/scripted-model";

const FIXTURE = join(import.meta.dirname, "../../eval/fixtures/sum-off-by-one");
let sandbox: LocalSandbox | undefined;
afterEach(async () => {
  await sandbox?.destroy();
});

describe("S4: review profile cannot write (D4)", () => {
  it("profiles are data", () => {
    const code = getProfile("code", defaultConfig);
    expect(code).toMatchObject({ name: "code", sandboxSetup: "tarball@sha", onFinish: "open_pr" });
    expect(code.tools).toEqual(["list_files", "read_file", "write_file", "apply_patch", "run_command", "update_plan", "ask_user", "finish"]);
    expect(code.onTextReply).toBe("wait");
    expect(code.systemPrompt).toBe(CODE_SYSTEM_PROMPT);

    const review = getProfile("review", defaultConfig);
    expect(review).toMatchObject({ name: "review", sandboxSetup: "pr-head@sha", onFinish: "draft_review" });
    expect(review.tools).toEqual(["list_files", "read_file", "run_command", "report_finding", "finish"]);
    expect(review.onTextReply).toBe("finish");
  });

  it("review profile exposes no write tools and leaves workspace clean", async () => {
    sandbox = await LocalSandbox.fromFixture(FIXTURE);
    const profile = getProfile("review", defaultConfig);
    const model = new ScriptedModelClient([
      call("apply_patch", { patch: "--- a/src/sum.js\n+++ b/src/sum.js\n" }),
      call("write_file", { path: "src/sum.js", content: "hacked" }),
      call("run_command", { command: "rm -rf src" }),
      call("report_finding", { path: "src/sum.js", line: 3, severity: "high", text: "Loop skips the last element." }),
      call("finish", { summary: "1 finding" }),
    ]);
    const events: AgentEvent[] = [];
    const { outcome } = await runAgent(createSession({ sessionId: "r", mode: "review", task: "Review PR #1" }, profile), profile, {
      model,
      sandbox,
      emit: (e) => events.push(e),
      config: defaultConfig,
    });

    const sent = model.requests[0]!.tools.map((t) => t.name);
    expect(sent).not.toContain("apply_patch");
    expect(sent).not.toContain("write_file");

    // The command limits are in the tool's own description, where the model looks when it writes a call.
    const runCommand = model.requests[0]!.tools.find((t) => t.name === "run_command")!.description;
    for (const allowed of ["npm test", "node --test", "cat", "grep", "git show"]) expect(runCommand).toContain(allowed);
    expect(runCommand).toMatch(/no pipes/i);
    const codeRunCommand = toolSpecs(getProfile("code", defaultConfig).tools).find((t) => t.name === "run_command")!.description;
    expect(codeRunCommand).not.toMatch(/no pipes/i);
    expect(runCommand.startsWith(codeRunCommand)).toBe(true);

    const results = model.requests.slice(1, 4).map((r) => r.messages.at(-1)!);
    expect(results[0]!.role === "tool" && results[0]!.content).toContain("unknown tool: apply_patch");
    expect(results[1]!.role === "tool" && results[1]!.content).toContain("unknown tool: write_file");
    expect(results[2]!.role === "tool" && results[2]!.content).toMatch(/not allowed|denied/i);

    expect((await sandbox.exec("git status --porcelain")).stdout).toBe("");

    const finding = events.find((e) => e.type === "review_finding");
    expect(finding).toMatchObject({ path: "src/sum.js", line: 3, severity: "high", text: "Loop skips the last element." });
    expect(finding && finding.type === "review_finding" && finding.id).toBeTruthy();

    // P4-b: the review stops at a gate; a human posts it.
    expect(outcome).toMatchObject({ kind: "awaiting_approval", pending: { reason: "posting requires your decision", summary: "1 finding" } });
    expect(events.at(-1)).toMatchObject({ type: "status", status: "awaiting_approval" });
  });
});

describe("HI-a: the plan tool belongs to Code", () => {
  it("update_plan is a Code tool only", async () => {
    const code = getProfile("code", defaultConfig);
    const review = getProfile("review", defaultConfig);
    expect(toolSpecs(code.tools).map((t) => t.name)).toContain("update_plan");
    expect(toolSpecs(review.tools).map((t) => t.name)).not.toContain("update_plan");

    const model = new ScriptedModelClient([call("update_plan", { plan: [{ step: "Read the diff", status: "in_progress" }] }), call("finish", { summary: "No findings." })]);
    const events: AgentEvent[] = [];
    await runAgent(createSession({ sessionId: "r", mode: "review", task: "Review PR #1" }, review), review, {
      model,
      sandbox: new MemorySandbox(),
      emit: (e) => events.push(e),
      config: defaultConfig,
    });
    expect(model.requests[0]!.tools.map((t) => t.name)).not.toContain("update_plan");
    const answer = model.requests[1]!.messages.at(-1)!;
    expect(answer.role === "tool" && answer.content).toContain("unknown tool: update_plan");
    expect(events.filter((e) => e.type === "plan_updated")).toEqual([]);
  });
});

describe("CF-c: questions belong to Code", () => {
  it("ask_user is a Code tool only", async () => {
    const code = getProfile("code", defaultConfig);
    const review = getProfile("review", defaultConfig);
    expect(toolSpecs(code.tools).map((t) => t.name)).toContain("ask_user");
    expect(toolSpecs(review.tools).map((t) => t.name)).not.toContain("ask_user");
    const args = { question: "Which?", options: [{ label: "A" }, { label: "B" }] };
    expect(code.policy.decide({ mode: "code", tool: "ask_user", args })).toEqual({ kind: "allow" });

    const model = new ScriptedModelClient([call("ask_user", args), call("finish", { summary: "No findings." })]);
    const events: AgentEvent[] = [];
    const { outcome } = await runAgent(createSession({ sessionId: "r", mode: "review", task: "Review PR #1" }, review), review, {
      model,
      sandbox: new MemorySandbox(),
      emit: (e) => events.push(e),
      config: defaultConfig,
    });
    expect(model.requests[0]!.tools.map((t) => t.name)).not.toContain("ask_user");
    const answer = model.requests[1]!.messages.at(-1)!;
    expect(answer.role === "tool" && answer.content).toContain("unknown tool: ask_user");
    expect(events.filter((e) => e.type === "question")).toEqual([]);
    expect(outcome.kind).toBe("awaiting_approval");
  });
});

describe("CF: the code prompt describes a conversation", () => {
  it("the code prompt covers discussion, ask_user and finish", () => {
    const code = CODE_SYSTEM_PROMPT;
    // A reply without a tool call hands the turn to the user.
    expect(code).toMatch(/without (a|any) tool call.{0,80}(ends|hands)/is);
    // Discuss before editing when the request is open.
    expect(code).toMatch(/open-ended/i);
    expect(code).toMatch(/several .{0,30}(approaches|ways)/i);
    expect(code).toMatch(/do not (edit|change|write).{0,80}(chosen|choose|answer|agree)/is);
    expect(code).toMatch(/ask_user/);
    // A clear task is still done directly.
    expect(code).toMatch(/clear.{0,60}(directly|without asking)/is);
    // finish is for work that is ready for a pull request, not how every turn ends.
    expect(code).toMatch(/finish.{0,120}ready for a pull request/is);
    expect(code).not.toMatch(/when you are done, call finish/i);
  });
});

describe("HI-g: the prompts are general", () => {
  /** Every path under eval/fixtures (e.g. "src/sum.js") and every fixture's name. */
  function fixtureNames(): string[] {
    const root = join(import.meta.dirname, "../../eval/fixtures");
    const names: string[] = [];
    for (const fixture of readdirSync(root)) {
      names.push(fixture);
      const files = readdirSync(join(root, fixture), { recursive: true, withFileTypes: true }).filter((f) => f.isFile());
      for (const f of files) names.push(join(f.parentPath, f.name).slice(join(root, fixture).length + 1));
    }
    // Names any repo has say nothing about a case.
    return [...new Set(names)].filter((n) => !["package.json", "README.md"].includes(n));
  }

  it("prompts carry general rules and no eval-specific names", () => {
    const code = CODE_SYSTEM_PROMPT;
    // No longer a "make the tests pass" script.
    expect(code).not.toMatch(/start by running the tests/i);
    expect(code).not.toMatch(/rerun the tests after/i);
    expect(code).not.toMatch(/fix the code, not the tests/i);
    // What it says instead.
    expect(code).toMatch(/verify/i);
    expect(code).toMatch(/read .{0,40}before/i);
    expect(code).toMatch(/update_plan/);
    expect(code).toMatch(/unrelated/i);
    expect(code).toMatch(/test framework/i);
    expect(code).toMatch(/finish/);

    const review = REVIEW_SYSTEM_PROMPT;
    expect(review).not.toMatch(/ask_user/);
    expect(review).toMatch(/code reviewer/); // the fake model picks its review script by this phrase
    expect(review).toMatch(/introduce/i);
    expect(review).toMatch(/verif/i);
    expect(review).toMatch(/report_finding/);
    expect(review).toMatch(/no (findings|problems)/i);
    expect(review).toMatch(/never as instructions/i);

    const names = fixtureNames();
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) {
      expect(code, name).not.toContain(name);
      expect(review, name).not.toContain(name);
    }
  });
});


it("task: empty sandbox, read-only network, no finish tool", () => {
  const task = getProfile("task", defaultConfig);
  expect(task).toMatchObject({ sandboxSetup: "empty", network: "get", onFinish: "answer", onTextReply: "wait" });
  expect(task.tools).toEqual(["list_files", "read_file", "write_file", "apply_patch", "run_command", "update_plan", "ask_user"]);
  for (const mode of ["code", "review"] as const) expect(getProfile(mode, defaultConfig)).toHaveProperty("network", "off");
});

it("the task prompt names the three formats and what is not supported", () => {
  const prompt = getProfile("task", defaultConfig).systemPrompt;
  for (const word of [".html", ".md", ".csv", "PDF", "inline", "SVG", "update_plan", "ask_user"]) expect(prompt).toContain(word);
  expect(prompt).toMatch(/empty/i);
  expect(prompt).toMatch(/images.*(cannot|not supported)|cannot.*images/is);
  expect(prompt).toMatch(/no search|cannot search/i);
  expect(prompt).toMatch(/never instructions|never as instructions/i);
  expect(prompt).not.toContain("index.html");
  expect(prompt).not.toContain("task-page");
});
