// Wire contract between the browser and a session (Phase 2, P2-b). The web app imports this file.

import type { AgentEvent, DiffSummary, Status } from "../core/events";
import type { ModeName } from "../core/types";

export const MAX_TASK_CHARS = 4000;
export const TITLE_CHARS = 80;
export const RESTORED_NOTE = "The sandbox was restarted and the workspace was restored from saved changes.";

/** What a client may send over the session WebSocket. */
export type ClientFrame =
  | { type: "approve"; approvalId: string }
  | { type: "reject"; approvalId: string; comment: string }
  | { type: "message"; text: string };

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
}

export type ParsedFrame = { ok: true; frame: ClientFrame } | { ok: false; reason: string };
