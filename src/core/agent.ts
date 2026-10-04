// The agent loop (ADR D2, D3): a plain while loop. Approval is a return value; `resume` continues from it.
// Everything a run needs travels in one `RunContext`; there is no module-level state.

import { contextWindowFor } from "./config";
import { compactForRequest, estimateTokens } from "./context";
import { summarizeDiff } from "./diff";
import type { DiffSummary, EventBody } from "./events";
import { executeTool, summarizeCall, toolSpecs, type ToolResult } from "./tools";
import type {
  SandboxAdapter,
  AgentDeps,
  AgentState,
  ApprovalDecision,
  ChatMessage,
  ModeName,
  ModeProfile,
  PendingApproval,
  RunOutcome,
  ToolCall,
  ToolName,
} from "./types";

const MAX_STRIKES = 3;
const TURN_LIMIT_NEXT = "Send a message to continue.";
const UI_RESULT_CHARS = 2000;

interface RunContext {
  state: AgentState;
  profile: ModeProfile;
  deps: AgentDeps;
}

export interface RunResult {
  state: AgentState;
  outcome: RunOutcome;
}

export function createSession(input: { sessionId: string; mode: ModeName; task: string }, profile: ModeProfile): AgentState {
  return {
    sessionId: input.sessionId,
    mode: input.mode,
    status: "idle",
    messages: [
      { role: "system", content: profile.systemPrompt },
      { role: "user", content: input.task },
    ],
    step: 0,
    tokensUsed: 0,
    turnCost: 0,
    turnTokens: 0,
    nextSeq: 1,
    failures: null,
    pending: null,
  };
}

export async function runAgent(state: AgentState, profile: ModeProfile, deps: AgentDeps): Promise<RunResult> {
  const ctx: RunContext = { state: structuredClone(state), profile, deps };
  if (ctx.state.status !== "running") setStatus(ctx, "running");
  const outcome = await guarded(ctx, () => loop(ctx));
  return { state: ctx.state, outcome };
}

export async function resume(
  state: AgentState,
  decision: ApprovalDecision,
  profile: ModeProfile,
  deps: AgentDeps,
): Promise<RunResult> {
  const ctx: RunContext = { state: structuredClone(state), profile, deps };
  const pending = ctx.state.pending;
  if (!pending) throw new Error("resume: no pending approval");

  if (pending.kind === "question") {
    // The answer is a user message, not an approval.
    emit(ctx, { type: "message", id: crypto.randomUUID(), role: "user", text: decision.comment ?? "" });
  } else {
    emit(ctx, {
      type: "approval_resolved",
      approvalId: pending.approvalId,
      approved: decision.approved,
      ...(decision.comment !== undefined && { comment: decision.comment }),
    });
  }
  ctx.state.pending = null;
  setStatus(ctx, "running");

  const outcome = await guarded(ctx, async () => (await applyDecision(ctx, pending, decision)) ?? (await loop(ctx)));
  return { state: ctx.state, outcome };
}

/** A thrown sandbox call (e.g. diff) ends the run as `failed`, with every open tool_call answered. */
async function guarded(ctx: RunContext, run: () => Promise<RunOutcome>): Promise<RunOutcome> {
  try {
    return await run();
  } catch (err) {
    ctx.state.pending = null;
    const answered = new Set(ctx.state.messages.flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : [])));
    for (const m of ctx.state.messages) {
      if (m.role !== "assistant") continue;
      for (const call of m.tool_calls ?? []) {
        if (!answered.has(call.id)) toolMessage(ctx, call, JSON.stringify({ error: "the run failed" }));
      }
    }
    return fail(ctx, "sandbox", err instanceof Error ? err.message : String(err));
  }
}

/** Applies the human's decision to what was pending. Returns an outcome if the run ends here, else null. */
async function applyDecision(ctx: RunContext, pending: PendingApproval, decision: ApprovalDecision): Promise<RunOutcome | null> {
  const { state } = ctx;
  const comment = decision.comment ?? "";

  switch (pending.kind) {
    case "tool": {
      if (!decision.approved) {
        toolMessage(ctx, pending.call, JSON.stringify({ rejected: true, comment }));
        for (const call of pending.remaining) {
          toolMessage(ctx, call, JSON.stringify({ skipped: "a previous call in this turn was rejected" }));
        }
        return null;
      }
      if (pending.call.function.name === "finish") return done(ctx, pending.summary ?? "", pending.call, pending.remaining);
      // Approved by a human: no policy re-check for this call, but the rest of the turn is checked normally.
      const strikes = await executeCall(ctx, pending.call, pending.remaining);
      if (strikes) return strikes;
      const outcome = await processCalls(ctx, pending.remaining);
      if (outcome) return outcome;
      checkpoint(ctx);
      return null;
    }
    case "strikes":
      state.failures = null;
      userMessage(ctx, decision.approved ? ["Continue.", comment].filter(Boolean).join(" ") : comment);
      return null;
    case "implicit_finish":
      if (decision.approved) return done(ctx, pending.summary);
      userMessage(ctx, comment);
      return null;
    case "question": {
      toolMessage(ctx, pending.call, JSON.stringify({ answer: comment }));
      const outcome = await processCalls(ctx, pending.remaining);
      if (outcome) return outcome;
      checkpoint(ctx);
      return null;
    }
  }
}

