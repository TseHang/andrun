// The session list (ADR D16): one table in the WorkspaceDO's SQLite. Platform-free: only the SqlStore port.

import type { SqlStore } from "./ports";
import type { SessionSummary } from "./protocol";

const SCHEMA = `CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, mode TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`;

export class WorkspaceIndex {
  private ready = false;

  constructor(private readonly sql: SqlStore) {}

  /** This object is a singleton index, so its table is created on first use. */
  private table(): void {
    if (this.ready) return;
    this.sql.exec(SCHEMA);
    this.ready = true;
  }

  upsert(row: SessionSummary): void {
    this.table();
    this.sql.exec(
      "INSERT OR REPLACE INTO sessions (id, mode, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      row.id,
      row.mode,
      row.title,
      row.status,
      row.created_at,
      row.updated_at,
    );
  }

  remove(id: string): void {
    this.table();
    this.sql.exec("DELETE FROM sessions WHERE id = ?", id);
  }

  /** Newest first. */
  list(): SessionSummary[] {
    this.table();
    return this.sql
      .exec<SessionSummary>("SELECT id, mode, title, status, created_at, updated_at FROM sessions ORDER BY created_at DESC, id")
      .map((r) => ({ id: r.id, mode: r.mode, title: r.title, status: r.status, created_at: r.created_at, updated_at: r.updated_at }));
  }
}
