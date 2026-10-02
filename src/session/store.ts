// The session's Durable Object SQLite tables (ADR D8). Platform-free: only the SqlStore port.
// DO SQLite rules: one statement per exec, bindings are string | number | null, no BEGIN/COMMIT, no PRAGMA.

import type { AgentEvent } from "../core/events";
import type { AgentState, ChatMessage, PendingApproval } from "../core/types";
import type { SessionMeta, SqlStore, StoredChange } from "./ports";

/** Keeps one event row far below the 2 MB Durable Object row limit. */
const MAX_DIFF_CHARS = 256_000;
const elide = (text: string) => `${text.slice(0, MAX_DIFF_CHARS)}\n[… ${text.length - MAX_DIFF_CHARS} bytes elided]`;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY, mode TEXT NOT NULL, title TEXT NOT NULL, repo TEXT NOT NULL, sha TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, status TEXT NOT NULL, step INTEGER NOT NULL,
    tokens_used INTEGER NOT NULL, next_seq INTEGER NOT NULL, failures TEXT, nudged INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS messages (idx INTEGER PRIMARY KEY, json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS pending_approval (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS changes (
    path TEXT PRIMARY KEY, before_sha TEXT, after_sha TEXT, content TEXT, deleted INTEGER NOT NULL, skipped INTEGER NOT NULL)`,
];

interface SessionRow {
  id: string;
  mode: SessionMeta["mode"];
  title: string;
  repo: string;
  sha: string;
  created_at: number;
  updated_at: number;
  status: AgentState["status"];
  step: number;
  tokens_used: number;
  next_seq: number;
  failures: string | null;
  nudged: number;
}

interface ChangeRow {
  path: string;
  before_sha: string | null;
  after_sha: string | null;
  content: string | null;
  deleted: number;
  skipped: number;
}

export class SessionStore {
  constructor(private readonly sql: SqlStore) {}

  /** A read that yields nothing, instead of throwing, while the tables do not exist yet. */
  private read<T>(query: string, ...bindings: (string | number | null)[]): T[] {
    try {
      return this.sql.exec<T>(query, ...bindings);
    } catch (e) {
      if (e instanceof Error && /no such table/i.test(e.message)) return [];
      throw e;
    }
  }

  private row(): SessionRow | null {
    return this.read<SessionRow>("SELECT * FROM session LIMIT 1")[0] ?? null;
  }

  exists(): boolean {
    return this.row() !== null;
  }

  create(meta: SessionMeta, state: AgentState): void {
    for (const ddl of SCHEMA) this.sql.exec(ddl);
    this.sql.exec(
      `INSERT OR REPLACE INTO session (id, mode, title, repo, sha, created_at, updated_at, status, step, tokens_used, next_seq, failures, nudged)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      meta.id,
      meta.mode,
      meta.title,
      meta.repo,
      meta.sha,
      meta.created_at,
      meta.updated_at,
      state.status,
      state.step,
      state.tokensUsed,
      state.nextSeq,
      state.failures ? JSON.stringify(state.failures) : null,
      state.nudged ? 1 : 0,
    );
    this.saveMessages(state.messages);
    this.savePending(state.pending);
  }

  meta(): SessionMeta | null {
    const r = this.row();
    if (!r) return null;
    return { id: r.id, mode: r.mode, title: r.title, repo: r.repo, sha: r.sha, created_at: r.created_at, updated_at: r.updated_at };
  }

  loadState(): AgentState | null {
    const r = this.row();
    if (!r) return null;
    const messages = this.read<{ json: string }>("SELECT json FROM messages ORDER BY idx").map((m) => JSON.parse(m.json) as ChatMessage);
    const pending = this.read<{ json: string }>("SELECT json FROM pending_approval LIMIT 1")[0];
    const maxSeq = this.read<{ m: number | null }>("SELECT MAX(seq) AS m FROM events")[0]?.m ?? 0;
    return {
      sessionId: r.id,
      mode: r.mode,
      status: r.status,
      messages,
      step: r.step,
      tokensUsed: r.tokens_used,
      // Events written after the last checkpoint must not have their seq reused.
      nextSeq: Math.max(r.next_seq, maxSeq + 1),
      failures: r.failures ? (JSON.parse(r.failures) as AgentState["failures"]) : null,
      nudged: r.nudged === 1,
      pending: pending ? (JSON.parse(pending.json) as PendingApproval) : null,
    };
  }

  saveState(state: AgentState, now: number): void {
    this.sql.exec(
      "UPDATE session SET status = ?, step = ?, tokens_used = ?, next_seq = ?, failures = ?, nudged = ?, updated_at = ?",
      state.status,
      state.step,
      state.tokensUsed,
      state.nextSeq,
      state.failures ? JSON.stringify(state.failures) : null,
      state.nudged ? 1 : 0,
      now,
    );
    this.saveMessages(state.messages);
    this.savePending(state.pending);
  }

  /** The transcript only grows, so rows already stored are kept and only the new tail is written. */
  private saveMessages(messages: ChatMessage[]): void {
    const stored = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages")[0]?.n ?? 0;
    if (stored > messages.length) this.sql.exec("DELETE FROM messages WHERE idx >= ?", messages.length);
    for (let i = Math.min(stored, messages.length); i < messages.length; i++) {
      this.sql.exec("INSERT OR REPLACE INTO messages (idx, json) VALUES (?, ?)", i, JSON.stringify(messages[i]));
    }
  }

  private savePending(pending: PendingApproval | null): void {
    if (pending) this.sql.exec("INSERT OR REPLACE INTO pending_approval (id, json) VALUES (1, ?)", JSON.stringify(pending));
    else this.sql.exec("DELETE FROM pending_approval");
  }

  appendEvent(event: AgentEvent): void {
    if (event.type === "message_delta") return;
    let stored = event;
    if (event.type === "file_changed" && event.diff.length > MAX_DIFF_CHARS) stored = { ...event, diff: elide(event.diff) };
    if (event.type === "tool_output" && event.chunk.length > MAX_DIFF_CHARS) stored = { ...event, chunk: elide(event.chunk) };
    this.sql.exec("INSERT OR REPLACE INTO events (seq, json) VALUES (?, ?)", event.seq, JSON.stringify(stored));
  }

  eventsAfter(seq: number): AgentEvent[] {
    return this.read<{ json: string }>("SELECT json FROM events WHERE seq > ? ORDER BY seq", seq).map((r) => JSON.parse(r.json) as AgentEvent);
  }

  putChange(c: StoredChange): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO changes (path, before_sha, after_sha, content, deleted, skipped) VALUES (?, ?, ?, ?, ?, ?)",
      c.path,
      c.beforeSha,
      c.afterSha,
      c.content,
      c.deleted ? 1 : 0,
      c.skipped ? 1 : 0,
    );
  }

  removeChange(path: string): void {
    this.sql.exec("DELETE FROM changes WHERE path = ?", path);
  }

  changes(): StoredChange[] {
    return this.read<ChangeRow>("SELECT * FROM changes ORDER BY path").map((r) => ({
      path: r.path,
      beforeSha: r.before_sha,
      afterSha: r.after_sha,
      content: r.content,
      deleted: r.deleted === 1,
      skipped: r.skipped === 1,
    }));
  }
}
