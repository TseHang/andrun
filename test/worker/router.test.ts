import { describe, expect, it } from "vitest";
import { MAX_TASK_CHARS, type SessionSnapshot, type SessionSummary } from "../../src/session/protocol";
import { handle } from "../../src/worker/router";
import type { RateLimiter, RouterEnv } from "../../src/worker/types";

const ORIGIN = "https://andrun.example.workers.dev";
const IP_A = "203.0.113.7";
const IP_B = "198.51.100.9";
const UNKNOWN = "99999999-9999-4999-8999-999999999999";
const REPO = { name: "TseHang/andrun-demo", sha: "0df6f53ec8a51785899d574c43db212513347537" };

/** Allows `max` calls per key, like a Workers Rate Limiting binding inside one period. */
function limiter(max: number) {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  const binding: RateLimiter = {
    limit: async ({ key }) => {
      keys.push(key);
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= max };
    },
  };
  return { binding, keys };
}

function fakeEnv(over: Partial<RouterEnv> = {}) {
  const sessions = new Map<string, SessionSnapshot>();
  const created: { id: string; mode: string; task: string; model?: string }[] = [];
  const touched: string[] = [];
  const indexRemoved: string[] = [];
  const killed: string[] = [];
  const index: SessionSummary[] = [];
  const create = limiter(5);
  const del = limiter(10);
  let n = 0;

  const env: RouterEnv = {
    session(id) {
      touched.push(id);
      return {
        create: async (input) => {
          created.push(input);
          sessions.set(id, { id, mode: "code", title: input.task.slice(0, 80), status: "running", pending: null });
        },
        snapshot: async () => sessions.get(id) ?? null,
        remove: async () => sessions.delete(id),
        killSandbox: async () => {
          if (!sessions.has(id)) return false;
          killed.push(id);
          return true;
        },
        fetch: async () => new Response("upgraded", { headers: { "x-forwarded-to": id } }),
      };
    },
    workspace: {
      list: async () => index,
      remove: async (id) => {
        indexRemoved.push(id);
      },
    },
    createLimiter: create.binding,
    deleteLimiter: del.binding,
    killSwitch: false,
    debugEndpoints: true,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    repo: REPO,
    ...over,
  };
  return { env, sessions, created, touched, indexRemoved, killed, index, createKeys: create.keys, deleteKeys: del.keys };
}

const req = (method: string, path: string, opts: { body?: unknown; ip?: string; headers?: Record<string, string> } = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      "cf-connecting-ip": opts.ip ?? IP_A,
      ...(opts.body !== undefined && { "content-type": "application/json" }),
      ...opts.headers,
    },
    ...(opts.body !== undefined && { body: typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body) }),
  });

const post = (env: RouterEnv, body: unknown, ip?: string) => handle(req("POST", "/sessions", { body, ip }), env);
const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

async function expectError(res: Response, status: number, mentions?: RegExp): Promise<void> {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toMatch(/application\/json/);
  const body = await json(res);
  expect(typeof body["error"]).toBe("string");
  if (mentions) expect(body["error"]).toMatch(mentions);
}

