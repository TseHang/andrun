import { describe, expect, it } from "vitest";
import { createSession, runAgent } from "../../src/core/agent";
import { defaultConfig } from "../../src/core/config";
import { TOOL_OUTPUT_CAP, capToolOutput, compactForRequest, estimateTokens } from "../../src/core/context";
import type { AgentEvent } from "../../src/core/events";
import { getProfile } from "../../src/core/modes";
import type { ChatMessage } from "../../src/core/types";
import { MemorySandbox } from "../support/memory-sandbox";
import { ScriptedModelClient, call } from "../support/scripted-model";

function bigConversation(steps: number, toolChars: number): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: "Fix the failing test." },
  ];
  for (let i = 0; i < steps; i++) {
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: `src/f${i}.js` }) } }],
    });
    messages.push({ role: "tool", tool_call_id: `c${i}`, content: `${i}`.repeat(toolChars) });
  }
  return messages;
}

describe("S9: context stays inside the window (D17)", () => {
  it("caps tool output", async () => {
    const big = `HEAD${"x".repeat(50_000)}TAIL`;
    const capped = capToolOutput(big);
    expect(capped.length).toBeLessThanOrEqual(TOOL_OUTPUT_CAP);
    expect(capped.startsWith("HEAD")).toBe(true);
    expect(capped.endsWith("TAIL")).toBe(true);
    expect(capped).toMatch(/\[… \d+ bytes elided\]/);
    expect(capToolOutput("short")).toBe("short");

    // Through the loop: a 50 KB file read reaches the model capped.
    const model = new ScriptedModelClient([call("read_file", { path: "big.txt" }), call("finish", { summary: "done" })]);
    await runAgent(
      createSession({ sessionId: "s", mode: "code", task: "t" }, getProfile("code", defaultConfig)),
      getProfile("code", defaultConfig),
      { model, sandbox: new MemorySandbox({ "big.txt": big }), emit: () => {}, config: defaultConfig },
    );
    const toolMsg = model.requests[1]!.messages.find((m) => m.role === "tool")!;
    expect(toolMsg.content.length).toBeLessThanOrEqual(TOOL_OUTPUT_CAP);
  });

  it("compacts old tool results above 70%", () => {
    const messages = bigConversation(12, 7000);
    const contextWindow = Math.ceil(estimateTokens(messages) / 0.75);
    const out = compactForRequest(messages, { contextWindow });

    expect(out).toHaveLength(messages.length);
    expect(out[0]).toEqual(messages[0]);
    expect(out[1]).toEqual(messages[1]);

    const tools = out.filter((m) => m.role === "tool");
    for (const t of tools.slice(0, 6)) {
      expect(t.content.length).toBeLessThan(200);
      expect(t.content).toContain("read_file");
      expect(t.content).toContain("elided");
    }
    const originalTools = messages.filter((m) => m.role === "tool");
    expect(tools.slice(6)).toEqual(originalTools.slice(6));
    expect(estimateTokens(out)).toBeLessThan(0.7 * contextWindow);

    // Input is not mutated, and small conversations pass through unchanged.
    expect(messages.filter((m) => m.role === "tool")[0]!.content.length).toBe(7000);
    const small = bigConversation(2, 100);
    expect(compactForRequest(small, { contextWindow: 128_000 })).toEqual(small);
  });

  it("usage events report context size and window", async () => {
    const events: AgentEvent[] = [];
    const config = { ...defaultConfig, contextWindows: { scripted: 50_000 } };
    const profile = { ...getProfile("code", config), model: "scripted" };
    await runAgent(createSession({ sessionId: "s", mode: "code", task: "t" }, profile), profile, {
      model: new ScriptedModelClient([call("list_files"), call("finish", { summary: "done" })]),
      sandbox: new MemorySandbox({ "a.js": "x" }),
      emit: (e) => events.push(e),
      config,
    });
    const usage = events.filter((e) => e.type === "usage");
    expect(usage).toHaveLength(2);
    for (const u of usage) {
      expect(u.context_window).toBe(50_000);
      expect(u.context_tokens).toBeGreaterThan(0);
      expect(u.context_tokens).toBeLessThan(0.7 * 50_000);
    }
  });
});
