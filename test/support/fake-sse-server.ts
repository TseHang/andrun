// A fake OpenAI-compatible streaming server for zero-cost runtime checks of the deployed loop.
// Run: `pnpm fake-model` (port 8788), then point AIAND_BASE_URL in .dev.vars at http://localhost:8788.
//
// It is stateless: the turn it plays is chosen by how many assistant messages the request holds,
// so it follows the same script for every session. The script fixes the `sum-off-by-one` bug that
// TseHang/andrun-demo ships with.
//
// Markers in the first user message change its behaviour:
//   [slow]  every answer is delayed 8 s (time to kill the sandbox mid-run)
//   [fail]  every request gets HTTP 500 (the run ends as failed after the client's retries)
//   [ask]    the run first writes scratch.txt, then deletes it with a patch (a patch that deletes a file
//            stops at an approval gate); after that the normal script plays from the start
//   [plan]   PLAN_SCRIPT plays instead: three plan steps, two completed, then finish
//   [costly] every answer reports 150,000 input tokens, so the session's cost passes the ¥10 notice
//   [chat]   turn 0 is a text-only reply (the run waits for the user); then the normal script plays
//   [choose] turn 0 calls ask_user with two options; then the normal script plays
//   [stop]   the normal script up to the first test run after the patch, then a text-only reply
//            instead of finish; finish and the rest play after the user's next message
//   [md]     turn 0 is a text-only reply written in markdown (heading, list, code, table, link)
//   [html]   writes index.html (its script fills in the heading) and app.js, then replies with text
// An auto-mode classifier request (system prompt of `classifyTask`) is answered "complex" for a task
// with [complex], "daily" otherwise. A request with a reasoning effort other than "none" streams a
// line of reasoning before its answer.
// A Review session (system prompt of the review profile) gets REVIEW_SCRIPT instead.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

interface Turn {
  text?: string;
  call?: { name: string; args: Record<string, unknown> };
}

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

const EMPTY_TEST = [
  'import { test } from "node:test";',
  'import assert from "node:assert/strict";',
  'import { sum } from "../src/sum.js";',
  "",
  'test("empty array", () => {',
  "  assert.equal(sum([]), 0);",
  "});",
  "",
].join("\n");

const SCRIPT: Turn[] = [
  { text: "Running the tests first.", call: { name: "run_command", args: { command: "npm test" } } },
  { call: { name: "read_file", args: { path: "src/sum.js" } } },
  { text: "The loop stops one element early.", call: { name: "apply_patch", args: { patch: FIX_PATCH } } },
  { call: { name: "run_command", args: { command: "npm test" } } },
  { call: { name: "finish", args: { summary: "Fixed the loop bound in sum(): it skipped the last element.", title: "Fix the loop bound in sum()" } } },
  // Played after a reject or a follow-up message.
  { text: "Adding the requested test.", call: { name: "write_file", args: { path: "test/empty.test.js", content: EMPTY_TEST } } },
  { call: { name: "run_command", args: { command: "npm test" } } },
  { call: { name: "finish", args: { summary: "Added a test for the empty array case; all tests pass." } } },
];
// Played for a Review session (the system prompt says "code reviewer"): four findings on the pull
// request the E2E spec seeds, one of them not on a changed line.
const finding = (path: string, line: number, severity: string, text: string): Turn => ({ call: { name: "report_finding", args: { path, line, severity, text } } });
const REVIEW_SCRIPT: Turn[] = [
  { text: "Running the tests, then reading the diff.", call: { name: "run_command", args: { command: "npm test" } } },
  finding("src/slugify.js", 4, "high", "Two spaces in a row become two hyphens."),
  finding("src/slugify.js", 5, "medium", "Leading and trailing hyphens are kept."),
  finding("README.md", 3, "medium", "README still shows the old name makeSlug."),
  finding("src/slugify.js", 1, "low", "Consider a default export."),
  { call: { name: "finish", args: { summary: "Four findings; the main one is repeated spaces." } } },
];
const DELETE_PATCH = ["diff --git a/scratch.txt b/scratch.txt", "deleted file mode 100644", "--- a/scratch.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-scratch", ""].join("\n");
const ASK_TURNS: Turn[] = [
  { call: { name: "write_file", args: { path: "scratch.txt", content: "scratch\n" } } },
  { call: { name: "apply_patch", args: { patch: DELETE_PATCH } } },
];
const plan = (...statuses: string[]): Turn => ({
  call: { name: "update_plan", args: { plan: ["Read the code", "Fix the loop bound", "Run the tests"].map((step, i) => ({ step, status: statuses[i] })) } },
});
const PLAN_SCRIPT: Turn[] = [
  plan("in_progress", "pending", "pending"),
  { call: { name: "read_file", args: { path: "src/sum.js" } } },
  plan("completed", "in_progress", "pending"),
  { text: "The loop stops one element early.", call: { name: "apply_patch", args: { patch: FIX_PATCH } } },
  plan("completed", "completed", "in_progress"),
  { call: { name: "finish", args: { summary: "Fixed the loop bound in sum(); the tests were not run.", title: "Fix the loop bound in sum()" } } },
];
const CHAT_TURN: Turn = { text: "I can fix the loop bound or rewrite sum() with reduce. Which do you prefer?" };
const CHOOSE_TURN: Turn = {
  call: {
    name: "ask_user",
    args: {
      question: "Which fix do you want?",
      options: [{ label: "Fix the loop bound", description: "Change the loop condition in sum()" }, { label: "Rewrite with reduce" }],
    },
  },
};
const STOP_TURN: Turn = { text: "Fixed the loop bound. Do you want anything else?" };
const MD_TURN: Turn = {
  text: ["## Two options", "", "I can fix this in **two** ways:", "", "- Fix the loop bound in `sum()`", "- Rewrite it with reduce", "", "```js", "values.reduce((a, b) => a + b, 0);", "```", "", "| Option | Lines |", "| - | - |", "| Loop bound | 1 |", "", "See the [docs](https://example.com/reduce)."].join("\n"),
};
const PAGE = ["<!doctype html>", "<title>Demo</title>", '<h1 id="title">Loading</h1>', '<script>document.getElementById("title").textContent = "Hello from the page";</script>', ""].join("\n");
const HTML_TURNS: Turn[] = [
  { text: "Writing the page.", call: { name: "write_file", args: { path: "index.html", content: PAGE } } },
  { call: { name: "write_file", args: { path: "app.js", content: 'console.log("app");\n' } } },
  { text: "The page is ready. Open the preview to see it." },
];
const LAST: Turn = { call: { name: "finish", args: { summary: "Nothing more to do." } } };

