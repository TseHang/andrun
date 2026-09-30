import type { ModelClient, ModelRequest, ModelResponse, ToolCall } from "../../src/core/types";

export interface ScriptTurn {
  text?: string;
  /** `args` may be a raw string to simulate malformed JSON from the model. */
  calls?: { name: string; args: unknown }[];
  usage?: { in: number; out: number };
}

export type ScriptStep = ScriptTurn | Error | ((req: ModelRequest) => ScriptTurn);

/** Replays a fixed sequence of model turns and records every request it receives. */
export class ScriptedModelClient implements ModelClient {
  readonly requests: ModelRequest[] = [];
  private callCounter = 0;

  constructor(
    private readonly steps: ScriptStep[],
    private readonly modelId = "scripted",
  ) {}

  async complete(req: ModelRequest, onDelta?: (text: string) => void): Promise<ModelResponse> {
    this.requests.push(structuredClone({ ...req, signal: undefined }));
    const next = this.steps.shift();
    if (next === undefined) throw new Error("script exhausted");
    if (next instanceof Error) throw next;
    const turn = typeof next === "function" ? next(req) : next;

    if (turn.text && onDelta) {
      const mid = Math.ceil(turn.text.length / 2);
      onDelta(turn.text.slice(0, mid));
      onDelta(turn.text.slice(mid));
    }
    const toolCalls: ToolCall[] = (turn.calls ?? []).map((c) => ({
      id: `call_${++this.callCounter}`,
      type: "function",
      function: {
        name: c.name,
        arguments: typeof c.args === "string" ? c.args : JSON.stringify(c.args),
      },
    }));
    return {
      content: turn.text ?? null,
      toolCalls,
      usage: { tokens_in: turn.usage?.in ?? 100, tokens_out: turn.usage?.out ?? 20 },
      latency_ms: 1,
      model: req.model,
    };
  }

  get remaining(): number {
    return this.steps.length;
  }
}

/** Shorthand for a turn with one tool call. */
export const call = (name: string, args: unknown = {}, usage?: ScriptTurn["usage"]): ScriptTurn => ({
  calls: [{ name, args }],
  usage,
});
