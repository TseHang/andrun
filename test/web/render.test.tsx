// What the session's components show, rendered to a string in Node (UI-f): no browser, no sandbox image.
// Clicks and localStorage are covered by the E2E specs.
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentEvent, EventBody, PlanStep } from "../../src/core/events";
import type { Config, PullDetail } from "../../web/src/api";
import { App_ } from "../../web/src/context";
import { Findings } from "../../web/src/components/Findings";
import { PullOverview } from "../../web/src/components/PullOverview";
import { ReviewCard } from "../../web/src/components/ReviewCard";
import { ReviewFilesPanel } from "../../web/src/components/ReviewFilesPanel";
import { Composer } from "../../web/src/components/Composer";
import { PlanCard } from "../../web/src/components/PlanCard";
import { Timeline } from "../../web/src/components/Timeline";
import { addPending, initialView, reduce, type SessionView } from "../../web/src/state/reducer";

const SESSION = { id: "5b0e7a52-4a2f-4f0a-9d1c-0c3f1a2b3c4d", code: true, baseBranch: "main", pr: null };

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
/** The side panel's session props: a done session, nothing sent. */
const panel = (code: boolean) => ({ session: { ...SESSION, id: "s", code }, status: "done" as const, send: () => true, update: () => {} });

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
    // A class react-markdown adds (the code language, a task list) does not replace the styling.
    expect(/<code[^>]*class="([^"]*)"[^>]*>const x = 1;/.exec(html)?.[1]).toMatch(/font-mono.*language-js/);
    expect(/<ul[^>]*class="([^"]*)"/.exec(timeline(reply("- [x] done\n- [ ] todo")))?.[1]).toMatch(/list-disc.*contains-task-list/);

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

  it("an image in a reply is a link, never loaded by the page", () => {
    const html = timeline(reply("Here: ![chart](https://evil.example/pixel.png?q=secret) and ![](https://evil.example/2.png)"));
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/src=/i);
    const link = /<a [^>]*>chart<\/a>/.exec(html)?.[0] ?? "";
    expect(link).toContain('href="https://evil.example/pixel.png?q=secret"');
    expect(link).toContain('target="_blank"');
    expect(html).toMatch(/<a [^>]*>image<\/a>/);
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
    // The breathing &run mark, hidden from screen readers: the label says what is going on.
    expect(count(html, /data-mark/g)).toBe(1);
    expect(count(html, /<[a-z]+[^>]*aria-hidden="true"[^>]*data-mark/g)).toBe(1);
    expect(html).toMatch(/role="status"[^>]*>Running npm test</);
    // After the last timeline item.
    expect(html.search(status)).toBeGreaterThan(html.lastIndexOf("data-step-name"));

    const thinking = timeline(viewOf(events[0]!, events[1]!));
    expect(count(thinking, status)).toBe(1);
    expect(thinking).toContain("Thinking");

    for (const s of ["awaiting_input", "awaiting_approval", "done", "failed"] as const) {
      const stopped = timeline(viewOf(...events, { type: "status", status: s }));
      expect(count(stopped, status), s).toBe(0);
      expect(count(stopped, /data-mark/g), s).toBe(0);
    }
  });

  it("items enter with motion only when they arrive live, never on a replay of the log", () => {
    const events: EventBody[] = [{ type: "status", status: "running" }, { type: "message", id: "u1", role: "user", text: "go" }];
    const replayed = timeline(viewOf(...events)); // stored events from 2023
    expect(replayed).not.toMatch(/class="enter/);
    const now = Date.now();
    const live = events.reduce((v, body, i) => reduce(v, { ...body, seq: i + 1, ts: now, sessionId: "s-1" } as AgentEvent), initialView());
    expect(timeline(live)).toMatch(/class="enter"/);
  });

  it("the composer shows Stop only while running, and no queue hint before a message is typed", () => {
    const composer = (running: boolean) =>
      renderToStaticMarkup(<Composer view={initialView()} running={running} waiting={!running} send={() => true} update={() => {}} />);
    const stop = /<button[^>]*>Stop<\/button>/;
    const HINT = "The agent reads your message after its current step";

    const running = composer(true);
    expect(running).toMatch(stop);
    expect(/<button[^>]*>Stop<\/button>/.exec(running)![0]).toContain('type="button"'); // it must not submit the message form
    expect(running).not.toContain(HINT); // it shows under the input once a message is typed (E2E)
    expect(running).toMatch(/<button[^>]*>Send<\/button>/);

    const idle = composer(false);
    expect(idle).not.toMatch(stop);
    expect(idle).not.toContain(HINT);

    // A message typed while the agent runs says when it will be read.
    const queued = timeline(addPending(viewOf({ type: "status", status: "running" }, { type: "message", id: "u1", role: "user", text: "go" }), "use tabs"));
    expect(queued).toContain("Queued · read after the current step");
  });

  it("the finish summary is the agent's last message, and the approval is in the side panel", async () => {
    const { ChangesPanel } = await import("../../web/src/components/ChangesPanel");
    const view = viewOf(
      { type: "status", status: "running" },
      { type: "plan_updated", plan: [{ step: "Fix it", status: "completed" }, { step: "Run the tests", status: "in_progress" }] },
      { type: "approval_required", approvalId: "a1", tool: "finish", reason: "finishing requires approval", summary: "Created `index.html`:\n\n- Picks a number\n- **Tracks** attempts" },
      { type: "status", status: "awaiting_approval" },
    );
    const html = timeline(view);
    expect(html).toMatch(/data-item="summary"/);
    expect(html).toMatch(/<code[^>]*>index\.html<\/code>/);
    expect(html).toMatch(/<li[^>]*>Picks a number<\/li>/);
    expect(html).toMatch(/<strong[^>]*>Tracks<\/strong>/);
    expect(html).not.toContain("**");
    // A review posts its summary from the post bar instead.
    expect(renderToStaticMarkup(<Timeline view={view} session={{ ...SESSION, review: true }} />)).not.toMatch(/data-item="summary"/);

    const side = renderToStaticMarkup(<ChangesPanel {...panel(true)} status="awaiting_approval" view={view} sandboxRunning sha="abcdef" />);
    expect(side).toMatch(/<form[^>]*aria-label="Approval"/);
    expect(side).toContain("Approve and open PR");
    expect(side).toContain("agent/s-1 → main");
    expect(side).toContain("1 of 2 plan steps not completed");
    // The plan sits above the approval, at the top of the panel.
    expect(side.indexOf('aria-label="Plan"')).toBeLessThan(side.indexOf('aria-label="Approval"'));

    // The composer stays: a message asks for changes.
    const composer = renderToStaticMarkup(<Composer view={view} running={false} waiting={false} finishing send={() => true} update={() => {}} />);
    expect(composer).toContain('placeholder="Ask for changes instead"');
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

// ---------- Review UX: the pull request page and the review session share these parts ----------

const PATCH = ["@@ -0,0 +1,6 @@", "+export function slugify(text) {", "+  return text", "+    .toLowerCase()", '+    .replace(/ /g, "-")', '+    .replace(/[^a-z0-9-]/g, "");', "+}"].join("\n");

const pull = (over: Partial<PullDetail> = {}): PullDetail => ({
  number: 7,
  title: "Add slugify",
  author: "octocat",
  headRef: "feat/slugify",
  baseRef: "main",
  headSha: "a41c0b7e5d3f29186c7a4b0e9d2f1c3a5b6d7e8f",
  state: "open",
  fork: false,
  url: "https://github.com/TseHang/andrun-demo/pull/7",
  additions: 6,
  deletions: 0,
  changedFiles: 1,
  body: "## Why\n\nWe need **slugs**.",
  files: [{ path: "src/slugify.js", status: "added", additions: 6, deletions: 0, patch: PATCH }],
  ...over,
});

const CONFIG: Config = {
  repo: "TseHang/andrun-demo",
  sha: null,
  githubWrites: true,
  reviewBrief: "Review this pull request.",
  models: [{ id: "deepseek-ai/deepseek-v4-flash", contextWindow: 128_000, efforts: ["none", "high", "max"] }],
  defaultModel: "deepseek-ai/deepseek-v4-flash",
  autoModel: "auto",
  maxTurnCost: 5,
  costNotice: 10,
  maxTaskChars: 4000,
};
const inApp = (node: ReactNode) =>
  renderToStaticMarkup(<App_.Provider value={{ config: CONFIG, navigate: () => {}, refreshList: () => {}, refreshPulls: () => {}, reportStatus: () => {} }}>{node}</App_.Provider>);

const finding = (id: string, severity: "high" | "medium" | "low", line: number, text: string, extra: Record<string, unknown> = {}): EventBody =>
  ({ type: "review_finding", id, path: "src/slugify.js", line, severity, text, inline: true, ...extra }) as EventBody;
const reviewed = (...extra: EventBody[]) =>
  viewOf(
    { type: "status", status: "running" },
    finding("a", "high", 4, "Two spaces in a row become two hyphens."),
    finding("b", "medium", 5, "Leading and trailing hyphens are kept."),
    finding("c", "low", 1, "Consider a default export.", { dismissed: true }),
    { type: "review_finding", id: "d", path: "README.md", line: 3, severity: "medium", text: "README still shows the old name makeSlug.", inline: false } as EventBody,
    ...extra,
  );
const findings = (view: SessionView, status: "running" | "awaiting_approval" = "awaiting_approval") =>
  renderToStaticMarkup(<Findings view={view} status={status} send={() => true} onJump={() => {}} />);
/** The markup of one finding's post. */
const post = (html: string, id: string) => new RegExp(`<li[^>]*data-finding="${id}"[^>]*>.*?</li>`, "s").exec(html)?.[0] ?? "";
const AVATAR = /<span[^>]*role="img"[^>]*aria-label="&amp;run"[^>]*>&amp;<\/span>/g;

describe("Review UX: the pull request and the findings", () => {
  it("the pull request overview shows who merges what and the description as markdown", () => {
    const html = renderToStaticMarkup(<PullOverview pull={pull()} />);
    expect(html).toMatch(/<section[^>]*aria-label="Pull request"/);
    expect(html).toContain("octocat wants to merge feat/slugify into main");
    expect(html).toContain("1 file, 6 added");
    expect(html).toMatch(/<h2[^>]*>Why<\/h2>/);
    expect(html).toMatch(/<strong[^>]*>slugs<\/strong>/);
    // Open by default, with a button that folds it; the review session passes defaultOpen={false} (RV-g).
    expect(html).toMatch(/<button[^>]*aria-expanded="true"[^>]*>.*?Description/s);
    const folded = renderToStaticMarkup(<PullOverview pull={pull()} defaultOpen={false} />);
    expect(folded).toMatch(/<button[^>]*aria-expanded="false"[^>]*>.*?Description/s);
    expect(folded).not.toContain("slugs");
    expect(folded).toContain("octocat wants to merge feat/slugify into main");
  });

  it("a pull request without a description says so", () => {
    for (const body of ["", "  \n "]) {
      const html = renderToStaticMarkup(<PullOverview pull={pull({ body })} />);
      expect(html).toContain("No description.");
    }
  });

  it("a pull request description cannot inject elements", () => {
    const html = renderToStaticMarkup(<PullOverview pull={pull({ body: "<script>alert(1)</script>\n\n![x](https://evil.example/p.png)\n\n[a](javascript:alert(1))" })} />);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/href="\s*javascript:/i);
    expect(html).toMatch(/<a [^>]*href="https:\/\/evil\.example\/p\.png"[^>]*>x<\/a>/);
  });

  it("the review card says &run does the review and holds the brief", () => {
    const html = inApp(<ReviewCard pull={pull()} />);
    expect(html).toMatch(/<section[^>]*aria-label="&amp;run review"/);
    expect(count(html, AVATAR)).toBe(1);
    expect(html).toMatch(/<textarea[^>]*>Review this pull request\.<\/textarea>/);
    expect(html).toMatch(/<button[^>]*>Start review<\/button>/);
    expect(/<button[^>]*>Start review<\/button>/.exec(html)![0]).not.toMatch(/ disabled=""/);
    expect(html).toContain("Nothing is posted to GitHub until you choose to post.");
  });

  it("a blocked pull request shows why and cannot start", () => {
    const cases: [Partial<PullDetail>, string][] = [
      [{ state: "closed" }, "This pull request is not open."],
      [{ fork: true }, "Pull requests from forks are not supported."],
      [{ changedFiles: 101 }, "Pull requests with more than 100 files are not supported."],
    ];
    for (const [over, reason] of cases) {
      const html = inApp(<ReviewCard pull={pull(over)} />);
      expect(html, reason).toContain(reason);
      expect(/<button[^>]*>Start review<\/button>/.exec(html)![0], reason).toMatch(/ disabled=""/);
    }
  });

  const panel = (p: PullDetail, view: SessionView = initialView()) => renderToStaticMarkup(<ReviewFilesPanel pull={p} findings={view.findings} onHide={() => {}} />);
  const card = (html: string, path: string) => new RegExp(`<div[^>]*data-file="${path.replace(/[.]/g, "\\.")}"[^>]*>.*?(?=<div[^>]*data-file=|</aside>)`, "s").exec(html)?.[0] ?? "";
  const HTML_FILE = { path: "index.html", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-<h1>a</h1>\n+<h1>b</h1>" };

  it("a pull request file card is open by default and has a fold button", () => {
    const html = panel(pull({ changedFiles: 2, files: [...pull().files, HTML_FILE] }));
    expect(html).toMatch(/<aside[^>]*aria-label="Files changed"/);
    expect(html).toMatch(/<button[^>]*>Hide files<\/button>/);
    expect(count(html, /data-file="/g)).toBe(2);
    const js = card(html, "src/slugify.js");
    expect(js).toMatch(/<button[^>]*aria-expanded="true"[^>]*>/);
    expect(js).toContain("src/slugify.js");
    expect(js).toContain("+6");
    expect(js).toContain(".toLowerCase()");
    expect(count(js, /data-diff="add"/g)).toBe(6);
    // Only an HTML file with a patch can be previewed.
    expect(js).not.toMatch(/<button[^>]*>(<svg.*?<\/svg>)?Preview<\/button>/);
    expect(card(html, "index.html")).toMatch(/<button[^>]*>(<svg.*?<\/svg>)?Preview<\/button>/);
  });

  it("a removed or patch-less HTML file has no preview", () => {
    const html = panel(
      pull({
        changedFiles: 2,
        files: [
          { path: "old.html", status: "removed", additions: 0, deletions: 3, patch: "@@ -1,3 +0,0 @@\n-a\n-b\n-c" },
          { path: "big.html", status: "modified", additions: 0, deletions: 0, patch: null },
        ],
      }),
    );
    expect(count(html, /data-file="/g)).toBe(2);
    expect(html).not.toMatch(/<button[^>]*>(<svg.*?<\/svg>)?Preview<\/button>/);
    expect(card(html, "big.html")).toContain("Diff not available");
  });

  it("a fork's pull request has no preview", () => {
    const html = panel(pull({ fork: true, files: [HTML_FILE] }));
    expect(card(html, "index.html")).toContain("&lt;h1&gt;b&lt;/h1&gt;"); // the diff is still shown
    expect(html).not.toMatch(/<button[^>]*>(<svg.*?<\/svg>)?Preview<\/button>/);
  });

  it("a finding is shown as a post from &run with an explained severity", () => {
    const view = reviewed({ type: "status", status: "awaiting_approval" });
    const html = findings(view);
    expect(html).toMatch(/<section[^>]*aria-label="Findings"/);
    expect(html).toContain("3 kept, 1 dismissed");
    expect(count(html, /data-finding="/g)).toBe(4);

    const high = post(html, "a");
    expect(count(high, AVATAR)).toBe(1);
    expect(high).toContain("High · Fix before merging");
    expect(high).toMatch(/<a [^>]*>src\/slugify\.js:4<\/a>/);
    expect(high).toContain("Two spaces in a row become two hyphens.");
    expect(high).toMatch(/<button[^>]*>Edit<\/button>/);
    expect(high).toMatch(/<button[^>]*>Dismiss<\/button>/);
    expect(/<button[^>]*>Dismiss<\/button>/.exec(high)![0]).not.toMatch(/ disabled=""/);

    expect(post(html, "b")).toContain("Medium · Worth fixing");

    // Not on a changed line: it goes into the review's summary, and there is no line to jump to.
    const summary = post(html, "d");
    expect(summary).toContain("In summary");
    expect(summary).toContain("README.md:3");
    expect(summary).not.toMatch(/<a /);

    const dismissed = post(html, "c");
    expect(dismissed).toContain("Low · Optional");
    expect(dismissed).toMatch(/line-through/);
    expect(dismissed).toMatch(/<button[^>]*>Restore<\/button>/);
    expect(dismissed).not.toMatch(/<button[^>]*>(Edit|Dismiss)<\/button>/);

    // While the agent runs nothing can be edited.
    const running = findings(reviewed(), "running");
    expect(running).toContain("4 so far");
    expect(running).toContain("You can edit findings when the agent has finished.");
    expect(/<button[^>]*>Dismiss<\/button>/.exec(post(running, "a"))![0]).toMatch(/ disabled=""/);

    // The note in the diff has the same header; a dismissed finding has no note.
    const diff = panel(pull(), view);
    const line4 = /<div[^>]*data-line="src\/slugify\.js:4"[^>]*>.*?(?=<div[^>]*data-line=)/s.exec(diff)?.[0] ?? "";
    expect(count(line4, AVATAR)).toBe(1);
    expect(line4).toContain("High · Fix before merging");
    expect(line4).toContain("Two spaces in a row become two hyphens.");
    expect(diff).not.toContain("Consider a default export.");
    expect(count(diff, AVATAR)).toBe(2);
  });

  it("no findings", () => {
    const html = findings(viewOf({ type: "status", status: "running" }, { type: "status", status: "awaiting_approval" }));
    expect(html).toContain("No findings.");
    expect(count(html, /data-finding="/g)).toBe(0);
  });
});

// Task copy after switching modes is exercised by e2e/task.spec.ts (SSR cannot click).
it("task sessions are tagged and Home's note follows the mode", async () => {
  const { Home } = await import("../../web/src/components/Home");
  const { Sidebar } = await import("../../web/src/components/Sidebar");
  const sessions = [
    { id: "task", mode: "task" as const, title: "A page", status: "awaiting_input" as const, created_at: 1, updated_at: 1 },
    { id: "code", mode: "code" as const, title: "A fix", status: "awaiting_input" as const, created_at: 1, updated_at: 1 },
  ];
  for (const node of [<Home sessions={sessions} />, <Sidebar sessions={sessions} stale={false} path="/" live={null} pullCount={0} />]) {
    const html = inApp(node);
    expect(count(html, /data-tag="task"/g)).toBe(1);
    expect(html).not.toContain('data-tag="code"');
  }
  const home = inApp(<Home sessions={sessions} />);
  expect(home).toContain(CONFIG.repo);
  expect(home).toContain("Runs in a sandbox with no network access");
  const taskButton = /<button[^>]*>\s*Task\s*<\/button>/.exec(home)?.[0];
  expect(taskButton).toBeTruthy();
  expect(taskButton).not.toContain("disabled");
});

it("task: the Files panel lists .html, .md and .csv only and states the limit", async () => {
  const { ChangesPanel } = await import("../../web/src/components/ChangesPanel");
  const { isDeliverable } = await import("../../web/src/state/format");
  for (const path of ["report.html", "notes.md", "data.csv", "page.htm", "PAGE.HTML"]) expect(isDeliverable(path)).toBe(true);
  for (const path of ["build.js", "package.json", "chart.png", "report.html.js"]) expect(isDeliverable(path)).toBe(false);
  const paths = ["report.html", "notes.md", "data.csv", "build.js", "package.json", "chart.png"];
  const view = viewOf(...paths.map((path): EventBody => ({ type: "file_changed", path, diff: `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+hello\n` })));
  const task = renderToStaticMarkup(<ChangesPanel {...panel(false)} mode="task" view={view} sandboxRunning sha="" />);
  expect(task).toContain('aria-label="Files"');
  expect(task).toContain("Task produces .html, .md and .csv files. Images, PDF and other binary files are not supported.");
  expect(task).toContain("Web, read-only (GET)");
  expect(task).not.toContain("Base commit");
  for (const path of paths.slice(0, 3)) expect(task).toContain(`data-file="${path}"`);
  for (const path of paths.slice(3)) expect(task).not.toContain(path);
  expect(count(task, />Download<\/button>/g)).toBe(3);
  expect(count(task, />Preview<\/button>/g)).toBe(1);
  const code = renderToStaticMarkup(<ChangesPanel {...panel(true)} view={view} sandboxRunning sha="abcdef" />);
  expect(count(code, /data-file="/g)).toBe(6);
  expect(code).toContain("Base commit");
  expect(code).not.toContain("Download");
});

it("a file that was not saved has no download", async () => {
  const { ChangesPanel } = await import("../../web/src/components/ChangesPanel");
  const event = { type: "file_changed", path: "big.csv", diff: "", saved: false } as const;
  const view = viewOf(event);
  const html = renderToStaticMarkup(<ChangesPanel {...panel(false)} mode="task" view={view} sandboxRunning sha="" />);
  expect(html).toContain('data-file="big.csv"');
  expect(html).toContain("Too large to save (over 1 MB)");
  expect(html).not.toMatch(/>Download<\/button>/);
});

describe("A merged or closed pull request closes the session (A26)", () => {
  it("lists show Merged or Closed with a grey dot in place of the status", async () => {
    const { Home } = await import("../../web/src/components/Home");
    const { Sidebar } = await import("../../web/src/components/Sidebar");
    const base = { mode: "code" as const, status: "done" as const, created_at: 1, updated_at: 1 };
    const sessions = [
      { id: "m", ...base, title: "Merged fix", pr: 3, prState: "merged" as const },
      { id: "c", ...base, title: "Closed review", mode: "review" as const, status: "awaiting_approval" as const, pr: 4, prState: "closed" as const },
      { id: "o", ...base, title: "Open fix", pr: 5 },
    ];
    for (const node of [<Home sessions={sessions} />, <Sidebar sessions={sessions} stale={false} path="/" live={null} pullCount={0} />]) {
      const html = inApp(node);
      expect(count(html, />Merged</g)).toBe(1);
      expect(count(html, />Closed</g)).toBe(1);
      expect(count(html, />Done</g)).toBe(1);
      expect(html).not.toContain("Awaiting approval");
      expect(count(html, /bg-text-tertiary/g)).toBe(2);
      expect(count(html, /bg-done/g)).toBe(1);
    }
    // A run that is still going shows as running.
    const running = inApp(<Sidebar sessions={[{ id: "m", ...base, title: "t", status: "running", pr: 3, prState: "merged" }]} stale={false} path="/" live={null} pullCount={0} />);
    expect(running).toContain("Running");
    expect(running).not.toContain("Merged");
  });

  it("the header shows Merged, and the bar says why there is no composer", async () => {
    const { SessionHeader } = await import("../../web/src/components/SessionHeader");
    const { ClosedBar } = await import("../../web/src/components/Composer");
    const header = (prState?: "merged" | "closed") =>
      inApp(<SessionHeader title="t" status="done" prState={prState} header={initialView().header} review={false} onDelete={() => {}} moreRef={{ current: null }} />);
    expect(header("merged")).toMatch(/data-testid="session-status"[^>]*>.*Merged/);
    expect(header("merged")).not.toContain("Done");
    expect(header()).toContain("Done");

    const bar = renderToStaticMarkup(<ClosedBar pr={{ number: 3, state: "merged" }} />);
    expect(bar).toContain("Pull request #3 was merged");
    expect(bar).toContain('href="/"');
    expect(bar).not.toContain("<input");
    expect(renderToStaticMarkup(<ClosedBar pr={{ number: 3, state: "closed" }} />)).toContain("Pull request #3 was closed");
  });

  it("a posted review stops offering more once the pull request is merged", () => {
    const view = viewOf({ type: "status", status: "running" }, { type: "review_posted", url: "https://github.com/x/y/pull/3#r1", verdict: "COMMENT" }, { type: "status", status: "done" });
    expect(renderToStaticMarkup(<Timeline view={view} session={{ ...SESSION, pr: 3 }} />)).toContain("Review again");
    const closed = renderToStaticMarkup(<Timeline view={view} session={{ ...SESSION, pr: 3, closed: true }} />);
    expect(closed).toContain("Review posted");
    expect(closed).not.toContain("Review again");
    expect(closed).not.toContain("Keep asking");
  });
});