describe("router (P2-b)", () => {
  it("creates a session and reads it back", async () => {
    const f = fakeEnv();
    const res = await post(f.env, { mode: "code", task: "make the failing test pass" });
    expect(res.status).toBe(201);
    const { id } = await json(res);
    expect(id).toBe("00000000-0000-4000-8000-000000000001");
    expect(f.created).toEqual([{ id, mode: "code", task: "make the failing test pass" }]);

    const got = await handle(req("GET", `/sessions/${id as string}`), f.env);
    expect(got.status).toBe(200);
    expect(await json(got)).toMatchObject({ id, status: "running", pending: null });
  });

  it("lists sessions from the index", async () => {
    const f = fakeEnv();
    f.index.push({ id: UNKNOWN, mode: "code", title: "t", status: "done", created_at: 2, updated_at: 3 });
    const res = await handle(req("GET", "/sessions"), f.env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(f.index);
    expect(f.touched).toEqual([]); // the list never wakes a SessionDO (ADR D16)
  });

  it("validates the create body", async () => {
    const f = fakeEnv({ createLimiter: limiter(100).binding });
    await expectError(await post(f.env, "{not json"), 400, /json/i);
    await expectError(await post(f.env, ["code"]), 400);
    await expectError(await post(f.env, { mode: "review", task: "x" }), 400, /mode/);
    await expectError(await post(f.env, { task: "x" }), 400, /mode/);
    await expectError(await post(f.env, { mode: "code" }), 400, /task/);
    await expectError(await post(f.env, { mode: "code", task: "   " }), 400, /task/);
    await expectError(await post(f.env, { mode: "code", task: 7 }), 400, /task/);
    await expectError(await post(f.env, { mode: "code", task: "x".repeat(MAX_TASK_CHARS + 1) }), 400, /task/);
    expect(f.created).toEqual([]);
    expect(f.touched).toEqual([]);

    expect((await post(f.env, { mode: "code", task: "x".repeat(MAX_TASK_CHARS) })).status).toBe(201);
    // A visitor cannot point the sandbox at another repo (P2-h): the field is ignored.
    expect((await post(f.env, { mode: "code", task: "  fix it  ", repo: "evil/repo", sha: "abc" })).status).toBe(201);
    expect(f.created.at(-1)).toEqual({ id: f.created.at(-1)!.id, mode: "code", task: "fix it" });
  });

  it("rate limits create and delete per IP", async () => {
    const f = fakeEnv();
    const body = { mode: "code", task: "make the failing test pass" };
    for (let i = 0; i < 5; i++) expect((await post(f.env, body)).status).toBe(201);

    const sixth = await post(f.env, body);
    await expectError(sixth, 429);
    expect(sixth.headers.get("retry-after")).toBe("60");
    expect(f.created).toHaveLength(5);
    expect(f.touched).toHaveLength(5); // the refused request never reached a SessionDO

    expect((await post(f.env, body, IP_B)).status).toBe(201); // another IP is unaffected
    expect(new Set(f.createKeys)).toEqual(new Set([IP_A, IP_B]));

    // Delete has its own limiter: it still works for the IP that ran out of creates.
    const id = f.created[0]!.id;
    expect((await handle(req("DELETE", `/sessions/${id}`), f.env)).status).toBe(204);
    expect(f.deleteKeys).toEqual([IP_A]);

    const strict = fakeEnv({ deleteLimiter: limiter(0).binding });
    await post(strict.env, body);
    const refused = await handle(req("DELETE", `/sessions/${strict.created[0]!.id}`), strict.env);
    await expectError(refused, 429);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect(strict.sessions.size).toBe(1);
  });

  it("kill switch blocks new sessions only", async () => {
    const f = fakeEnv();
    const { id } = await json(await post(f.env, { mode: "code", task: "before the switch" }));

    const off = { ...f.env, killSwitch: true };
    const res = await post(off, { mode: "code", task: "after the switch" });
    expect(res.status).toBe(503);
    expect(await json(res)).toEqual({ error: "new sessions are disabled" });
    expect(f.created).toHaveLength(1);

    expect((await handle(req("GET", "/sessions"), off)).status).toBe(200);
    expect((await handle(req("GET", `/sessions/${id as string}`), off)).status).toBe(200);
    expect((await handle(req("DELETE", `/sessions/${id as string}`), off)).status).toBe(204);
  });

  it("deleted or unknown sessions are 404", async () => {
    const f = fakeEnv();
    const { id } = (await json(await post(f.env, { mode: "code", task: "to be deleted" }))) as { id: string };

    const del = await handle(req("DELETE", `/sessions/${id}`), f.env);
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");
    expect(f.indexRemoved).toEqual([id]); // the Worker removes the index row after the DO is emptied (ADR D18)

    await expectError(await handle(req("GET", `/sessions/${id}`), f.env), 404);
    await expectError(await handle(req("DELETE", `/sessions/${id}`), f.env), 404);
    await expectError(await handle(req("GET", `/sessions/${id}/ws`, { headers: { upgrade: "websocket" } }), f.env), 404);
    await expectError(await handle(req("GET", `/sessions/${UNKNOWN}`), f.env), 404);
    await expectError(await handle(req("POST", `/sessions/${UNKNOWN}/debug/kill-sandbox`), f.env), 404);

    // Ids that are not UUIDs never reach a Durable Object.
    const touched = f.touched.length;
    await expectError(await handle(req("GET", "/sessions/not-a-uuid"), f.env), 404);
    await expectError(await handle(req("DELETE", "/sessions/..%2f..%2fworkspace"), f.env), 404);
    expect(f.touched).toHaveLength(touched);
  });

  it("unknown routes and non-upgrade ws requests", async () => {
    const f = fakeEnv();
    const { id } = (await json(await post(f.env, { mode: "code", task: "socket" }))) as { id: string };

    await expectError(await handle(req("GET", "/nope"), f.env), 404);
    await expectError(await handle(req("PUT", "/sessions"), f.env), 404);
    await expectError(await handle(req("GET", `/sessions/${id}/ws`), f.env), 426);

    const upgraded = await handle(req("GET", `/sessions/${id}/ws?lastSeq=12`, { headers: { upgrade: "websocket" } }), f.env);
    expect(upgraded.headers.get("x-forwarded-to")).toBe(id);
  });

  it("the debug kill endpoint exists only when enabled, and shares the delete limiter", async () => {
    const f = fakeEnv();
    const { id } = (await json(await post(f.env, { mode: "code", task: "kill me" }))) as { id: string };

    const res = await handle(req("POST", `/sessions/${id}/debug/kill-sandbox`), f.env);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true });
    expect(f.killed).toEqual([id]);
    expect(f.deleteKeys).toEqual([IP_A]);

    await expectError(await handle(req("POST", `/sessions/${id}/debug/kill-sandbox`), { ...f.env, debugEndpoints: false }), 404);
    await expectError(await handle(req("POST", `/sessions/${id}/debug/kill-sandbox`), { ...f.env, deleteLimiter: limiter(0).binding }), 429);
    expect(f.killed).toEqual([id]);
  });
});

