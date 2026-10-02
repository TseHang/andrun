import { DatabaseSync } from "node:sqlite";
import type { SqlStore, SqlValue } from "../../src/session/ports";

/** An in-memory SQLite that stands in for a Durable Object's `ctx.storage.sql`. */
export function nodeSql() {
  const db = new DatabaseSync(":memory:");
  const sql: SqlStore = {
    exec<T = Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): T[] {
      return db.prepare(query).all(...bindings).map((row) => ({ ...row })) as T[];
    },
  };
  const tables = (): string[] =>
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => String(r["name"]));
  return {
    sql,
    tables,
    /** Like `ctx.storage.deleteAll()`: every table is gone afterwards. */
    deleteAll(): void {
      for (const name of tables()) db.exec(`DROP TABLE "${name}"`);
    },
  };
}