// ---------- The loop: one iteration is one model turn ----------

async function loop(ctx: RunContext): Promise<RunOutcome> {
  const { state, profile, deps } = ctx;
  const { config } = deps;

  while (true) {
    if (deps.signal?.aborted) return fail(ctx, "sandbox", String(deps.signal.reason ?? "aborted"));

    for (const text of deps.drainUserMessages?.() ?? []) {
      userMessage(ctx, text);
      emit(ctx, { type: "message", id: crypto.randomUUID(), role: "user", text });
    }

    if (config.maxSteps !== undefined && state.step >= config.maxSteps) return budget(ctx, `step limit reached (${config.maxSteps})`);
    // Also here: a turn that passed its limit and then paused at a gate must not get another model call.
    const over = turnLimit(ctx);
    if (over) return over;
    state.step++;

    const contextWindow = contextWindowFor(config, profile.model);
    const tools = toolSpecs(profile.tools, profile.toolNotes);
    const reservedTokens = Math.ceil(JSON.stringify(tools).length / 4);
    const requestMessages = compactForRequest(state.messages, { contextWindow, reservedTokens });
    const messageId = `m${state.step}`;

    let response;
    try {
      response = await deps.model.complete(
        { model: profile.model, messages: requestMessages, tools, signal: deps.signal },
        (text) => emit(ctx, { type: "message_delta", id: messageId, text }),
      );
    } catch (err) {
      return fail(ctx, "model", err instanceof Error ? err.message : String(err));
    }

    const { tokens_in, tokens_out } = response.usage;
    state.tokensUsed += tokens_in + tokens_out;
    const price = config.prices?.[profile.model];
    const cost = price ? (tokens_in * price.in + tokens_out * price.out) / 1e6 : 0;
    // A provider that reports no usage must not switch the limit off: the request's estimated size counts instead.
    const counted = tokens_in + tokens_out > 0 ? tokens_in + tokens_out : estimateTokens(requestMessages) + reservedTokens;
    state.turnCost += (price && tokens_in + tokens_out === 0 ? (counted * price.in) / 1e6 : cost);
    state.turnTokens += counted;
    emit(ctx, {
      type: "usage",
      model: response.model,
      tokens_in,
      tokens_out,
      latency_ms: response.latency_ms,
      context_tokens: tokens_in, // what the provider counted for this request
      context_window: contextWindow,
      ...(price && { cost }),
    });

    if (response.content) emit(ctx, { type: "message", id: messageId, role: "assistant", text: response.content });
    state.messages.push({
      role: "assistant",
      content: response.content,
      ...(response.toolCalls.length > 0 && { tool_calls: response.toolCalls }),
    });

    if (response.toolCalls.length === 0) {
      // The turn limit wins over a reply.
      const over = turnLimit(ctx);
      if (over) return over;
      if (profile.onTextReply === "wait") {
        setStatus(ctx, "awaiting_input");
        checkpoint(ctx);
        return { kind: "awaiting_input" };
      }
      return textReplyFinish(ctx, response.content ?? "");
    } else {
      const outcome = await processCalls(ctx, response.toolCalls);
      if (outcome) return outcome;
    }

    checkpoint(ctx);
    const stop = turnLimit(ctx);
    if (stop) return stop;
  }
}

// ---------- Tool calls ----------

