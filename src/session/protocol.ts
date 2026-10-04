// Wire contract between the browser and a session (Phase 2, P2-b). The web app imports this file.

import type { AgentEvent, DiffSummary, ReviewVerdict, Status } from "../core/events";
import type { ModeName } from "../core/types";

export const MAX_TASK_CHARS = 4000;

/** The brief a Review session starts with unless the user writes their own. */
export const DEFAULT_REVIEW_BRIEF = `Review this pull request.

1. Correctness: wrong results, edge cases, error handling.
2. Tests: cases that are missing, tests that do not check behavior.
3. Risk: breaking changes, security, data loss.

Skip style and formatting.
Give each finding a file, a line and a severity.`;
export const TITLE_CHARS = 80;
export const MAX_FINDING_CHARS = 4000;
export const MAX_REVIEW_COMMENT_CHARS = 4000;
/** Why a Comment or Request changes review with no comment and no finding is refused. */
export const EMPTY_REVIEW = "Write a comment or keep a finding to post this review.";
export const RESTORED_NOTE = "The sandbox was restarted and the workspace was restored from saved changes.";

/** What a client may send over the session WebSocket. */
export type ClientFrame =
  | { type: "approve"; approvalId: string }
  | { type: "reject"; approvalId: string; comment: string }
  | { type: "message"; text: string }
  | { type: "stop" }
  | { type: "finding"; id: string; text?: string; dismissed?: boolean }
  /** `comment` is the reviewer's own text: the top of the review body on GitHub. */
  | { type: "post_review"; approvalId: string; verdict: ReviewVerdict; comment?: string };

/** What the server sends: a §5 event, or a refusal of a client frame (never persisted, no `seq`). */
export type ServerFrame = AgentEvent | { type: "rejected"; reason: string };

/** One row of the session index (ADR D16), and the `GET /sessions` item shape. */
export interface SessionSummary {
  id: string;
  mode: ModeName;
  title: string;
  status: Status;
  created_at: number;
  updated_at: number;
  /** The pull request this session opened (code) or reviews (review). */
  pr?: number;
}

export interface PendingView {
  approvalId: string;
  tool: string;
  reason: string;
  summary?: string;
  diffSummary?: DiffSummary;
}

/** `GET /sessions/:id` body (the Durable Object adds a `debug` field). */
export interface SessionSnapshot {
  id: string;
  mode: ModeName;
  title: string;
  status: Status;
  pending: PendingView | null;
  sandboxRunning: boolean;
  /** The branch a Code session's pull request goes into; null until it is known (a pinned commit, or a review). */
  baseBranch: string | null;
  sha: string;
  pr: { number: number; url: string | null; branch: string | null } | null;
}

export type ParsedFrame = { ok: true; frame: ClientFrame } | { ok: false; reason: string };
