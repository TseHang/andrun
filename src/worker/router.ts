// The Worker's HTTP router (Phase 2, P2-b): a pure function from Request + environment to Response.
// Web-standard APIs only, so it runs under Node tests and inside a Worker. Durable Objects are
// reached through `env.session(id)` / `env.workspace`; ids are validated before they name one.

import { AUTO_MODEL, contextWindowFor, defaultConfig, selectableModels } from "../core/config";
import { GitHubError } from "../github";
import { DEFAULT_REVIEW_BRIEF, MAX_TASK_CHARS } from "../session/protocol";
import type { SessionSummary } from "../session/protocol";
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
  const { mode, task, model, reasoning, pr } = body as Record<string, unknown>;
  if (mode !== "code" && mode !== "review" && mode !== "task") return error(400, 'mode must be "code", "review" or "task"');
  const trimmed = typeof task === "string" ? task.trim() : "";
  if (trimmed === "" || trimmed.length > MAX_TASK_CHARS) {
    return error(400, `task must be a non-empty string of at most ${MAX_TASK_CHARS} characters`);
  }

  const choice = selectableModels.find((m) => m.id === model);
  if (model !== undefined && model !== AUTO_MODEL && !choice) {
    return error(400, `model must be one of: ${[...selectableModels.map((m) => m.id), AUTO_MODEL].join(", ")}`);
  }
  // Auto picks the effort itself; a model without one given runs on its first (cheapest) effort.
  if (reasoning !== undefined && (typeof reasoning !== "string" || !choice?.efforts.includes(reasoning))) {
    return error(400, choice ? `reasoning must be one of: ${choice.efforts.join(", ")}` : model === AUTO_MODEL ? "auto picks the reasoning itself" : "reasoning needs a model");
  }
  const effort = choice ? ((reasoning as string | undefined) ?? choice.efforts[0]) : undefined;

  if (mode === "review" && (typeof pr !== "number" || !Number.isSafeInteger(pr) || pr < 1)) return error(400, "pr must be a positive integer");

  // The repo is fixed by configuration (P2-h): other fields are ignored.
  const id = env.newId();
  const common = { id, task: trimmed, ...(model !== undefined && { model: model as string }), ...(effort !== undefined && { reasoning: effort }) };
  try {
    if (mode === "task") {
      await env.session(id).create({ ...common, mode });
    } else if (mode === "code") {
      if (env.repo.sha !== null) {
        await env.session(id).create({ ...common, mode });
      } else {
        const head = await env.github.defaultBranchHead();
        await env.session(id).create({ ...common, mode, sha: head.sha, baseBranch: head.branch });
      }
    } else {
      const pull = await env.github.getPull(pr as number);
      if (pull.state !== "open") return error(400, `pull request #${pull.number} is not open`);
      if (pull.fork) return error(400, "pull requests from forks are not supported");
      if (pull.changedFiles > pull.files.length) return error(400, "pull requests with more than 100 files are not supported");
      await env.session(id).create({ ...common, mode, sha: pull.headSha, pr: { number: pull.number, title: pull.title, files: pull.files } });
    }
  } catch (err) {
    return githubFailure(err);
  }
  return json({ id }, 201);
}

/** A GitHub error becomes 404 or 502; anything else is not ours to handle. */
function githubFailure(err: unknown): Response {
  if (!(err instanceof GitHubError)) throw err;
  return error(err.status === 404 ? 404 : 502, err.message);
}

async function listPulls(request: Request, env: RouterEnv): Promise<Response> {
  const refused = await limited(env.githubReadLimiter, request);
  if (refused) return refused;
  try {
    const [pulls, sessions] = await Promise.all([env.github.listPulls(), env.workspace.list()]);
    const newest = (number: number, mode: "code" | "review") => {
      let best: SessionSummary | undefined;
      for (const s of sessions) if (s.pr === number && s.mode === mode && (!best || s.created_at > best.created_at)) best = s;
      return best ? { id: best.id, status: best.status } : null;
    };
    return json({
      pulls: pulls.map((p) => ({ ...p, codeSession: newest(p.number, "code"), reviewSession: newest(p.number, "review") })),
    });
  } catch (err) {
    return githubFailure(err);
  }
}

async function getPull(request: Request, env: RouterEnv, n: string): Promise<Response> {
  if (!/^[1-9]\d{0,14}$/.test(n)) return notFound();
  const refused = await limited(env.githubReadLimiter, request);
  if (refused) return refused;
  try {
    return json(await env.github.getPull(Number(n)));
  } catch (err) {
    return githubFailure(err);
  }
}

async function getPullFile(request: Request, env: RouterEnv, n: string): Promise<Response> {
  if (!/^[1-9]\d{0,14}$/.test(n)) return notFound();
  const refused = await limited(env.githubReadLimiter, request);
  if (refused) return refused;
  const path = new URL(request.url).searchParams.get("path");
  // Only what the preview shows: an HTML page. Nothing else of the repo is served here.
  if (!path || !/\.html?$/i.test(path)) return error(404, "no such file");
  try {
    const content = await env.github.getPullFile(Number(n), path);
    return content === null ? error(404, "no such file") : json({ path, content });
  } catch (err) {
    return githubFailure(err);
  }
}

function config(env: RouterEnv): Response {
  return json({
    repo: env.repo.name,
    sha: env.repo.sha,
    githubWrites: env.githubWrites,
    reviewBrief: DEFAULT_REVIEW_BRIEF,
    models: selectableModels.map((m) => ({ ...m, contextWindow: contextWindowFor(defaultConfig, m.id) })),
    defaultModel: defaultConfig.models.code,
    autoModel: AUTO_MODEL,
    maxTurnCost: defaultConfig.maxTurnCost,
    costNotice: defaultConfig.costNotice,
    maxTaskChars: MAX_TASK_CHARS,
  });
}

async function route(request: Request, env: RouterEnv): Promise<Response> {
  const { pathname } = new URL(request.url);
  const parts = pathname.split("/").filter((p, i) => i === 0 || p !== "");
  const method = request.method;
  if (parts[0] === "" && parts[1] === "config" && parts.length === 2) return method === "GET" ? config(env) : notFound();
  if (parts[0] === "" && parts[1] === "pulls") {
    if (parts.length > 4 || method !== "GET") return notFound();
    if (parts.length === 4) return parts[3] === "files" ? getPullFile(request, env, parts[2]!) : notFound();
    return parts.length === 2 ? listPulls(request, env) : getPull(request, env, parts[2]!);
  }
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

  if (rest === "files" && method === "GET") {
    const path = new URL(request.url).searchParams.get("path");
    if (!path) return error(404, "no such file");
    const content = await env.session(id).file(path);
    return content === null ? error(404, "no such file") : json({ path, content });
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
