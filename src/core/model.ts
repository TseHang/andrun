// OpenAI-compatible streaming chat client for ai& Inference (ADR D1, D19, S-b).
// Web-standard APIs only: this file runs inside a Durable Object.

import { ModelError } from "./types";
import type { ModelClient, ModelRequest, ModelResponse, ToolCall } from "./types";

export interface OpenAICompatOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  /** Extra attempts after the first (default 2). */
  retries?: number;
  /** Attempt n waits backoffMs * 2^(n-1); 0 disables waiting (default 500). */
  backoffMs?: number;
}

interface ChunkToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface Chunk {
  model?: string;
  choices?: { delta?: { content?: string | null; tool_calls?: ChunkToolCall[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class OpenAICompatModelClient implements ModelClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly retries: number;
  private readonly backoffMs: number;

  constructor(opts: OpenAICompatOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.fetchFn = opts.fetch ?? ((...a) => fetch(...a));
    this.retries = opts.retries ?? 2;
    this.backoffMs = opts.backoffMs ?? 500;
  }

  async complete(req: ModelRequest, onDelta?: (text: string) => void): Promise<ModelResponse> {
    const started = Date.now();
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    const payload = JSON.stringify(body);

    let lastError: ModelError | undefined;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0 && this.backoffMs > 0) await sleep(this.backoffMs * 2 ** (attempt - 1));

      let res: Response;
      try {
        res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
            accept: "text/event-stream",
          },
          body: payload,
          signal: req.signal,
        });
      } catch (err) {
        if (req.signal?.aborted) throw err;
        lastError = new ModelError(`ai& API network error: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const error = new ModelError(`ai& API ${res.status}: ${text.slice(0, 200)}`, res.status);
        if (res.status === 429 || res.status >= 500) {
          lastError = error;
          continue;
        }
        throw error;
      }

      return this.readStream(res, req, started, onDelta);
    }
    throw lastError ?? new ModelError("ai& API request failed");
  }

  private async readStream(
    res: Response,
    req: ModelRequest,
    started: number,
    onDelta?: (text: string) => void,
  ): Promise<ModelResponse> {
    let content = "";
    let model: string | undefined;
    const usage = { tokens_in: 0, tokens_out: 0 };
    const calls = new Map<number, { id?: string; name: string; arguments: string }>();
    let lastKey = 0;

    const handle = (chunk: Chunk) => {
      if (chunk.model) model = chunk.model;
      if (chunk.usage) {
        usage.tokens_in = chunk.usage.prompt_tokens ?? 0;
        usage.tokens_out = chunk.usage.completion_tokens ?? 0;
      }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) return;
      if (delta.content) {
        content += delta.content;
        onDelta?.(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        // Without an index, a new id starts the next call; fragments without an id continue the last one.
        const prevId = calls.get(lastKey)?.id;
        const key = tc.index ?? (tc.id && prevId && tc.id !== prevId ? lastKey + 1 : lastKey);
        lastKey = key;
        let acc = calls.get(key);
        if (!acc) {
          acc = { name: "", arguments: "" };
          calls.set(key, acc);
        }
        if (tc.id) acc.id = tc.id;
        // Some OpenAI-compatible servers repeat the name on every fragment; keep the first.
        if (tc.function?.name && !acc.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.arguments += tc.function.arguments;
      }
    };

    let done = false;
    const processEvent = (event: string) => {
      const dataLines: string[] = [];
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue; // comments and other fields
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      if (dataLines.length === 0) return;
      const data = dataLines.join("\n");
      if (data.trim() === "[DONE]") {
        done = true;
        return;
      }
      let chunk: Chunk;
      try {
        chunk = JSON.parse(data) as Chunk;
      } catch {
        return; // ignore malformed keep-alive style payloads
      }
      handle(chunk);
    };

    if (res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!done) {
          const { value, done: eof } = await reader.read();
          if (eof) break;
          buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
          // A lone trailing \r stays buffered and pairs with a \n in the next chunk.
          let sep: number;
          while (!done && (sep = buffer.indexOf("\n\n")) !== -1) {
            processEvent(buffer.slice(0, sep));
            buffer = buffer.slice(sep + 2);
          }
        }
        buffer += decoder.decode();
        buffer = buffer.replace(/\r\n/g, "\n");
        if (!done && buffer.trim()) processEvent(buffer);
      } finally {
        if (done) await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }

    const toolCalls: ToolCall[] = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, c]) => ({
        id: c.id ?? `call_${index}`,
        type: "function" as const,
        function: { name: c.name, arguments: c.arguments },
      }));

    return {
      content: content === "" ? null : content,
      toolCalls,
      usage,
      latency_ms: Date.now() - started,
      model: model ?? req.model,
    };
  }
}
