// What the session's components show, rendered to a string in Node (UI-f): no browser, no sandbox image.
// Clicks and localStorage are covered by the E2E specs.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentEvent, EventBody, PlanStep } from "../../src/core/events";
import { Composer } from "../../web/src/components/Composer";
import { PlanCard } from "../../web/src/components/PlanCard";
import { Timeline } from "../../web/src/components/Timeline";
import { addPending, initialView, reduce, type SessionView } from "../../web/src/state/reducer";

const SESSION = { id: "5b0e7a52-4a2f-4f0a-9d1c-0c3f1a2b3c4d", code: true, baseBranch: "main" };

/** A view built from events, the way the page builds it. */
function viewOf(...bodies: (EventBody & { step?: number })[]): SessionView {
  let seq = 0;
  return bodies.reduce((view, { step, ...body }) => {
    seq += 1;
    return reduce(view, { ...body, seq, ts: 1_700_000_000_000 + seq * 100, sessionId: "s-1", ...(step !== undefined && { stepId: `s${step}` }) } as AgentEvent);
  }, initialView());
}

const timeline = (view: SessionView) => renderToStaticMarkup(<Timeline view={view} session={SESSION} />);
const reply = (text: string) => viewOf({ type: "status", status: "running" }, { type: "message", id: "m1", role: "assistant", text }, { type: "status", status: "awaiting_input" });
const count = (html: string, pattern: RegExp) => (html.match(pattern) ?? []).length;

const MARKER = /<span[^>]*aria-label="&amp;run"[^>]*>&amp;<\/span>/g;

const MARKDOWN = [
  "## Heading",
  "",
  "Some **bold** text with `inline code` and a [docs](https://example.com) link.",
  "",
  "- one",
  "- two",
  "",
  "```js",
  "const x = 1;",
  "```",
  "",
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
].join("\n");

