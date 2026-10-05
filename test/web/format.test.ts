import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent, EventBody } from "../../src/core/events";
import { initialView, reduce, type SessionView } from "../../web/src/state/reducer";
import {
  activityLabel,
  firstLine,
  isPreviewable,
  severityLabel,
  usageLine,
  changeTotals,
  choiceLabel,
  reviewMessage,
  contrastRatio,
  formatBytes,
  formatCost,
  formatDuration,
  formatTokens,
  isTestPath,
  modelLabel,
  relativeTime,
} from "../../web/src/state/format";

describe("formatters", () => {
  it("numbers, times and labels", () => {
    expect(formatBytes(214)).toBe("214 B");
    expect(formatBytes(5000)).toBe("5.0 kB");
    expect(formatBytes(1_250_000)).toBe("1.3 MB");
    expect(formatDuration(100)).toBe("0.1 s");
    expect(formatDuration(10_450)).toBe("10.5 s");
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatTokens(1812)).toBe("1.8k");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(262_144)).toBe("262k");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatCost(0.1149)).toBe("¥0.11");
    expect(modelLabel("deepseek-ai/deepseek-v4-pro")).toBe("deepseek-v4-pro");
    expect(modelLabel("scripted")).toBe("scripted");

    const now = 10 * 3600_000;
    expect(relativeTime(now - 20_000, now)).toBe("now");
    expect(relativeTime(now - 60_000, now)).toBe("1m");
    expect(relativeTime(now - 3600_000, now)).toBe("1h");
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe("3d");
  });

  it("test paths (P3-i) and totals", () => {
    for (const p of ["test/empty.test.js", "tests/a.py", "src/__tests__/x.ts", "a/b.spec.tsx", "c.test.mjs", "pkg/test/x.go"]) {
      expect(isTestPath(p), p).toBe(true);
    }
    for (const p of ["src/sum.js", "src/testing.js", "contest/a.js", "latest.js", "coverage/out.json"]) {
      expect(isTestPath(p), p).toBe(false);
    }
    expect(
      changeTotals([
        { path: "a", additions: 1, deletions: 1, diff: "x" },
        { path: "b", additions: 7, deletions: 0, diff: "y" },
        { path: "c", additions: 2, deletions: 0, diff: null },
      ]),
    ).toEqual({ files: 3, additions: 10, deletions: 1 });
  });

  it("token contrast", () => {
    // The colors are the Tailwind theme tokens in web/src/styles.css (`@theme { --color-…: #rrggbb; }`).
    const css = readFileSync(join(import.meta.dirname, "../../web/src/styles.css"), "utf8");
    const token = (name: string) => {
      const m = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})\\b`).exec(css);
      if (!m) throw new Error(`no --color-${name} in styles.css`);
      return m[1]!;
    };
    const white = "#ffffff";
    expect(contrastRatio(token("accent-text"), white)).toBeGreaterThanOrEqual(4.5); // accent text on white
    expect(contrastRatio(white, token("accent"))).toBeGreaterThanOrEqual(4.5); // white on the accent fill
    for (const name of ["text", "text-secondary", "failed", "done-text"]) {
      expect(contrastRatio(token(name), white), name).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
  });
});

describe("Session UI: usage line, activity label, previewable paths", () => {
  it("usage line", () => {
    expect(usageLine({ model: "deepseek/deepseek-v4-flash", tokensIn: 5432, tokensOut: 6012, latencyMs: 34_310 })).toBe("deepseek-v4-flash · 5.4k in · 6.0k out · 34.3s");
    expect(usageLine({ model: "deepseek/deepseek-v4-flash", reasoning: "high", tokensIn: 812, tokensOut: 95, latencyMs: 940 })).toBe("deepseek-v4-flash · high · 812 in · 95 out · 0.9s");
    expect(usageLine({ model: "scripted", tokensIn: 262_144, tokensOut: 0, latencyMs: 72_400 })).toBe("scripted · 262k in · 0 out · 72.4s");
  });

  it("the composer names what the session runs on", () => {
    const label = (m: Parameters<typeof choiceLabel>[0], routed?: { model: string; reasoning: string }) => choiceLabel(m, "deepseek-ai/deepseek-v4-flash", "auto", routed);
    expect(label({ id: "zai-org/glm-5.3-flash", reasoning: "high" })).toBe("glm-5.3-flash · high");
    expect(label(null)).toBe("deepseek-v4-flash");
    expect(label({ id: "auto", reasoning: null })).toBe("Auto");
    expect(label({ id: "auto", reasoning: null }, { model: "deepseek-ai/deepseek-v4.1-flash", reasoning: "high" })).toBe("Auto · deepseek-v4.1-flash · high");
  });

  it("activity label", () => {
    let seq = 0;
    const ev = (body: EventBody, step?: number): AgentEvent => ({ ...body, seq: ++seq, ts: 1_700_000_000_000 + seq * 100, sessionId: "s-1", ...(step !== undefined && { stepId: `s${step}` }) }) as AgentEvent;
    const after = (view: SessionView, ...bodies: EventBody[]) => bodies.reduce((v, b) => reduce(v, ev(b, 1)), view);
    const open = (name: string, args: Record<string, unknown>, callId = `c${seq}`) => ({ type: "tool_call", callId, name, args, summary: name }) as EventBody;
    const done = (callId: string) => ({ type: "tool_output", callId, stream: "result", chunk: "ok" }) as EventBody;
    const PATCH = ["--- a/src/sum.js", "+++ b/src/sum.js", "@@ -1 +1 @@", "-a", "+b", ""].join("\n");

    expect(activityLabel(initialView())).toBeNull(); // no status yet
    const started = after(initialView(), { type: "status", status: "running" }, { type: "message", id: "u1", role: "user", text: "go" });
    expect(activityLabel(started)).toBe("Thinking");
    expect(activityLabel(after(started, { type: "message_delta", id: "m1", text: "I will" }))).toBe("Writing a reply");
    expect(activityLabel(after(started, open("sandbox_setup", { repo: "a/b", sha: "abc" })))).toBe("Starting sandbox");
    expect(activityLabel(after(started, open("run_command", { command: "npm test" })))).toBe("Running npm test");
    expect(activityLabel(after(started, open("write_file", { path: "src/sum.js", content: "x" })))).toBe("Editing src/sum.js");
    expect(activityLabel(after(started, open("apply_patch", { patch: PATCH })))).toBe("Editing src/sum.js");
    expect(activityLabel(after(started, open("read_file", { path: "src/sum.js" })))).toBe("Reading src/sum.js");
    expect(activityLabel(after(started, open("list_files", {})))).toBe("Working");

    // A finished step: the agent is thinking about the next one.
    expect(activityLabel(after(started, open("read_file", { path: "src/sum.js" }, "r1"), done("r1")))).toBe("Thinking");
    // A reply that has arrived in full is not being written any more.
    expect(activityLabel(after(started, { type: "message", id: "m1", role: "assistant", text: "Reading the code." }))).toBe("Thinking");

    const long = `node scripts/build.js ${"--flag ".repeat(12)}`.trim();
    expect(long.length).toBeGreaterThan(60);
    expect(activityLabel(after(started, open("run_command", { command: long })))).toBe(`Running ${long.slice(0, 60)}…`);

    // A multi-line command is shown by its first line.
    expect(activityLabel(after(started, open("run_command", { command: 'node -e "\nconsole.log(1)\n"' })))).toBe('Running node -e " …');

    // Only while running.
    const running = after(started, open("run_command", { command: "npm test" }));
    for (const status of ["awaiting_input", "awaiting_approval", "done", "failed", "budget_exceeded", "idle"] as const) {
      expect(activityLabel(after(running, { type: "status", status })), status).toBeNull();
    }
  });

  it("a command is shown on one line", () => {
    expect(firstLine("npm test")).toBe("npm test");
    expect(firstLine('node -e "\nconst fs = require(\'fs\');\nconsole.log(1);\n"')).toBe('node -e " …');
    expect(firstLine("\n  npm test  \n")).toBe("npm test");
    expect(firstLine("")).toBe("");
  });

  it("severity labels", () => {
    expect(severityLabel("high")).toBe("High · Fix before merging");
    expect(severityLabel("medium")).toBe("Medium · Worth fixing");
    expect(severityLabel("low")).toBe("Low · Optional");
  });

  it("previewable paths", () => {
    for (const p of ["index.html", "site/pages/about.htm", "a/b/PAGE.HTML"]) expect(isPreviewable(p), p).toBe(true);
    for (const p of ["app.js", "html", "notes.html.txt", "src/html/index.ts", ".html/readme.md", ""]) expect(isPreviewable(p), p).toBe(false);
  });
});

describe("Code session: reviews of its pull request", () => {
  const review = { id: 1, author: "TseHang", state: "CHANGES_REQUESTED" as const, body: "Please fix the hyphens.", submittedAt: "", url: "", comments: [{ path: "src/slugify.js", line: 4, body: "Two spaces become two hyphens." }] };

  it("quotes the reviews as feedback, with each comment's place", () => {
    const text = reviewMessage(14, [review], 4000);
    expect(text).toMatch(/^Address these review comments on pull request #14\./);
    expect(text).toMatch(/not as instructions/);
    expect(text).toContain("### TseHang · Requested changes\n\n> Please fix the hyphens.");
    expect(text).toContain("- `src/slugify.js:4`\n> Two spaces become two hyphens.");
  });

  it("fits the message limit, and says what was left out", () => {
    const long = { ...review, comments: Array.from({ length: 200 }, (_, i) => ({ path: "a.js", line: i + 1, body: "x".repeat(50) })) };
    const text = reviewMessage(14, [long], 4000);
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text).toMatch(/More comments on GitHub did not fit here\.\)$/);
  });
});