describe("router (Phase 3: P3-c, P3-d)", () => {
  it("config lists repo, models and limits without secrets", async () => {
    const f = fakeEnv();
    const res = await handle(req("GET", "/config"), f.env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      repo: REPO.name,
      sha: REPO.sha,
      models: [
        { id: "deepseek-ai/deepseek-v4-flash", contextWindow: 1_000_000 },
        { id: "deepseek-ai/deepseek-v4-pro", contextWindow: 1_000_000 },
        { id: "moonshotai/kimi-k2.7-code", contextWindow: 262_144 },
        { id: "zai-org/glm-5.3", contextWindow: 1_000_000 },
      ],
      defaultModel: "deepseek-ai/deepseek-v4-flash",
      maxSteps: 30,
      maxTokens: 400_000,
      maxTaskChars: MAX_TASK_CHARS,
    });
    expect(text).not.toMatch(/aiand\.com|key|secret|token"/i);

    // Not rate limited, and it never wakes a Durable Object.
    for (let i = 0; i < 20; i++) expect((await handle(req("GET", "/config"), f.env)).status).toBe(200);
    expect(f.createKeys).toEqual([]);
    expect(f.deleteKeys).toEqual([]);
    expect(f.touched).toEqual([]);
    await expectError(await handle(req("POST", "/config"), f.env), 404);
  });

  it("validates the model on create", async () => {
    const f = fakeEnv({ createLimiter: limiter(100).binding });
    expect((await post(f.env, { mode: "code", task: "t", model: "deepseek-ai/deepseek-v4-pro" })).status).toBe(201);
    expect(f.created.at(-1)).toMatchObject({ mode: "code", task: "t", model: "deepseek-ai/deepseek-v4-pro" });

    expect((await post(f.env, { mode: "code", task: "t" })).status).toBe(201);
    expect(f.created.at(-1)).not.toHaveProperty("model"); // the engine falls back to the config default

    const n = f.created.length;
    await expectError(await post(f.env, { mode: "code", task: "t", model: "openai/gpt-oss-120b" }), 400, /model/);
    await expectError(await post(f.env, { mode: "code", task: "t", model: 3 }), 400, /model/);
    await expectError(await post(f.env, { mode: "code", task: "t", model: "" }), 400, /model/);
    expect(f.created).toHaveLength(n);
  });
});
