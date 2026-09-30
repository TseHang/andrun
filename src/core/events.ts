// The event contract between backend and UI (spec §5, ADR D7).
// Every event the UI renders is one of these. The web app imports this file.

export type Status =
  | "idle"
  | "running"
  | "awaiting_approval"
  | "done"
  | "failed"
  | "budget_exceeded";

export type ErrorSource = "model" | "tool" | "sandbox" | "github" | "budget";

export type Severity = "high" | "medium" | "low";

export type ReviewVerdict = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export interface DiffSummary {
  files: { path: string; additions: number; deletions: number }[];
}

export type EventBody =
  | { type: "message"; id: string; role: "user" | "assistant"; text: string }
  /** Streamed token text. Broadcast only, never persisted (D7). */
  | { type: "message_delta"; id: string; text: string }
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
    }
  | { type: "file_changed"; path: string; diff: string }
  | {
      type: "approval_required";
      approvalId: string;
      tool: string;
      reason: string;
      summary?: string;
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
  | { type: "pr_opened"; url: string }
  | { type: "review_finding"; id: string; path: string; line: number; severity: Severity; text: string }
  | { type: "review_posted"; url: string; verdict: ReviewVerdict }
  | { type: "artifact"; name: string; size: number; url: string }
  | {
      type: "usage";
      model: string;
      tokens_in: number;
      tokens_out: number;
      latency_ms: number;
      cost?: number;
      context_tokens: number;
      context_window: number;
    }
  | { type: "error"; source: ErrorSource; message: string; next?: string }
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
