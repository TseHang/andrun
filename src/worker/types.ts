// What the router needs from its environment (Phase 2, P2-b). `index.ts` builds this from the real
// bindings; tests pass fakes. No platform imports, so `handle` runs under Node.

import type { GitHub } from "../github";
import type { SessionEngine } from "../session/engine";
import type { SessionSnapshot, SessionSummary } from "../session/protocol";

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** One SessionDO, addressed by session id. Missing sessions answer `null` / `false` (ADR D18). */
export interface SessionStub {
  create(input: Parameters<SessionEngine["create"]>[0]): Promise<void>;
  snapshot(): Promise<(SessionSnapshot & { debug?: Record<string, unknown> }) | null>;
  remove(): Promise<boolean>;
  killSandbox(): Promise<boolean>;
  /** The saved content of a changed file, or null. */
  file(path: string): Promise<string | null>;
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
  /** The fixed demo repo (P2-h), shown by `GET /config`. `sha` is `DEMO_SHA`; null means the default branch's head. */
  repo: { name: string; sha: string | null };
  /** The repo's GitHub client (App token); the router only reads. */
  github: Pick<GitHub, "defaultBranchHead" | "listPulls" | "getPull" | "getPullFile" | "getPullReviews">;
  /** `GITHUB_WRITES="1"` and no kill switch: the web app shows publish and review actions. */
  githubWrites: boolean;
  githubReadLimiter: RateLimiter;
  newId(): string;
}
