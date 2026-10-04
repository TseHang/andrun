// Thin client for the Worker API.
import type { Status } from "../../src/core/events";
import type { SessionSnapshot, SessionSummary } from "../../src/session/protocol";

export interface Config {
  repo: string;
  sha: string | null;
  githubWrites: boolean;
  reviewBrief: string;
  models: { id: string; contextWindow: number; efforts: string[] }[];
  defaultModel: string;
  autoModel: string;
  maxTurnCost: number;
  costNotice: number;
  maxTaskChars: number;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getConfig(): Promise<Config> {
  const res = await fetch("/config");
  if (!res.ok) throw new Error(`config ${res.status}`);
  return (await res.json()) as Config;
}

/** Newest first by creation time (the server does not promise an order). */
export async function listSessions(): Promise<SessionSummary[]> {
  const res = await fetch("/sessions");
  if (!res.ok) throw new Error(`list ${res.status}`);
  const rows = (await res.json()) as SessionSummary[];
  return rows.sort((a, b) => b.created_at - a.created_at);
}

export type CreateResult = { ok: true; id: string } | { ok: false; error: string };

async function create(body: object): Promise<CreateResult> {
  try {
    const res = await fetch("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 201) return { ok: true, id: ((await res.json()) as { id: string }).id };
    if (res.status === 429) return { ok: false, error: `Too many new sessions. Try again in ${res.headers.get("retry-after") ?? 60} seconds.` };
    if (res.status === 503) return { ok: false, error: "New sessions are turned off. Existing sessions still work." };
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, error: err?.error ?? "Could not start the session." };
  } catch {
    return { ok: false, error: "Could not start the session." };
  }
}

/** A model with its reasoning effort; auto has no effort (it picks one per message). */
export interface ModelChoice {
  model: string;
  reasoning?: string;
}

export const defaultChoice = (config: Config): ModelChoice => {
  const reasoning = config.models.find((m) => m.id === config.defaultModel)?.efforts[0];
  return { model: config.defaultModel, ...(reasoning !== undefined && { reasoning }) };
};

export const createSession = (task: string, choice: ModelChoice): Promise<CreateResult> => create({ mode: "code", task, ...choice });

export const createReview = (pr: number, task: string, choice: ModelChoice): Promise<CreateResult> => create({ mode: "review", pr, task, ...choice });

/** The snapshot, null when the session does not exist; throws on other failures. */
export async function getSnapshot(id: string): Promise<SessionSnapshot | null> {
  const res = await fetch(`/sessions/${id}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`session ${res.status}`);
  return (await res.json()) as SessionSnapshot;
}

export type DeleteResult = "deleted" | "limited" | "failed";

export async function deleteSession(id: string): Promise<DeleteResult> {
  try {
    const res = await fetch(`/sessions/${id}`, { method: "DELETE" });
    if (res.status === 204 || res.status === 404) return "deleted";
    return res.status === 429 ? "limited" : "failed";
  } catch {
    return "failed";
  }
}

export interface PullRow {
  number: number;
  title: string;
  author: string;
  headRef: string;
  updatedAt: string;
  url: string;
  mine: boolean;
  codeSession: { id: string; status: Status } | null;
  reviewSession: { id: string; status: Status } | null;
}

/** Open pull requests, live from GitHub. Throws with the message to show. */
export async function listPulls(): Promise<PullRow[]> {
  const res = await fetch("/pulls");
  if (res.ok) return ((await res.json()) as { pulls: PullRow[] }).pulls;
  if (res.status === 429) throw new Error("Too many requests. Try again in 60 seconds.");
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  throw new Error(body?.error ?? "Could not load pull requests.");
}

export interface PullFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

export interface PullDetail {
  number: number;
  title: string;
  body: string;
  author: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  state: "open" | "closed";
  fork: boolean;
  url: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: PullFile[];
}

/** One pull request with its diff, "not_found" for a 404; throws with the message to show. */
export async function getPull(n: number): Promise<PullDetail | "not_found"> {
  const res = await fetch(`/pulls/${n}`);
  if (res.ok) return (await res.json()) as PullDetail;
  if (res.status === 404) return "not_found";
  if (res.status === 429) throw new Error("Too many requests. Try again in 60 seconds.");
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  throw new Error(body?.error ?? "Could not load the pull request.");
}

/** A file at a pull request's head, null when there is none. */
export async function getPullFile(n: number, path: string): Promise<string | null> {
  const res = await fetch(`/pulls/${n}/files?path=${encodeURIComponent(path)}`);
  if (!res.ok) return null;
  return ((await res.json()) as { path: string; content: string }).content;
}

/** A changed file's saved content, null when there is none; throws on other failures. */
export async function getFile(id: string, path: string): Promise<string | null> {
  const res = await fetch(`/sessions/${id}/files?path=${encodeURIComponent(path)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`file ${res.status}`);
  return ((await res.json()) as { path: string; content: string }).content;
}
