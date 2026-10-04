// Ports and state for the agent loop (ADR D1–D4). No platform imports in src/core.

import type { AgentConfig } from "./config";
import type { AgentEvent, DiffSummary, Severity, Status } from "./events";

// ---------- Model (OpenAI-compatible chat format) ----------

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema object
}

export interface ModelRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  signal?: AbortSignal;
}

export interface ModelResponse {
  content: string | null;
  toolCalls: ToolCall[];
  usage: { tokens_in: number; tokens_out: number };
  latency_ms: number;
  model: string;
}

export interface ModelClient {
  /** `onDelta` receives streamed assistant text. Throws `ModelError` after retries are exhausted. */
  complete(req: ModelRequest, onDelta?: (text: string) => void): Promise<ModelResponse>;
}

export class ModelError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

// ---------- Sandbox ----------

/** The sandbox is gone (container stopped or destroyed). Ends the run as `failed` instead of going back to the model. */
export class SandboxLostError extends Error {
  constructor(message = "the sandbox was lost") {
    super(message);
    this.name = "SandboxLostError";
  }
}

export interface ExecOptions {
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ExecResult {
  /** `null` when the command timed out or was aborted. */
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/**
 * The workspace the agent works in. All paths are relative to the workspace root and are
 * validated by the tool layer before they reach an adapter.
 */
export interface SandboxAdapter {
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  /** Throws an Error whose message starts with the errno code (e.g. "ENOENT: …") on failure. */
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  /** Recursive file list, excluding `.git` and ignored files. */
  listFiles(dir?: string): Promise<string[]>;
  /** Applies leniently: `git apply --recount`, since models get hunk line counts wrong. */
  applyPatch(patch: string): Promise<{ ok: boolean; stderr: string }>;
  /** Unified diff of the workspace against its baseline commit (recorded at setup, not HEAD: the agent may commit), optionally for one path. Includes new files. */
  diff(path?: string): Promise<string>;
}

// ---------- Policy ----------

export type ModeName = "code" | "review" | "task";

export interface PolicyInput {
  mode: ModeName;
  tool: string;
  args: Record<string, unknown>;
}

export type Decision =
  | { kind: "allow"; auto?: { reason: string } }
  | { kind: "ask"; reason: string }
  | { kind: "deny"; reason: string };

export interface ApprovalPolicy {
  decide(input: PolicyInput): Decision;
}

// ---------- Modes ----------

export type ToolName =
  | "list_files"
  | "read_file"
  | "write_file"
  | "apply_patch"
  | "run_command"
  | "update_plan"
  | "report_finding"
  | "finish";

export interface ModeProfile {
  name: ModeName;
  model: string;
  systemPrompt: string;
  tools: ToolName[];
  /** Text added to a tool's description in this mode (e.g. what `run_command` may run in a review). */
  toolNotes?: Partial<Record<ToolName, string>>;
  policy: ApprovalPolicy;
  sandboxSetup: "tarball@sha" | "pr-head@sha" | "empty" | "none";
  onFinish: "open_pr" | "draft_review" | "answer";
}

// ---------- Loop state ----------

export type PendingApproval =
  | {
      kind: "tool";
      approvalId: string;
      reason: string;
      call: ToolCall;
      /** Tool calls from the same model turn that come after `call`, run after it resolves. */
      remaining: ToolCall[];
      summary?: string;
      diffSummary?: DiffSummary;
    }
  /** Same tool failed 3 times in a row (spec §6). */
  | { kind: "strikes"; approvalId: string; reason: string; tool: string }
  /** Model replied with text twice without calling a tool; treated as finishing. */
  | { kind: "implicit_finish"; approvalId: string; reason: string; summary: string; diffSummary?: DiffSummary };

export interface AgentState {
  sessionId: string;
  mode: ModeName;
  status: Status;
  messages: ChatMessage[];
  /** Model turns taken so far. */
  step: number;
  tokensUsed: number;
  /** Yen spent in the current turn; reset when a user message starts a new turn. */
  turnCost: number;
  /** Input plus output tokens of the current turn. */
  turnTokens: number;
  nextSeq: number;
  failures: { tool: string; count: number } | null;
  nudged: boolean;
  pending: PendingApproval | null;
}

export type RunOutcome =
  | { kind: "finished"; summary: string }
  | { kind: "awaiting_approval"; pending: PendingApproval }
  | { kind: "failed"; error: string }
  | { kind: "budget_exceeded" };

export interface AgentDeps {
  model: ModelClient;
  sandbox: SandboxAdapter | null;
  /** Overrides `profile.policy` (e.g. the eval's auto-approve wrapper). */
  policy?: ApprovalPolicy;
  emit: (event: AgentEvent) => void;
  /** Called once per step with a deep copy of the state. */
  checkpoint?: (state: AgentState) => void;
  /** Redirect messages the user typed while the agent was running (injected before the next model call). */
  drainUserMessages?: () => string[];
  signal?: AbortSignal;
  config: AgentConfig;
}

export interface Finding {
  id: string;
  path: string;
  line: number;
  severity: Severity;
  text: string;
}

export type ApprovalDecision = { approved: true; comment?: string } | { approved: false; comment: string };
