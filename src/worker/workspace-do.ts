// The session index (ADR D16): one fixed-name Durable Object whose SQLite lists every session.
// It is a cache for the sidebar; each SessionDO stays the source of truth for its own session.

import { DurableObject } from "cloudflare:workers";
import type { SqlStore, SqlValue } from "../session/ports";
import type { SessionSummary } from "../session/protocol";
import { WorkspaceIndex } from "../session/workspace";
import type { Env } from "./env";

export class WorkspaceDO extends DurableObject<Env> {
  private readonly index: WorkspaceIndex;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql: SqlStore = {
      exec: <T>(query: string, ...bindings: SqlValue[]) => ctx.storage.sql.exec(query, ...bindings).toArray() as T[],
    };
    this.index = new WorkspaceIndex(sql);
  }

  async upsert(row: SessionSummary): Promise<void> {
    this.index.upsert(row);
  }

  async list(): Promise<SessionSummary[]> {
    return this.index.list();
  }

  async remove(id: string): Promise<void> {
    this.index.remove(id);
  }
}
