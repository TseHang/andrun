// What the router needs from its environment (Phase 2, P2-b). `index.ts` builds this from the real
// bindings; tests pass fakes. No platform imports, so `handle` runs under Node.

import type { SessionSnapshot, SessionSummary } from "../session/protocol";

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** One SessionDO, addressed by session id. Missing sessions answer `null` / `false` (ADR D18). */
export interface SessionStub {
  create(input: { id: string; mode: "code"; task: string }): Promise<void>;
  snapshot(): Promise<(SessionSnapshot & { debug?: Record<string, unknown> }) | null>;
  remove(): Promise<boolean>;
  killSandbox(): Promise<boolean>;
  /** Forwards the WebSocket upgrade request. */
  fetch(request: Request): Promise<Response>;
}

export interface WorkspaceStub {
  list(): Promise<SessionSummary[]>;
  remove(id: string): Promise<void>;
}

export interface RouterEnv {
  session(id: string): SessionStub;
  workspace: WorkspaceStub;
  createLimiter: RateLimiter;
  deleteLimiter: RateLimiter;
  /** `KILL_SWITCH="1"`: no new sessions (ADR D14, spike finding 2). */
  killSwitch: boolean;
  /** `DEBUG_ENDPOINTS="1"`: routes `POST /sessions/:id/debug/kill-sandbox`. */
  debugEndpoints: boolean;
  newId(): string;
}
