// Ports the session logic needs from its host (Phase 2, P2-a). The Durable Object provides the real
// ones; tests provide node:sqlite and a fake container. No platform imports here.

import type { AgentConfig } from "../core/config";
import type { GitHub } from "../github";
import type { ModelClient, SandboxAdapter } from "../core/types";
import type { ServerFrame, SessionSummary } from "./protocol";

export type SqlValue = string | number | null;

/** The subset of Durable Object SQLite the session uses: one statement per call, rows as objects. */
export interface SqlStore {
  exec<T = Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): T[];
}

/** A file that differs from the baseline commit. Shas are git blob ids. */
export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted";
  beforeSha: string | null;
  afterSha: string | null;
  /** Size of the new content in bytes; `null` for a deleted file. */
  size: number | null;
}

/** The sandbox as the session sees it: the agent's `SandboxAdapter` plus its lifecycle. */
export interface SandboxHost extends SandboxAdapter {
  /** True when the container is running. A running container always holds a set-up workspace. */
  isRunning(): boolean;
  /** Starts the container (egress off), unpacks the repo tarball and commits the baseline. */
  setup(tarball: ReadableStream<Uint8Array>): Promise<{ readyMs: number }>;
  /** Every path that differs from the baseline, including untracked and deleted files. */
  changedFiles(): Promise<ChangedFile[]>;
  removeFile(path: string): Promise<void>;
  destroy(): Promise<void>;
}

export interface EngineDeps {
  sql: SqlStore;
  sandbox: SandboxHost;
  /** Downloads the repo at a commit. Throws an Error whose message carries the HTTP status on failure. */
  fetchTarball(repo: string, sha: string): Promise<ReadableStream<Uint8Array>>;
  model: ModelClient;
  config: AgentConfig;
  /** The configured repo (P2-h); copied into the session row at create. */
  repo: { name: string; sha: string };
  /** The configured repo's GitHub client: publishing on approve, posting a review. */
  github: Pick<GitHub, "publish" | "postReview" | "defaultBranchHead">;
  /** Checked before every GitHub write (kill switch, rate limit). `null` allows it; a string is the refusal shown to the user. */
  guard: { githubWrite(ip: string): Promise<string | null> };
  /** Sends a frame to every connected socket. */
  broadcast(frame: ServerFrame): void;
  /** The WorkspaceDO session index (ADR D16). Failures are logged, never thrown into the session. */
  index: { upsert(row: SessionSummary): Promise<void> };
  /** Schedules the watchdog alarm (P2-f); `null` clears it. */
  setAlarm(atMs: number | null): void;
  closeSockets(code: number, reason: string): void;
  /** Wipes the session's storage (ADR D18). */
  deleteAll(): Promise<void> | void;
  now?: () => number;
}

/** The session row minus the loop state (ADR D8). */
export interface SessionMeta {
  id: string;
  mode: "code" | "review" | "task";
  title: string;
  repo: string;
  sha: string;
  created_at: number;
  updated_at: number;
  /** The model chosen at create; absent for the config default (and for sessions from before Phase 3). */
  model?: string;
}

/** One row of `changes` (ADR D8, P2-e): what a rebuild writes back into a fresh workspace. */
export interface StoredChange {
  path: string;
  beforeSha: string | null;
  afterSha: string | null;
  /** `null` when the file was deleted, or when it was too large to store. */
  content: string | null;
  deleted: boolean;
  /** Over 1 MB: not stored, and reported as not restored after a rebuild. */
  skipped: boolean;
}
