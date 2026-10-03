// The Worker's HTTP router (Phase 2, P2-b): a pure function from Request + environment to Response.
// Web-standard APIs only, so it runs under Node tests and inside a Worker. Durable Objects are
// reached through `env.session(id)` / `env.workspace`; ids are validated before they name one.

import { contextWindowFor, defaultConfig, selectableModels } from "../core/config";
import { MAX_TASK_CHARS } from "../session/protocol";
import type { RouterEnv } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function error(status: number, message: string, headers?: Record<string, string>): Response {
  return json({ error: message }, status, headers);
}

const notFound = () => error(404, "not found");

/** Per-IP limit (ADR D14). Returns a 429 response when refused, otherwise null. */
async function limited(limiter: RouterEnv["createLimiter"], request: Request): Promise<Response | null> {
  const key = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await limiter.limit({ key });
  return success ? null : error(429, "too many requests", { "retry-after": "60" });
}

async function createSession(request: Request, env: RouterEnv): Promise<Response> {
  if (env.killSwitch) return error(503, "new sessions are disabled");
  const refused = await limited(env.createLimiter, request);
  if (refused) return refused;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error(400, "body must be valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return error(400, "body must be a JSON object");
  const { mode, task, model } = body as Record<string, unknown>;
  if (mode !== "code") return error(400, 'mode must be "code"');
  const trimmed = typeof task === "string" ? task.trim() : "";
  if (trimmed === "" || trimmed.length > MAX_TASK_CHARS) {
    return error(400, `task must be a non-empty string of at most ${MAX_TASK_CHARS} characters`);
  }

  if (model !== undefined && (typeof model !== "string" || !selectableModels.includes(model))) {
    return error(400, `model must be one of: ${selectableModels.join(", ")}`);
  }

  // The repo is fixed by configuration (P2-h): other fields are ignored.
  const id = env.newId();
  await env.session(id).create({ id, mode: "code", task: trimmed, ...(model !== undefined && { model }) });
  return json({ id }, 201);
}

function config(env: RouterEnv): Response {
  return json({
    repo: env.repo.name,
    sha: env.repo.sha,
    models: selectableModels.map((id) => ({ id, contextWindow: contextWindowFor(defaultConfig, id) })),
    defaultModel: defaultConfig.models.code,
    maxSteps: defaultConfig.maxSteps,
    maxTokens: defaultConfig.maxTokens,
    maxTaskChars: MAX_TASK_CHARS,
  });
}

async function route(request: Request, env: RouterEnv): Promise<Response> {
  const { pathname } = new URL(request.url);
  const parts = pathname.split("/").filter((p, i) => i === 0 || p !== "");
  const method = request.method;
  if (parts[0] === "" && parts[1] === "config" && parts.length === 2) return method === "GET" ? config(env) : notFound();
  if (parts[0] !== "" || parts[1] !== "sessions") return notFound();

  if (parts.length === 2) {
    if (method === "POST") return createSession(request, env);
    if (method === "GET") return json(await env.workspace.list());
    return notFound();
  }

  const id = parts[2]!;
  if (!UUID.test(id)) return notFound();
  const rest = parts.slice(3).join("/");

  if (rest === "") {
    if (method === "GET") {
      const snapshot = await env.session(id).snapshot();
      return snapshot ? json(snapshot) : notFound();
    }
    if (method === "DELETE") {
      const refused = await limited(env.deleteLimiter, request);
      if (refused) return refused;
      if (!(await env.session(id).remove())) return notFound();
      await env.workspace.remove(id); // the DO has emptied itself (ADR D18)
      return new Response(null, { status: 204 });
    }
    return notFound();
  }

  if (rest === "ws" && method === "GET") {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return error(426, "expected a WebSocket upgrade");
    if (!(await env.session(id).snapshot())) return notFound();
    return env.session(id).fetch(request);
  }

  if (rest === "debug/kill-sandbox" && method === "POST" && env.debugEndpoints) {
    const refused = await limited(env.deleteLimiter, request);
    if (refused) return refused;
    return (await env.session(id).killSandbox()) ? json({ ok: true }) : notFound();
  }

  return notFound();
}

export async function handle(request: Request, env: RouterEnv): Promise<Response> {
  try {
    return await route(request, env);
  } catch (err) {
    console.error("router: unhandled error", err);
    return error(500, "internal error");
  }
}