/** Runs the calls of one model turn in order. Returns an outcome if the run pauses or ends inside the turn. */
async function processCalls(ctx: RunContext, calls: ToolCall[]): Promise<RunOutcome | null> {
  const { profile, deps, state } = ctx;

  for (const [i, call] of calls.entries()) {
    const name = call.function.name;
    const args = parseArgs(call.function.arguments);
    const remaining = calls.slice(i + 1);
    emit(ctx, { type: "tool_call", callId: call.id, name, args, summary: summarizeCall(name, args) });

    // Unknown tools skip the policy; executeTool answers "unknown tool: X".
    if (!profile.tools.includes(name as ToolName)) {
      const strikes = await executeCall(ctx, call, remaining);
      if (strikes) return strikes;
      continue;
    }

    const decision = (deps.policy ?? profile.policy).decide({ mode: state.mode, tool: name, args });

    if (decision.kind === "deny") {
      const strikes = await recordResult(ctx, call, { ok: false, error: `not allowed: ${decision.reason}` }, remaining);
      if (strikes) return strikes;
      continue;
    }

    if (decision.kind === "ask") {
      const isFinish = name === "finish";
      return pause(ctx, {
        kind: "tool",
        approvalId: crypto.randomUUID(),
        reason: decision.reason,
        call,
        remaining,
        ...(isFinish && { summary: stringArg(args, "summary"), diffSummary: await currentDiffSummary(ctx) }),
      });
    }

    if (name === "ask_user") {
      // The tool only validates; it needs no sandbox.
      const checked = await executeTool(
        { name, rawArgs: call.function.arguments },
        { sandbox: deps.sandbox as SandboxAdapter, allowed: profile.tools, timeoutMs: deps.config.commandTimeoutMs },
      );
      if (!checked.ok || !checked.question) {
        const strikes = await recordResult(ctx, call, checked, remaining);
        if (strikes) return strikes;
        continue;
      }
      const { question, options } = checked.question;
      const approvalId = crypto.randomUUID();
      state.pending = { kind: "question", approvalId, question, options, call, remaining };
      emit(ctx, { type: "question", id: approvalId, question, options });
      setStatus(ctx, "awaiting_input");
      checkpoint(ctx);
      return { kind: "awaiting_input" };
    }

    if (decision.auto) autoApprove(ctx, name, decision.auto.reason);
    if (name === "finish") return done(ctx, stringArg(args, "summary") ?? "", call, remaining);

    const strikes = await executeCall(ctx, call, remaining);
    if (strikes) return strikes;
  }
  return null;
}

async function executeCall(ctx: RunContext, call: ToolCall, remaining: ToolCall[]): Promise<RunOutcome | null> {
  const { deps, profile } = ctx;
  const { sandbox, config } = deps;

  let result: ToolResult;
  if (!sandbox) {
    result = { ok: false, error: "no sandbox in this mode" };
  } else {
    result = await executeTool(
      { name: call.function.name, rawArgs: call.function.arguments },
      {
        sandbox,
        allowed: profile.tools,
        onOutput: (stream, chunk) => emit(ctx, { type: "tool_output", callId: call.id, stream, chunk }),
        timeoutMs: config.commandTimeoutMs,
        signal: deps.signal,
      },
    );
  }
  return recordResult(ctx, call, result, remaining);
}

/** Shows the result to the UI, feeds it to the model, and tracks consecutive failures. */
async function recordResult(ctx: RunContext, call: ToolCall, result: ToolResult, remaining: ToolCall[]): Promise<RunOutcome | null> {
  const { state, deps } = ctx;
  const name = call.function.name;

  const text = result.ok ? result.output : result.error;
  emit(ctx, {
    type: "tool_output",
    callId: call.id,
    stream: "result",
    chunk: text.slice(0, UI_RESULT_CHARS),
    ...(name === "run_command" && result.exitCode !== undefined && { exitCode: result.exitCode }),
    ...(result.ok && result.meta && { meta: result.meta }),
  });
  toolMessage(ctx, call, result.ok ? result.output : JSON.stringify({ error: result.error }));

  if (result.ok) {
    state.failures = null;
    for (const path of result.changedPaths ?? []) {
      emit(ctx, { type: "file_changed", path, diff: (await deps.sandbox?.diff(path)) ?? "" });
    }
    if (result.finding) emit(ctx, { type: "review_finding", id: crypto.randomUUID(), ...result.finding });
    if (result.plan) emit(ctx, { type: "plan_updated", plan: result.plan });
    return null;
  }

  emit(ctx, { type: "error", source: "tool", message: result.error, next: "The agent sees this error and can try again." });
  state.failures = state.failures?.tool === name ? { tool: name, count: state.failures.count + 1 } : { tool: name, count: 1 };
  if (state.failures.count < MAX_STRIKES) return null;

  // Every tool_call needs exactly one tool message, so answer the rest of the turn before pausing.
  for (const rest of remaining) toolMessage(ctx, rest, JSON.stringify({ error: "skipped" }));
  return pause(ctx, {
    kind: "strikes",
    approvalId: crypto.randomUUID(),
    reason: `${name} failed ${MAX_STRIKES} times`,
    tool: name,
  });
}

