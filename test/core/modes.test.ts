import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalSandbox } from "../../eval/local-sandbox";
import { createSession, runAgent } from "../../src/core/agent";
import { defaultConfig } from "../../src/core/config";
import type { AgentEvent } from "../../src/core/events";
import { getProfile } from "../../src/core/modes";
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
    expect(code.tools).toEqual(["list_files", "read_file", "write_file", "apply_patch", "run_command", "finish"]);
    expect(code.systemPrompt).toMatch(/do not (edit|modify|change) (the )?tests/i);

    const review = getProfile("review", defaultConfig);
    expect(review).toMatchObject({ name: "review", sandboxSetup: "pr-head@sha", onFinish: "draft_review" });
    expect(review.tools).toEqual(["list_files", "read_file", "run_command", "report_finding", "finish"]);
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

    const results = model.requests.slice(1, 4).map((r) => r.messages.at(-1)!);
    expect(results[0]!.role === "tool" && results[0]!.content).toContain("unknown tool: apply_patch");
    expect(results[1]!.role === "tool" && results[1]!.content).toContain("unknown tool: write_file");
    expect(results[2]!.role === "tool" && results[2]!.content).toMatch(/not allowed|denied/i);

    expect((await sandbox.exec("git status --porcelain")).stdout).toBe("");

    const finding = events.find((e) => e.type === "review_finding");
    expect(finding).toMatchObject({ path: "src/sum.js", line: 3, severity: "high", text: "Loop skips the last element." });
    expect(finding && finding.type === "review_finding" && finding.id).toBeTruthy();

    expect(outcome).toEqual({ kind: "finished", summary: "1 finding" });
    expect(events.at(-1)).toMatchObject({ type: "status", status: "done" });
  });
});
