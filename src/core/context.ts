// Context management (ADR D17): cap tool output, stub old tool results. No LLM call.

import type { ChatMessage } from "./types";

export const TOOL_OUTPUT_CAP = 8192;
const MESSAGE_OVERHEAD = 4;

export function capToolOutput(text: string, cap = TOOL_OUTPUT_CAP): string {
  if (text.length <= cap) return text;
  // Marker length depends on the digit count of N, so reserve room for the widest case.
  const marker = (n: number) => `\n[… ${n} bytes elided]\n`;
  const keep = Math.max(0, cap - marker(text.length).length);
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return text.slice(0, head) + marker(text.length - keep) + (tail > 0 ? text.slice(text.length - tail) : "");
}

export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += MESSAGE_OVERHEAD * 4 + (m.content?.length ?? 0);
    if (m.role === "assistant") {
      for (const tc of m.tool_calls ?? []) chars += tc.function.name.length + tc.function.arguments.length;
    }
  }
  return Math.ceil(chars / 4);
}

function argSummary(args: string): string {
  let text = args;
  try {
    const parsed: unknown = JSON.parse(args);
    if (parsed && typeof parsed === "object") {
      const first = Object.values(parsed).find((v) => typeof v === "string");
      text = typeof first === "string" ? first : args;
    }
  } catch {
    // keep raw arguments
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

export function compactForRequest(
  messages: ChatMessage[],
  /** reservedTokens: prompt space not in `messages`, e.g. the tool specs. */
  opts: { contextWindow: number; threshold?: number; keepLastSteps?: number; reservedTokens?: number },
): ChatMessage[] {
  const { contextWindow, threshold = 0.7, keepLastSteps = 6, reservedTokens = 0 } = opts;
  if (estimateTokens(messages) + reservedTokens <= threshold * contextWindow) return [...messages];

  // Index of the first assistant turn that is kept; everything before it is "old".
  let seen = 0;
  let cutoff = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant" && ++seen === keepLastSteps) {
      cutoff = i;
      break;
    }
  }

  const calls = new Map<string, { name: string; arguments: string }>();
  return messages.map((m, i) => {
    if (m.role === "assistant") {
      for (const tc of m.tool_calls ?? []) calls.set(tc.id, tc.function);
      return m;
    }
    if (m.role !== "tool" || i >= cutoff) return m;
    const fn = calls.get(m.tool_call_id);
    const label = fn ? `${fn.name} ${argSummary(fn.arguments)}`.trim() : "tool result";
    return { ...m, content: `[${label} — output elided to save context]` };
  });
}
