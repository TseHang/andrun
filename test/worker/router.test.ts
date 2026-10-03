import { describe, expect, it } from "vitest";
import { createGitHub } from "../../src/github";
import { BOT, FAKE_PAT, FAKE_REPO, createFakeGitHub, testKeys } from "../support/fake-github";
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
  const created: Record<string, unknown>[] = [];
  const fake = createFakeGitHub();
  const github = createGitHub({ apiUrl: "https://api.github.test", repo: FAKE_REPO, appId: "1", installationId: "2", privateKey: testKeys().privateKey, pat: FAKE_PAT, fetch: fake.fetch });
  const ghRead = limiter(60);
  const ghWrite = limiter(10);
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
          sessions.set(id, { id, mode: input.mode, title: input.task.slice(0, 80), status: "running", pending: null, sandboxRunning: false, sha: input.sha ?? REPO.sha, baseBranch: null, pr: null });
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
    github,
    githubWrites: true,
    githubReadLimiter: ghRead.binding,
    githubWriteLimiter: ghWrite.binding,
    ...over,
  };
  return { env, sessions, created, touched, indexRemoved, killed, index, fake, createKeys: create.keys, deleteKeys: del.keys, readKeys: ghRead.keys, writeKeys: ghWrite.keys };
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
    expect(await json(got)).toMatchObject({ id, status: "running", pending: null, sandboxRunning: false });
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
    await expectError(await post(f.env, { mode: "task", task: "x" }), 400, /mode/); // "review" is a mode since Phase 4
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
      githubWrites: true,
      reviewBrief: expect.stringMatching(/^Review this pull request\.[\s\S]*Correctness[\s\S]*severity/) as string,
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

  // ---------- Phase 4: GitHub ----------

  it("config reports githubWrites", async () => {
    const off = fakeEnv({ githubWrites: false, repo: { name: REPO.name, sha: null } });
    const body = await json(await handle(req("GET", "/config"), off.env));
    expect(body).toMatchObject({ githubWrites: false, sha: null, repo: REPO.name });
    expect(off.fake.requests).toEqual([]); // config never calls GitHub
  });

  it("code sessions resolve the default branch head; DEMO_SHA overrides it", async () => {
    const f = fakeEnv({ repo: { name: REPO.name, sha: null } });
    const head = f.fake.refs.get("main")!;
    const res = await post(f.env, { mode: "code", task: "t" });
    expect(res.status).toBe(201);
    const { id } = await json(res);
    expect(f.created).toEqual([{ id, mode: "code", task: "t", sha: head, baseBranch: "main" }]);

    // The override: the configured commit is used and GitHub is not asked.
    const pinned = fakeEnv();
    expect((await post(pinned.env, { mode: "code", task: "t" })).status).toBe(201);
    expect(pinned.created[0]).not.toHaveProperty("sha");
    expect(pinned.fake.requests).toEqual([]);

    // GitHub is down: no session is created.
    const down = fakeEnv({ repo: { name: REPO.name, sha: null } });
    down.fake.fail({ path: /^\/repos\//, status: 502, times: 5 });
    await expectError(await post(down.env, { mode: "code", task: "t" }), 502, /GitHub/);
    expect(down.created).toEqual([]);
    expect(down.touched).toEqual([]);
  });

  function withPulls(over: Partial<RouterEnv> = {}) {
    const f = fakeEnv(over);
    f.fake.addPull({ number: 12, title: "Handle the empty array in mean()", headRef: "agent/7f3a9c1e-1" });
    f.fake.addPull({ number: 13, title: "Add a --json flag to the CLI", headRef: "feat/json-flag", user: "octocat" });
    f.fake.addPull({
      number: 14,
      title: "Add slugify helper",
      headRef: "agent/1a2b3c4d-1",
      files: [{ filename: "src/slugify.js", status: "added", additions: 2, deletions: 0, patch: "@@ -0,0 +1,2 @@\n+a\n+b" }],
    });
    return f;
  }
  const row = (id: string, mode: "code" | "review", pr: number, status: SessionSummary["status"], created_at: number): SessionSummary => ({
    id,
    mode,
    title: "t",
    status,
    created_at,
    updated_at: created_at,
    pr,
  });

  it("pull list joins GitHub with the session index", async () => {
    const f = withPulls();
    f.index.push(
      row("code-14", "code", 14, "done", 1),
      row("review-14-old", "review", 14, "done", 2),
      row("review-14-new", "review", 14, "awaiting_approval", 3),
      row("code-12", "code", 12, "done", 4),
      { id: "no-pr", mode: "code", title: "t", status: "running", created_at: 5, updated_at: 5 },
    );
    const res = await handle(req("GET", "/pulls"), f.env);
    expect(res.status).toBe(200);
    const { pulls } = (await res.json()) as { pulls: Record<string, unknown>[] };
    expect(pulls.map((p) => p["number"])).toEqual([14, 13, 12]);
    expect(pulls[0]).toEqual({
      number: 14,
      title: "Add slugify helper",
      author: BOT,
      headRef: "agent/1a2b3c4d-1",
      updatedAt: expect.any(String) as string,
      url: "https://github.com/TseHang/andrun-demo/pull/14",
      mine: true,
      codeSession: { id: "code-14", status: "done" },
      reviewSession: { id: "review-14-new", status: "awaiting_approval" }, // the newest review session
    });
    expect(pulls[1]).toMatchObject({ number: 13, mine: false, codeSession: null, reviewSession: null });
    expect(pulls[2]).toMatchObject({ number: 12, mine: true, codeSession: { id: "code-12", status: "done" }, reviewSession: null });
    expect(f.touched).toEqual([]); // no session Durable Object is woken
    expect(f.readKeys).toEqual([IP_A]);

    f.fake.fail({ path: /\/pulls$/, status: 502 });
    await expectError(await handle(req("GET", "/pulls"), f.env), 502, /GitHub.*502/);

    const limited = withPulls({ githubReadLimiter: limiter(1).binding });
    expect((await handle(req("GET", "/pulls"), limited.env)).status).toBe(200);
    const refused = await handle(req("GET", "/pulls/14"), limited.env);
    await expectError(refused, 429);
    expect(refused.headers.get("retry-after")).toBe("60");
  });

  it("reads one pull request for the review start page", async () => {
    const f = withPulls();
    const res = await handle(req("GET", "/pulls/14"), f.env);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      number: 14,
      title: "Add slugify helper",
      author: BOT,
      headRef: "agent/1a2b3c4d-1",
      baseRef: "main",
      headSha: f.fake.refs.get("main"),
      state: "open",
      additions: 2,
      deletions: 0,
      changedFiles: 1,
      url: "https://github.com/TseHang/andrun-demo/pull/14",
      files: [{ path: "src/slugify.js", status: "added", additions: 2, deletions: 0, patch: "@@ -0,0 +1,2 @@\n+a\n+b" }],
    });
    await expectError(await handle(req("GET", "/pulls/99"), f.env), 404);
    await expectError(await handle(req("GET", "/pulls/abc"), f.env), 404);
    await expectError(await handle(req("GET", "/pulls/0"), f.env), 404);
    await expectError(await handle(req("POST", "/pulls"), f.env), 404);
  });

  it("review sessions are created from an open pull request", async () => {
    const f = withPulls();
    const res = await post(f.env, { mode: "review", pr: 14, task: "  Review this.  ", model: "zai-org/glm-5.3" });
    expect(res.status).toBe(201);
    const { id } = await json(res);
    expect(f.created).toEqual([
      {
        id,
        mode: "review",
        task: "Review this.",
        model: "zai-org/glm-5.3",
        sha: f.fake.refs.get("main"),
        pr: { number: 14, title: "Add slugify helper", files: [{ path: "src/slugify.js", status: "added", additions: 2, deletions: 0, patch: "@@ -0,0 +1,2 @@\n+a\n+b" }] },
      },
    ]);
    expect(f.createKeys).toEqual([IP_A]); // the create limiter covers reviews too

    const n = f.created.length;
    await expectError(await post(f.env, { mode: "review", task: "brief" }), 400, /pr/);
    await expectError(await post(f.env, { mode: "review", pr: "14", task: "brief" }), 400, /pr/);
    await expectError(await post(f.env, { mode: "review", pr: 1.5, task: "brief" }), 400, /pr/);
    await expectError(await post(f.env, { mode: "review", pr: 14, task: " " }), 400, /task/);
    await expectError(await post(f.env, { mode: "review", pr: 99, task: "brief" }, IP_B), 404);
    await expectError(await post(f.env, { mode: "task", task: "brief" }, IP_B), 400, /mode/);

    f.fake.pulls.find((p) => p.number === 13)!.state = "closed";
    await expectError(await post(f.env, { mode: "review", pr: 13, task: "brief" }, IP_B), 400, /pull request #13 is not open/);
    f.fake.addPull({ number: 16, title: "Fork", headRef: "patch-1", user: "stranger", headRepo: "stranger/andrun-demo" });
    await expectError(await post(f.env, { mode: "review", pr: 16, task: "brief" }, IP_B), 400, /pull requests from forks are not supported/);
    // Security review: a review must not silently cover only the first page of files.
    f.fake.addPull({ number: 17, title: "Huge", headRef: "feat/huge", user: "octocat", changedFiles: 140, files: [{ filename: "a.js", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+a" }] });
    await expectError(await post(f.env, { mode: "review", pr: 17, task: "brief" }, IP_B), 400, /more than 100 files/);
    expect(f.created).toHaveLength(n);
  });

  it("responses carry no credential", async () => {
    const f = withPulls();
    for (const path of ["/config", "/pulls", "/pulls/14"]) {
      const text = await (await handle(req("GET", path), f.env)).text();
      expect(text).not.toMatch(/ghs_|github_pat_|PRIVATE KEY|installation/i);
    }
  });

  // ---------- A7: review comments (cut first) ----------

  function withComments(over: Partial<RouterEnv> = {}) {
    const f = withPulls(over);
    const a = f.fake.addComment({ pull: 12, user: "octocat", path: "src/stats.js", line: 3, body: "Should mean([]) return 0 or throw?" });
    const b = f.fake.addComment({ pull: 12, user: "octocat", path: "test/stats.test.js", line: 9, body: "Please add a case for a single element." });
    f.fake.addComment({ pull: 12, user: "TseHang", path: b.path, line: b.line, body: "Will do.", in_reply_to_id: b.id });
    return { ...f, a, b };
  }

  it("review comments of a pull request", async () => {
    const f = withComments();
    const res = await handle(req("GET", "/pulls/12/comments"), f.env);
    expect(res.status).toBe(200);
    const { comments } = (await res.json()) as { comments: Record<string, unknown>[] };
    expect(comments).toMatchObject([
      { id: f.a.id, author: "octocat", path: "src/stats.js", line: 3, body: "Should mean([]) return 0 or throw?", replies: [], answered: false },
      { id: f.b.id, author: "octocat", answered: true, replies: [{ author: "TseHang", body: "Will do." }] },
    ]);
    expect(f.readKeys).toEqual([IP_A]);
    await expectError(await handle(req("GET", "/pulls/99/comments"), f.env), 404);
    await expectError(await handle(req("GET", "/pulls/x/comments"), f.env), 404);

    // The list says how many comments wait on a pull request &run opened; other rows carry no count.
    const { pulls } = (await (await handle(req("GET", "/pulls"), f.env)).json()) as { pulls: Record<string, unknown>[] };
    expect(pulls.find((p) => p["number"] === 12)).toMatchObject({ openComments: 1 });
    expect(pulls.find((p) => p["number"] === 14)).toMatchObject({ openComments: 0 });
    expect(pulls.find((p) => p["number"] === 13)).not.toHaveProperty("openComments");
  });

  it("the comment counts of the list are capped", async () => {
    // Security review: one list request must not fan out into one GitHub call per pull request without a bound.
    const f = fakeEnv();
    for (let i = 0; i < 14; i++) f.fake.addPull({ number: 100 + i, title: `PR ${i}`, headRef: `agent/0000000${i.toString(16)}-1` });
    const { pulls } = (await (await handle(req("GET", "/pulls"), f.env)).json()) as { pulls: Record<string, unknown>[] };
    expect(pulls).toHaveLength(14);
    expect(f.fake.requests.filter((r) => r.path.includes("/comments"))).toHaveLength(10);
    expect(pulls.filter((p) => "openComments" in p)).toHaveLength(10);
    expect(pulls.slice(0, 10).every((p) => p["openComments"] === 0)).toBe(true); // the newest ten
  });

  it("reply to a review comment", async () => {
    const f = withComments();
    const path = `/pulls/12/comments/${f.a.id}/replies`;
    const res = await handle(req("POST", path, { body: { text: "  Good catch. It should throw.  " } }), f.env);
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({ id: expect.any(Number) as number, url: expect.stringContaining("#discussion_r") as string });
    expect(f.fake.comments.at(-1)).toMatchObject({ user: "TseHang", body: "Good catch. It should throw.", in_reply_to_id: f.a.id });
    expect(f.writeKeys).toEqual([IP_A]);

    const n = f.fake.comments.length;
    await expectError(await handle(req("POST", path, { body: { text: "   " } }), f.env), 400, /text/);
    await expectError(await handle(req("POST", path, { body: { text: "x".repeat(4001) } }), f.env), 400, /4000/);
    await expectError(await handle(req("POST", path, { body: "{not json" }), f.env), 400);
    await expectError(await handle(req("POST", "/pulls/12/comments/424242/replies", { body: { text: "x" } }), f.env), 404);
    await expectError(await handle(req("POST", "/pulls/12/comments/abc/replies", { body: { text: "x" } }), f.env), 404);
    expect(f.fake.comments).toHaveLength(n);

    // Security review: replies are only for pull requests &run opened, not any pull request in the repo.
    await expectError(await handle(req("POST", "/pulls/13/comments/1/replies", { body: { text: "x" } }), f.env), 400, /only for pull requests &run opened/);
    expect(f.fake.comments).toHaveLength(n);

    // The kill switch and the write limiter (D14).
    const off = withComments({ githubWrites: false });
    await expectError(await handle(req("POST", `/pulls/12/comments/${off.a.id}/replies`, { body: { text: "x" } }), off.env), 503, /GitHub writes are disabled/);
    expect(off.fake.requests.filter((r) => r.method === "POST" && r.path.includes("/replies"))).toEqual([]);

    const limited = withComments({ githubWriteLimiter: limiter(1).binding });
    const p = `/pulls/12/comments/${limited.a.id}/replies`;
    expect((await handle(req("POST", p, { body: { text: "one" } }), limited.env)).status).toBe(201);
    const refused = await handle(req("POST", p, { body: { text: "two" } }), limited.env);
    await expectError(refused, 429);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect((await handle(req("POST", p, { body: { text: "other ip" }, ip: IP_B }), limited.env)).status).toBe(201);
  });
});
