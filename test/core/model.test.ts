import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSession, runAgent } from "../../src/core/agent";
import { defaultConfig } from "../../src/core/config";
import type { AgentEvent } from "../../src/core/events";
import { OpenAICompatModelClient } from "../../src/core/model";
import { getProfile } from "../../src/core/modes";
import { ModelError } from "../../src/core/types";
import { MemorySandbox } from "../support/memory-sandbox";
import { ScriptedModelClient, call } from "../support/scripted-model";

const FIXTURES = join(import.meta.dirname, "../fixtures");

/** A fetch stub that serves a sequence of responses and records requests. */
function fakeFetch(responses: (() => Response)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next();
  }) as typeof fetch;
  return { fn, calls };
}

const sse = (body: string) => () =>
  new Response(
    new ReadableStream({
      start(c) {
        // Deliver in awkward 37-byte pieces so the parser must handle split lines.
        const bytes = new TextEncoder().encode(body);
        for (let i = 0; i < bytes.length; i += 37) c.enqueue(bytes.slice(i, i + 37));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

const status = (code: number) => () => new Response(`{"error":{"message":"upstream ${code}"}}`, { status: code });

const client = (fetchFn: typeof fetch) =>
  new OpenAICompatModelClient({ baseUrl: "https://api.example.test/v1", apiKey: "test-key", fetch: fetchFn, backoffMs: 0 });

describe("S8: SSE tool-call assembly", () => {
  it("keeps parallel tool calls apart when the server omits index", async () => {
    const chunk = (tc: unknown) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [tc] } }] })}\n\n`;
    const body =
      chunk({ id: "a", type: "function", function: { name: "read_file", arguments: '{"path":' } }) +
      chunk({ function: { arguments: '"x.js"}' } }) +
      chunk({ id: "b", type: "function", function: { name: "read_file", arguments: '{"path":"y.js"}' } }) +
      "data: [DONE]\n\n";
    const res = await client(fakeFetch([sse(body)]).fn).complete({ model: "m", messages: [], tools: [] });
    expect(res.toolCalls.map((c) => [c.id, JSON.parse(c.function.arguments).path])).toEqual([["a", "x.js"], ["b", "y.js"]]);
  });

  it("keeps parallel tool calls apart when the server reuses index 0", async () => {
    const chunk = (tc: unknown) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [tc] } }] })}\n\n`;
    const body =
      chunk({ index: 0, id: "a", type: "function", function: { name: "read_file", arguments: '{"path":"x.js"}' } }) +
      chunk({ index: 0, id: "b", type: "function", function: { name: "list_files", arguments: "{}" } }) +
      "data: [DONE]\n\n";
    const res = await client(fakeFetch([sse(body)]).fn).complete({ model: "m", messages: [], tools: [] });
    expect(res.toolCalls.map((c) => [c.id, c.function.name, c.function.arguments])).toEqual([
      ["a", "read_file", '{"path":"x.js"}'],
      ["b", "list_files", "{}"],
    ]);
  });

  it("assembles split tool-call args from an OpenAI-format stream", async () => {
    const f = fakeFetch([sse(readFileSync(join(FIXTURES, "openai-sse/tool-call.txt"), "utf8"))]);
    const deltas: string[] = [];
    const res = await client(f.fn).complete(
      { model: "fixture-model", messages: [{ role: "user", content: "hi" }], tools: [] },
      (d) => deltas.push(d),
    );
    expect(deltas.join("")).toBe("Let me run the tests.");
    expect(res.content).toBe("Let me run the tests.");
    expect(res.toolCalls).toHaveLength(2);
    expect(res.toolCalls[0]).toMatchObject({ id: "call_abc", type: "function", function: { name: "run_command" } });
    expect(JSON.parse(res.toolCalls[0]!.function.arguments)).toEqual({ command: "npm test" });
    expect(JSON.parse(res.toolCalls[1]!.function.arguments)).toEqual({ path: "src/sum.js" });
    expect(res.usage).toEqual({ tokens_in: 120, tokens_out: 30 });
    expect(res.model).toBe("fixture-model");
    expect(res.latency_ms).toBeGreaterThanOrEqual(0);
  });

  const recorded = join(FIXTURES, "aiand-sse/tool-call.txt");
  it.skipIf(!existsSync(recorded))("assembles split tool-call args from recorded ai& stream", async () => {
    const f = fakeFetch([sse(readFileSync(recorded, "utf8"))]);
    const res = await client(f.fn).complete({ model: "x", messages: [{ role: "user", content: "hi" }], tools: [] });
    expect(res.toolCalls.length).toBeGreaterThan(0);
    for (const c of res.toolCalls) expect(() => JSON.parse(c.function.arguments)).not.toThrow();
    expect(res.usage.tokens_in).toBeGreaterThan(0);
  });

  it("sends an OpenAI-compatible streaming request with the bearer key", async () => {
    const f = fakeFetch([sse(readFileSync(join(FIXTURES, "openai-sse/tool-call.txt"), "utf8"))]);
    await client(f.fn).complete({
      model: "m1",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "read_file", description: "Read", parameters: { type: "object", properties: {} } }],
    });
    expect(f.calls[0]!.url).toBe("https://api.example.test/v1/chat/completions");
    expect(new Headers(f.calls[0]!.init.headers).get("authorization")).toBe("Bearer test-key");
    const body = JSON.parse(String(f.calls[0]!.init.body));
    expect(body).toMatchObject({ model: "m1", stream: true, stream_options: { include_usage: true } });
    expect(body.tools[0]).toEqual({
      type: "function",
      function: { name: "read_file", description: "Read", parameters: { type: "object", properties: {} } },
    });
  });
});

