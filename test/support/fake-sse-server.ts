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
//   [ask]   the first turn runs `rm -rf tmp` (not on the allowlist, so the run stops at an approval
//           gate); after that the normal script plays from the start

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

interface Turn {
  text?: string;
  call: { name: string; args: Record<string, unknown> };
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
  { call: { name: "finish", args: { summary: "Fixed the loop bound in sum(): it skipped the last element." } } },
  // Played after a reject or a follow-up message.
  { text: "Adding the requested test.", call: { name: "write_file", args: { path: "test/empty.test.js", content: EMPTY_TEST } } },
  { call: { name: "run_command", args: { command: "npm test" } } },
  { call: { name: "finish", args: { summary: "Added a test for the empty array case; all tests pass." } } },
];
const ASK_TURN: Turn = { call: { name: "run_command", args: { command: "rm -rf tmp" } } };
const LAST: Turn = { call: { name: "finish", args: { summary: "Nothing more to do." } } };

interface ChatBody {
  model?: string;
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
  const turn = ask && played === 0 ? ASK_TURN : (SCRIPT[ask ? played - 1 : played] ?? LAST);
  console.log(`[fake-model] turn ${played}: ${turn.call.name}`);

  if (task.includes("[fail]")) {
    res.writeHead(500, { "content-type": "application/json" }).end('{"error":"fake failure"}');
    return;
  }
  if (task.includes("[slow]")) await sleep(8000);

  const model = body.model ?? "fake-model";
  const chunk = (delta: Record<string, unknown>) =>
    res.write(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  if (turn.text) {
    // Stream the text word by word so the UI's token streaming can be seen.
    for (const word of turn.text.split(/(?<= )/)) {
      chunk({ content: word });
      await sleep(40);
    }
  }
  const id = `call_${played}_${Math.random().toString(36).slice(2, 8)}`;
  const args = JSON.stringify(turn.call.args);
  const mid = Math.ceil(args.length / 2);
  chunk({ tool_calls: [{ index: 0, id, type: "function", function: { name: turn.call.name, arguments: "" } }] });
  chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(0, mid) } }] }); // split like real providers do
  chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(mid) } }] });
  const promptTokens = Math.ceil(JSON.stringify(messages).length / 4);
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