interface ChatBody {
  model?: string;
  reasoning_effort?: string;
  messages?: { role: string; content?: string | null }[];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: ChatBody;
  try {
    body = JSON.parse(await readBody(req)) as ChatBody;
  } catch {
    res.writeHead(400, { "content-type": "application/json" }).end('{"error":"invalid JSON"}');
    return;
  }
  const messages = body.messages ?? [];
  const task = messages.find((m) => m.role === "user")?.content ?? "";
  const played = messages.filter((m) => m.role === "assistant").length;
  const ask = task.includes("[ask]");
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const classify = system.includes("You sort requests");
  const review = system.includes("code reviewer");
  const script = review ? REVIEW_SCRIPT : task.includes("[md]") ? [MD_TURN, ...SCRIPT] : task.includes("[html]") ? HTML_TURNS : task.includes("[plan]") ? PLAN_SCRIPT : ask
          ? [...ASK_TURNS, ...SCRIPT]
          : task.includes("[chat]")
            ? [CHAT_TURN, ...SCRIPT]
            : task.includes("[choose]")
              ? [CHOOSE_TURN, ...SCRIPT]
              : task.includes("[stop]")
                ? [...SCRIPT.slice(0, 4), STOP_TURN, ...SCRIPT.slice(4)]
                : SCRIPT;
  const turn = classify ? { text: task.includes("[complex]") ? "complex" : "daily" } : (script[played] ?? LAST);
  console.log(`[fake-model] turn ${played}: ${turn.call?.name ?? "text"}`);

  if (task.includes("[fail]")) {
    res.writeHead(500, { "content-type": "application/json" }).end('{"error":"fake failure"}');
    return;
  }
  if (task.includes("[slow]")) await sleep(8000);

  const model = body.model ?? "fake-model";
  const chunk = (delta: Record<string, unknown>) =>
    res.write(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  if (!classify && body.reasoning_effort !== undefined && body.reasoning_effort !== "none") {
    for (const word of "Working out the next step from what the task asks.".split(/(?<= )/)) {
      chunk({ reasoning: word });
      await sleep(40);
    }
  }
  if (turn.text) {
    // Stream the text word by word so the UI's token streaming can be seen.
    for (const word of turn.text.split(/(?<= )/)) {
      chunk({ content: word });
      await sleep(40);
    }
  }
  if (turn.call) {
    const id = `call_${played}_${Math.random().toString(36).slice(2, 8)}`;
    const args = JSON.stringify(turn.call.args);
    const mid = Math.ceil(args.length / 2);
    chunk({ tool_calls: [{ index: 0, id, type: "function", function: { name: turn.call.name, arguments: "" } }] });
    chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(0, mid) } }] }); // split like real providers do
    chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(mid) } }] });
  }
  const promptTokens = task.includes("[costly]") ? 150_000 : Math.ceil(JSON.stringify(messages).length / 4);
  res.write(`data: ${JSON.stringify({ id: "fake", model, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 30 } })}\n\n`);
  res.end("data: [DONE]\n\n");
}

export function startFakeModel(port: number) {
  const server = createServer((req, res) => {
    if (req.method === "POST" && (req.url ?? "").endsWith("/chat/completions")) {
      chat(req, res).catch((e: unknown) => {
        console.error("[fake-model]", e);
        res.destroy();
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
  });
  server.listen(port, () => console.log(`[fake-model] listening on http://localhost:${port}`));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startFakeModel(Number(process.env["PORT"] ?? 8788));
}