describe("S7: model failures are visible", () => {
  it("retries twice then fails visibly", async () => {
    // Direct: 3 × 500 → ModelError carrying the status.
    const direct = fakeFetch([status(500), status(500), status(500)]);
    await expect(
      client(direct.fn).complete({ model: "m", messages: [{ role: "user", content: "x" }], tools: [] }),
    ).rejects.toSatisfy((e: unknown) => e instanceof ModelError && e.status === 500);
    expect(direct.calls).toHaveLength(3);

    // Non-retryable 4xx fails immediately.
    const auth = fakeFetch([status(401)]);
    await expect(
      client(auth.fn).complete({ model: "m", messages: [{ role: "user", content: "x" }], tools: [] }),
    ).rejects.toBeInstanceOf(ModelError);
    expect(auth.calls).toHaveLength(1);

    // Through the loop: failed outcome, error{source:model} naming the status, status(failed).
    const events: AgentEvent[] = [];
    const profile = getProfile("code", defaultConfig);
    const { outcome } = await runAgent(createSession({ sessionId: "s", mode: "code", task: "t" }, profile), profile, {
      model: client(fakeFetch([status(500), status(500), status(500)]).fn),
      sandbox: new MemorySandbox(),
      emit: (e) => events.push(e),
      config: defaultConfig,
    });
    expect(outcome.kind).toBe("failed");
    const err = events.find((e) => e.type === "error");
    expect(err).toMatchObject({ source: "model" });
    expect(err?.type === "error" && err.message).toContain("500");
    expect(events.at(-1)).toMatchObject({ type: "status", status: "failed" });
  });

  it("recovers when a retry succeeds", async () => {
    const events: AgentEvent[] = [];
    const finishStream = [
      `data: {"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c","type":"function","function":{"name":"finish","arguments":"{\\"summary\\":\\"ok\\"}"}}]}}]}`,
      `data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}`,
      "data: [DONE]",
      "",
    ].join("\n\n");
    const profile = getProfile("code", defaultConfig);
    const { outcome } = await runAgent(createSession({ sessionId: "s", mode: "code", task: "t" }, profile), profile, {
      model: client(fakeFetch([status(500), status(503), sse(finishStream)]).fn),
      sandbox: new MemorySandbox(),
      emit: (e) => events.push(e),
      config: defaultConfig,
    });
    expect(outcome.kind).toBe("awaiting_approval");
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});

describe("S11: per-mode model and usage attribution (D19)", () => {
  it("uses per-mode model id and reports it in usage", async () => {
    const config = { ...defaultConfig, models: { code: "coder-x", review: "reviewer-y", task: "chat-z" } };
    for (const mode of ["code", "review"] as const) {
      const profile = getProfile(mode, config);
      expect(profile.model).toBe(config.models[mode]);
      const model = new ScriptedModelClient([call("finish", { summary: "done" })]);
      const events: AgentEvent[] = [];
      await runAgent(createSession({ sessionId: "s", mode, task: "t" }, profile), profile, {
        model,
        sandbox: new MemorySandbox(),
        emit: (e) => events.push(e),
        config,
      });
      expect(model.requests[0]!.model).toBe(config.models[mode]);
      const usage = events.filter((e) => e.type === "usage");
      expect(usage.length).toBeGreaterThan(0);
      for (const u of usage) expect(u.model).toBe(config.models[mode]);
    }
  });

  it("computes cost when prices are configured", async () => {
    const config = { ...defaultConfig, prices: { "coder-x": { in: 1, out: 2 } }, models: { ...defaultConfig.models, code: "coder-x" } };
    const profile = getProfile("code", config);
    const events: AgentEvent[] = [];
    await runAgent(createSession({ sessionId: "s", mode: "code", task: "t" }, profile), profile, {
      model: new ScriptedModelClient([call("finish", { summary: "d" }, { in: 1_000_000, out: 500_000 })]),
      sandbox: new MemorySandbox(),
      emit: (e) => events.push(e),
      config,
    });
    expect(events.find((e) => e.type === "usage")).toMatchObject({ cost: 2 });
  });
});