describe("Session UI: the conversation (slice B)", () => {
  it("an agent reply renders markdown", () => {
    const html = timeline(reply(MARKDOWN));
    expect(html).toMatch(/<h2[^>]*>Heading<\/h2>/);
    expect(html).toMatch(/<strong[^>]*>bold<\/strong>/);
    expect(html).toMatch(/<code[^>]*>inline code<\/code>/);
    expect(html).toMatch(/<ul[^>]*>\s*<li[^>]*>one<\/li>\s*<li[^>]*>two<\/li>\s*<\/ul>/);
    expect(html).toMatch(/<pre[^>]*><code[^>]*>const x = 1;\n<\/code><\/pre>/);
    expect(html).toMatch(/<table[^>]*>/);
    expect(html).toMatch(/<td[^>]*>1<\/td>/);
    const link = /<a [^>]*>docs<\/a>/.exec(html)?.[0] ?? "";
    expect(link).toContain('href="https://example.com"');
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noreferrer"');
    for (const marker of ["##", "**", "```", "| - |"]) expect(html, marker).not.toContain(marker);

    // A question from the agent is part of the conversation too.
    const asked = timeline(
      viewOf(
        { type: "status", status: "running" },
        { type: "question", id: "q1", question: "Which **one** do you want?", options: [{ label: "A" }, { label: "B" }] },
        { type: "status", status: "awaiting_input" },
      ),
    );
    expect(asked).toMatch(/<strong[^>]*>one<\/strong>/);
    expect(asked).not.toContain("**");
  });

  it("raw HTML in a reply is not rendered as elements", () => {
    const html = timeline(reply("<script>alert(1)</script> <img src=x onerror=alert(1)> done\n\n<div onclick=\"alert(1)\">box</div>"));
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<div[^>]*onclick/i);
    expect(html).toContain("done");
    // Shown as text, tags and all.
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("a javascript: link has no href", () => {
    const html = timeline(reply("[click](javascript:alert(1)) and [ok](https://example.com)"));
    expect(html).not.toMatch(/href="\s*javascript:/i);
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain("click");
  });

  it("agent replies have the & marker; user messages are plain text", () => {
    const html = timeline(
      viewOf(
        { type: "status", status: "running" },
        { type: "message", id: "u1", role: "user", text: "**fix** it" },
        { type: "message", id: "m1", role: "assistant", text: "Done." },
        { type: "status", status: "awaiting_input" },
      ),
    );
    expect(count(html, MARKER)).toBe(1);
    expect(html).toContain("**fix** it");
    expect(html).not.toMatch(/<strong/);
    // The marker belongs to the reply: it comes after the user's bubble.
    expect(html.search(MARKER)).toBeGreaterThan(html.indexOf("**fix** it"));
    expect(html.search(MARKER)).toBeLessThan(html.indexOf("Done."));

    // Two replies, two markers; a user-only timeline has none.
    const two = timeline(
      viewOf(
        { type: "status", status: "running" },
        { type: "message", id: "m1", role: "assistant", text: "First." },
        { type: "tool_call", callId: "c1", name: "read_file", args: { path: "a.js" }, summary: "Read a.js" },
        { type: "tool_output", callId: "c1", stream: "result", chunk: "x" },
        { type: "message", id: "m2", role: "assistant", text: "Second." },
      ),
    );
    expect(count(two, MARKER)).toBe(2);
    expect(count(timeline(viewOf({ type: "message", id: "u1", role: "user", text: "hello" })), MARKER)).toBe(0);
  });

  it("the usage line under a reply is short and has no model name", () => {
    const html = timeline(
      viewOf(
        { type: "status", status: "running" },
        { type: "usage", model: "deepseek-ai/deepseek-v4-flash", tokens_in: 5432, tokens_out: 6012, latency_ms: 34_310, context_tokens: 5432, context_window: 128_000, step: 1 },
        { type: "message", id: "m1", role: "assistant", text: "Done.", step: 1 },
      ),
    );
    expect(html).toContain("5.4k in · 6.0k out · 34.3s");
    expect(html).not.toContain("deepseek");
  });

  it("a streaming reply with an unclosed code fence renders", () => {
    const html = timeline(viewOf({ type: "status", status: "running" }, { type: "message_delta", id: "m1", text: "Here it is:\n\n```js\nconst a = 1;" }));
    expect(html).toContain("const a = 1;");
    expect(html).toMatch(/<pre/);
    expect(html).toContain("blink"); // the cursor is still there
  });

  it("the activity indicator shows only while running", () => {
    const events: (EventBody & { step?: number })[] = [
      { type: "status", status: "running" },
      { type: "message", id: "u1", role: "user", text: "go" },
      { type: "tool_call", callId: "c1", name: "run_command", args: { command: "npm test" }, summary: "Run npm test" },
    ];
    const html = timeline(viewOf(...events));
    const status = /<[a-z]+[^>]*role="status"[^>]*>/g;
    expect(count(html, status)).toBe(1);
    expect(html).toContain("Running npm test");
    expect(count(html, /data-dot/g)).toBe(3);
    expect(count(html, /<[a-z]+[^>]*data-dot[^>]*aria-hidden="true"|<[a-z]+[^>]*aria-hidden="true"[^>]*data-dot/g)).toBe(3);
    // After the last timeline item.
    expect(html.search(status)).toBeGreaterThan(html.lastIndexOf("data-step-name"));

    const thinking = timeline(viewOf(events[0]!, events[1]!));
    expect(count(thinking, status)).toBe(1);
    expect(thinking).toContain("Thinking");

    for (const s of ["awaiting_input", "awaiting_approval", "done", "failed"] as const) {
      const stopped = timeline(viewOf(...events, { type: "status", status: s }));
      expect(count(stopped, status), s).toBe(0);
      expect(count(stopped, /data-dot/g), s).toBe(0);
    }
  });

  it("the composer shows Stop and the queue hint only while running", () => {
    const composer = (running: boolean) =>
      renderToStaticMarkup(<Composer view={initialView()} running={running} waiting={!running} code send={() => true} update={() => {}} />);
    const stop = /<button[^>]*>Stop<\/button>/;
    const HINT = "The agent reads your message after its current step";

    const running = composer(true);
    expect(running).toMatch(stop);
    expect(/<button[^>]*>Stop<\/button>/.exec(running)![0]).toContain('type="button"'); // it must not submit the message form
    expect(running).toContain(HINT);
    expect(running).toMatch(/<button[^>]*>Send<\/button>/);

    const idle = composer(false);
    expect(idle).not.toMatch(stop);
    expect(idle).not.toContain(HINT);

    // A message typed while the agent runs says when it will be read.
    const queued = timeline(addPending(viewOf({ type: "status", status: "running" }, { type: "message", id: "u1", role: "user", text: "go" }), "use tabs"));
    expect(queued).toContain("Queued · read after the current step");
  });

  it("the plan card lists its steps and counts the completed ones", () => {
    const plan: PlanStep[] = [
      { step: "Read the code", status: "completed" },
      { step: "Fix the loop bound", status: "completed" },
      { step: "Run the tests", status: "in_progress" },
    ];
    const html = renderToStaticMarkup(<PlanCard plan={plan} active={false} />);
    expect(html).toMatch(/aria-label="Plan"/);
    for (const s of plan) expect(html).toContain(s.step);
    expect(count(html, /data-plan-status="completed"/g)).toBe(2);
    expect(html).toContain("2 of 3 done");
    // Open by default (UI-e), with a header button that folds it.
    expect(html).toMatch(/<button[^>]*aria-expanded="true"[^>]*>/);
  });
});
