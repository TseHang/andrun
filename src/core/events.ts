// The event contract between backend and UI (spec §5, ADR D7).
// Every event the UI renders is one of these. The web app imports this file.

export type Status =
  | "idle"
  | "running"
  | "awaiting_approval"
  | "awaiting_input"
  | "done"
  | "failed"
  | "budget_exceeded";

export type ErrorSource = "model" | "tool" | "sandbox" | "github" | "budget";

export type Severity = "high" | "medium" | "low";

export type ReviewVerdict = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export interface DiffSummary {
  files: { path: string; additions: number; deletions: number }[];
}

export interface PlanStep {
  step: string;
  status: "pending" | "in_progress" | "completed";
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export type EventBody =
  | { type: "message"; id: string; role: "user" | "assistant"; text: string }
  /** Streamed token text. Broadcast only, never persisted (D7). */
  | { type: "message_delta"; id: string; text: string }
  /** The model's thinking for one step. `reasoning_delta` is broadcast only, like `message_delta`. */
  | { type: "reasoning"; id: string; text: string }
  | { type: "reasoning_delta"; id: string; text: string }
  /** Auto mode chose this model and effort for the turn that starts here. */
  | { type: "model_routed"; task: "daily" | "complex"; model: string; reasoning: string }
  | { type: "tool_call"; callId: string; name: string; args: unknown; summary: string }
  /**
   * Output of a tool call. Commands stream several chunks; the final one carries `exitCode`
   * (`null` when the command timed out or was aborted).
   */
  | {
      type: "tool_output";
      callId: string;
      stream: "stdout" | "stderr" | "result";
      chunk: string;
      exitCode?: number | null;
      /** On the final `result` of `read_file` (`bytes`, UTF-8 size of the whole file) and `list_files` (`files`, paths returned), before any cut. */
      meta?: { bytes?: number; files?: number };
    }
  | { type: "file_changed"; path: string; diff: string; saved?: boolean; unavailableReason?: string }
  | {
      type: "approval_required";
      approvalId: string;
      tool: string;
      reason: string;
      summary?: string;
      /** The pull request title the agent proposed with finish (Code). */
      title?: string;
      diffSummary?: DiffSummary;
    }
  | {
      type: "approval_resolved";
      approvalId: string;
      approved: boolean;
      comment?: string;
      /** True when a policy approved it without a human (eval, auto-approve bonus). */
      auto?: boolean;
    }
  /** The agent asks the user to choose; the answer comes back as a user message. */
  | { type: "question"; id: string; question: string; options: QuestionOption[] }
  | { type: "pr_opened"; url: string; number?: number; branch?: string; updated?: boolean }
  | {
      type: "review_finding";
      id: string;
      path: string;
      line: number;
      severity: Severity;
      text: string;
      /** Set by the session: the line is on the pull request's diff, so it can be an inline comment. */
      inline?: boolean;
      dismissed?: boolean;
      edited?: boolean;
    }
  /** The agent's whole current plan; each event replaces the previous one. */
  | { type: "plan_updated"; plan: PlanStep[] }
  | { type: "review_posted"; url: string; verdict: ReviewVerdict }
  | { type: "artifact"; name: string; size: number; url: string }
  | {
      type: "usage";
      model: string;
      /** The `reasoning_effort` sent; absent when the provider's default was used. */
      reasoning?: string;
      tokens_in: number;
      tokens_out: number;
      latency_ms: number;
      cost?: number;
      context_tokens: number;
      context_window: number;
    }
  | { type: "error"; source: ErrorSource; message: string; next?: string }
  /** The user stopped the run; the changes so far are kept. */
  | { type: "stopped" }
  | { type: "status"; status: Status };

export type EventType = EventBody["type"];

export interface Envelope {
  seq: number;
  ts: number;
  sessionId: string;
  stepId?: string;
}

export type AgentEvent = EventBody & Envelope;

export type EventOf<T extends EventType> = Extract<AgentEvent, { type: T }>;
