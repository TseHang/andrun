// The session's Durable Object SQLite tables (ADR D8). Platform-free: only the SqlStore port.
// DO SQLite rules: one statement per exec, bindings are string | number | null, no BEGIN/COMMIT, no PRAGMA.

import type { AgentEvent, Severity } from "../core/events";
import type { AgentState, ChatMessage, PendingApproval } from "../core/types";
import type { SessionMeta, SqlStore, StoredChange } from "./ports";

/** Keeps one event row far below the 2 MB Durable Object row limit. */
const MAX_DIFF_CHARS = 256_000;
const elide = (text: string) => `${text.slice(0, MAX_DIFF_CHARS)}\n[… ${text.length - MAX_DIFF_CHARS} bytes elided]`;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY, mode TEXT NOT NULL, title TEXT NOT NULL, repo TEXT NOT NULL, sha TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, status TEXT NOT NULL, step INTEGER NOT NULL,
    tokens_used INTEGER NOT NULL, next_seq INTEGER NOT NULL, failures TEXT, nudged INTEGER NOT NULL, model TEXT)`, // `nudged` is no longer used (always 0); kept because existing databases have it
  `CREATE TABLE IF NOT EXISTS messages (idx INTEGER PRIMARY KEY, json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS pending_approval (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS changes (
    path TEXT PRIMARY KEY, before_sha TEXT, after_sha TEXT, content TEXT, deleted INTEGER NOT NULL, skipped INTEGER NOT NULL)`,
];

// Created on first write, not in SCHEMA: the `session` table is never altered (P4-p), so older sessions still open.
const FINDINGS_DDL = `CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY, n INTEGER NOT NULL, path TEXT NOT NULL, line INTEGER NOT NULL, severity TEXT NOT NULL,
  text TEXT NOT NULL, inline INTEGER NOT NULL, dismissed INTEGER NOT NULL, edited INTEGER NOT NULL)`;
const GITHUB_STATE_DDL = `CREATE TABLE IF NOT EXISTS github_state (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)`;
const TURN_DDL = `CREATE TABLE IF NOT EXISTS turn (id INTEGER PRIMARY KEY CHECK (id = 1), cost REAL NOT NULL, tokens INTEGER NOT NULL)`;

/** One review finding as stored; `n` keeps the order they were reported in. */
export interface StoredFinding {
  id: string;
  path: string;
  line: number;
  severity: Severity;
  text: string;
  inline: boolean;
  dismissed: boolean;
  edited: boolean;
}

/** Everything about GitHub that the `session` table does not hold. */
export interface GitHubState {
  pr?: { number: number; url: string; branch: string };
  round?: number;
  baseBranch?: string;
  review?: { number: number; title: string; lines: Record<string, number[]> };
  posted?: { url: string; verdict: string };
}

interface FindingRow {
  id: string;
  path: string;
  line: number;
  severity: Severity;
  text: string;
  inline: number;
  dismissed: number;
  edited: number;
}

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
  /** Absent in a table created before Phase 3. */
  model?: string | null;
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
      `INSERT OR REPLACE INTO session (id, mode, title, repo, sha, created_at, updated_at, status, step, tokens_used, next_seq, failures, nudged, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      0,
      meta.model ?? null,
    );
    this.saveMessages(state.messages);
    this.savePending(state.pending);
    this.saveTurn(state);
  }

  meta(): SessionMeta | null {
    const r = this.row();
    if (!r) return null;
    return { id: r.id, mode: r.mode, title: r.title, repo: r.repo, sha: r.sha, created_at: r.created_at, updated_at: r.updated_at, ...(r.model && { model: r.model }) };
  }

  loadState(): AgentState | null {
    const r = this.row();
    if (!r) return null;
    const messages = this.read<{ json: string }>("SELECT json FROM messages ORDER BY idx").map((m) => JSON.parse(m.json) as ChatMessage);
    const pending = this.read<{ json: string }>("SELECT json FROM pending_approval LIMIT 1")[0];
    const turn = this.read<{ cost: number; tokens: number }>("SELECT cost, tokens FROM turn LIMIT 1")[0];
    const maxSeq = this.read<{ m: number | null }>("SELECT MAX(seq) AS m FROM events")[0]?.m ?? 0;
    return {
      sessionId: r.id,
      mode: r.mode,
      status: r.status,
      messages,
      step: r.step,
      tokensUsed: r.tokens_used,
      turnCost: turn?.cost ?? 0,
      turnTokens: turn?.tokens ?? 0,
      // Events written after the last checkpoint must not have their seq reused.
      nextSeq: Math.max(r.next_seq, maxSeq + 1),
      failures: r.failures ? (JSON.parse(r.failures) as AgentState["failures"]) : null,
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
      0,
      now,
    );
    this.saveMessages(state.messages);
    this.savePending(state.pending);
    this.saveTurn(state);
  }

  /** The turn counters live in a table of their own, created at the first non-zero write (the `session` table is never altered). */
  private saveTurn(state: AgentState): void {
    const cost = state.turnCost ?? 0;
    const tokens = state.turnTokens ?? 0;
    if (cost === 0 && tokens === 0 && this.read("SELECT 1 FROM turn LIMIT 1").length === 0) return;
    this.sql.exec(TURN_DDL);
    this.sql.exec("INSERT OR REPLACE INTO turn (id, cost, tokens) VALUES (1, ?, ?)", cost, tokens);
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

  githubState(): GitHubState {
    const row = this.read<{ json: string }>("SELECT json FROM github_state LIMIT 1")[0];
    return row ? (JSON.parse(row.json) as GitHubState) : {};
  }

  /** Merges `patch` into the stored state. */
  saveGithubState(patch: GitHubState): void {
    this.sql.exec(GITHUB_STATE_DDL);
    this.sql.exec("INSERT OR REPLACE INTO github_state (id, json) VALUES (1, ?)", JSON.stringify({ ...this.githubState(), ...patch }));
  }

  addFinding(f: StoredFinding): void {
    this.sql.exec(FINDINGS_DDL);
    const n = this.read<{ n: number | null }>("SELECT MAX(n) AS n FROM findings")[0]?.n ?? 0;
    this.sql.exec(
      "INSERT OR REPLACE INTO findings (id, n, path, line, severity, text, inline, dismissed, edited) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      f.id,
      n + 1,
      f.path,
      f.line,
      f.severity,
      f.text,
      f.inline ? 1 : 0,
      f.dismissed ? 1 : 0,
      f.edited ? 1 : 0,
    );
  }

  findings(): StoredFinding[] {
    return this.read<FindingRow>("SELECT * FROM findings ORDER BY n").map(findingOf);
  }

  finding(id: string): StoredFinding | null {
    const row = this.read<FindingRow>("SELECT * FROM findings WHERE id = ?", id)[0];
    return row ? findingOf(row) : null;
  }

  updateFinding(id: string, patch: { text?: string; dismissed?: boolean }): void {
    if (patch.text !== undefined) this.sql.exec("UPDATE findings SET text = ?, edited = 1 WHERE id = ?", patch.text, id);
    if (patch.dismissed !== undefined) this.sql.exec("UPDATE findings SET dismissed = ? WHERE id = ?", patch.dismissed ? 1 : 0, id);
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

function findingOf(r: FindingRow): StoredFinding {
  return { id: r.id, path: r.path, line: r.line, severity: r.severity, text: r.text, inline: r.inline === 1, dismissed: r.dismissed === 1, edited: r.edited === 1 };
}