function autoApprove(ctx: RunContext, tool: string, reason: string): void {
  const approvalId = crypto.randomUUID();
  emit(ctx, { type: "approval_required", approvalId, tool, reason });
  emit(ctx, { type: "approval_resolved", approvalId, approved: true, comment: reason, auto: true });
}

// ---------- Terminal outcomes ----------

function fail(ctx: RunContext, source: "model" | "sandbox", message: string): RunOutcome {
  emit(ctx, { type: "error", source, message });
  setStatus(ctx, "failed");
  return { kind: "failed", error: message };
}

/** The safety limit of one turn (HI-h): money for a priced model, tokens otherwise. Null while under it. */
function turnLimit(ctx: RunContext): RunOutcome | null {
  const { state, profile } = ctx;
  const { config } = ctx.deps;
  if (config.prices?.[profile.model]) {
    return state.turnCost >= config.maxTurnCost ? budget(ctx, `This turn reached its ¥${config.maxTurnCost} safety limit`, TURN_LIMIT_NEXT) : null;
  }
  if (state.turnTokens < config.maxTurnTokens) return null;
  return budget(ctx, `This turn reached its ${config.maxTurnTokens.toLocaleString("en-US")} token safety limit`, TURN_LIMIT_NEXT);
}

function budget(ctx: RunContext, message: string, next?: string): RunOutcome {
  emit(ctx, { type: "error", source: "budget", message, ...(next !== undefined && { next }) });
  setStatus(ctx, "budget_exceeded");
  return { kind: "budget_exceeded" };
}

/** A review's model replied with text and no tool call: it goes to the finish gate at once. */
async function textReplyFinish(ctx: RunContext, summary: string): Promise<RunOutcome> {
  const { deps, profile, state } = ctx;
  const decision = (deps.policy ?? profile.policy).decide({ mode: state.mode, tool: "finish", args: { summary } });
  if (decision.kind === "allow") {
    if (decision.auto) autoApprove(ctx, "finish", decision.auto.reason);
    return done(ctx, summary);
  }
  return pause(ctx, {
    kind: "implicit_finish",
    approvalId: crypto.randomUUID(),
    reason: decision.reason,
    summary,
    diffSummary: await currentDiffSummary(ctx),
  });
}

function pause(ctx: RunContext, pending: Exclude<PendingApproval, { kind: "question" }>): RunOutcome {
  ctx.state.pending = pending;
  emit(ctx, {
    type: "approval_required",
    approvalId: pending.approvalId,
    tool: pending.kind === "tool" ? pending.call.function.name : pending.kind === "strikes" ? pending.tool : "finish",
    reason: pending.reason,
    ...(pending.kind !== "strikes" && pending.summary !== undefined && { summary: pending.summary }),
    ...(pending.kind !== "strikes" && pending.diffSummary && { diffSummary: pending.diffSummary }),
  });
  setStatus(ctx, "awaiting_approval");
  checkpoint(ctx);
  return { kind: "awaiting_approval", pending };
}

/** Answers the finish call (and any calls after it) so the transcript stays valid if the user starts a new turn. */
function done(ctx: RunContext, summary: string, finishCall?: ToolCall, remaining: ToolCall[] = []): RunOutcome {
  if (finishCall) toolMessage(ctx, finishCall, JSON.stringify({ finished: true }));
  for (const call of remaining) toolMessage(ctx, call, JSON.stringify({ skipped: "the run finished" }));
  setStatus(ctx, "done");
  return { kind: "finished", summary };
}

// ---------- Small helpers ----------

function emit(ctx: RunContext, body: EventBody): void {
  const { state } = ctx;
  ctx.deps.emit({
    ...body,
    seq: state.nextSeq++,
    ts: Date.now(),
    sessionId: state.sessionId,
    ...(state.step > 0 && { stepId: `s${state.step}` }),
  });
}

function setStatus(ctx: RunContext, status: AgentState["status"]): void {
  ctx.state.status = status;
  emit(ctx, { type: "status", status });
}

function checkpoint(ctx: RunContext): void {
  ctx.deps.checkpoint?.(structuredClone(ctx.state));
}

function userMessage(ctx: RunContext, content: string): void {
  ctx.state.messages.push({ role: "user", content } satisfies ChatMessage);
}

function toolMessage(ctx: RunContext, call: ToolCall, content: string): void {
  ctx.state.messages.push({ role: "tool", tool_call_id: call.id, content });
}

async function currentDiffSummary(ctx: RunContext): Promise<DiffSummary | undefined> {
  const { sandbox } = ctx.deps;
  return sandbox ? summarizeDiff(await sandbox.diff()) : undefined;
}

/** Arguments for policy and UI purposes only; the tool layer reports malformed JSON to the model. */
function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}
