import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/core/config";
import { ModelError, type ModelClient } from "../../src/core/types";
import { CloudflareSandboxAdapter } from "../../src/sandbox/cloudflare-sandbox";
import { SessionEngine } from "../../src/session/engine";
import type { SessionSummary } from "../../src/session/protocol";
import { WorkspaceIndex } from "../../src/session/workspace";
import { FakeContainer } from "../support/fake-container";
import { nodeSql } from "../support/node-sql";
import { ScriptedModelClient, call } from "../support/scripted-model";
import { fixtureTarball, streamOf } from "../support/tarball";

const TARBALL = fixtureTarball(join(import.meta.dirname, "../../eval/fixtures/sum-off-by-one"));
const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";
const LONG_TASK = `make the failing test pass ${"and keep the public API unchanged ".repeat(5)}`.trim();

const containers: FakeContainer[] = [];
afterEach(async () => {
  await Promise.all(containers.splice(0).map((c) => c.cleanup()));
});

function session(model: ModelClient, upsert: (row: SessionSummary) => Promise<void>, now: number) {
  const container = new FakeContainer();
  containers.push(container);
  const db = nodeSql();
  return new SessionEngine({
    sql: db.sql,
    sandbox: new CloudflareSandboxAdapter({ container, files: container.files, workdir: container.workdir, tmpDir: container.tmpDir }),
    fetchTarball: async () => streamOf(TARBALL),
    model,
    config: defaultConfig,
    repo: { name: "TseHang/andrun-demo", sha: "0df6f53ec8a51785899d574c43db212513347537" },
    // Phase 4 ports; these tests only need an approve to succeed.
    github: {
      publish: async (input) => ({ number: 1, url: "https://github.com/TseHang/andrun-demo/pull/1", branch: `${input.branchPrefix}-1`, round: 1, updated: false }),
      postReview: async () => ({ url: "" }),
      defaultBranchHead: async () => ({ branch: "main", sha: "0df6f53ec8a51785899d574c43db212513347537" }),
    },
    guard: { githubWrite: async () => null },
    broadcast: () => {},
    index: { upsert },
    setAlarm: () => {},
    closeSockets: () => {},
    deleteAll: () => db.deleteAll(),
    now: () => now,
  });
}

const toGate = () => new ScriptedModelClient([call("finish", { summary: "Nothing to do." })]);
const toFailure = () => new ScriptedModelClient([new ModelError("ai& returned HTTP 500", 500)]);

describe("S12: the session index follows status changes (D16)", () => {
  it("index lists sessions and follows status; a failed upsert heals on the next transition", async () => {
    const index = new WorkspaceIndex(nodeSql().sql);
    expect(index.list()).toEqual([]);

    const seen: SessionSummary[] = [];
    const record = async (row: SessionSummary) => {
      seen.push(row);
      index.upsert(row);
    };

    const first = session(toGate(), record, 1000);
    first.create({ id: FIRST, mode: "code", task: LONG_TASK });
    await first.idle();
    const second = session(toFailure(), record, 2000);
    second.create({ id: SECOND, mode: "code", task: "second task" });
    await second.idle();

    expect(index.list()).toEqual([
      { id: SECOND, mode: "code", title: "second task", status: "failed", created_at: 2000, updated_at: 2000 },
      { id: FIRST, mode: "code", title: LONG_TASK.slice(0, 80), status: "awaiting_approval", created_at: 1000, updated_at: 1000 },
    ]);
    expect(LONG_TASK.length).toBeGreaterThan(80);
    // One upsert per status transition, each carrying the whole row.
    expect(seen.filter((r) => r.id === FIRST).map((r) => r.status)).toEqual(["running", "awaiting_approval"]);
    expect(seen.filter((r) => r.id === SECOND).map((r) => r.status)).toEqual(["running", "failed"]);

    index.remove(FIRST);
    index.remove("not-there");
    expect(index.list().map((r) => r.id)).toEqual([SECOND]);
  });

  it("a failed upsert does not affect the session and heals on the next transition", async () => {
    const index = new WorkspaceIndex(nodeSql().sql);
    let calls = 0;
    const flaky = async (row: SessionSummary) => {
      if (++calls === 1) throw new Error("WorkspaceDO unavailable");
      index.upsert(row);
    };

    const engine = session(toGate(), flaky, 1000);
    engine.create({ id: FIRST, mode: "code", task: "first task" });
    await engine.idle();

    expect(engine.snapshot()).toMatchObject({ status: "awaiting_approval" });
    expect(calls).toBe(2);
    expect(index.list()).toMatchObject([{ id: FIRST, status: "awaiting_approval", title: "first task" }]);
  });
});

describe("the index knows a session's pull request (Phase 4, P4-k)", () => {
  const base = { mode: "code" as const, title: "t", status: "done" as const, created_at: 1, updated_at: 1 };

  it("stores and returns pr, and leaves it out when there is none", () => {
    const index = new WorkspaceIndex(nodeSql().sql);
    index.upsert({ id: FIRST, ...base });
    index.upsert({ id: SECOND, ...base, mode: "review", created_at: 2, pr: 14 });
    expect(index.list()).toEqual([
      { id: SECOND, ...base, mode: "review", created_at: 2, pr: 14 },
      { id: FIRST, ...base },
    ]);
    index.upsert({ id: FIRST, ...base, pr: 12 }); // a Code session gets its pull request when it is approved
    expect(index.list()[1]).toMatchObject({ id: FIRST, pr: 12 });
  });

  it("a table created before Phase 4 gets the column", () => {
    const db = nodeSql();
    db.sql.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, mode TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    db.sql.exec("INSERT INTO sessions VALUES (?, 'code', 'old', 'done', 1, 1)", FIRST);
    const index = new WorkspaceIndex(db.sql);
    expect(index.list()).toEqual([{ id: FIRST, mode: "code", title: "old", status: "done", created_at: 1, updated_at: 1 }]);
    index.upsert({ id: SECOND, ...base, created_at: 2, pr: 12 });
    expect(index.list()[0]).toMatchObject({ id: SECOND, pr: 12 });
  });
});
