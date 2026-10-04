// Reading pull requests and the default branch, with the App's installation token.

import { GitHubError, type Request } from "./client";

export interface PullSummary {
  number: number;
  title: string;
  author: string;
  headRef: string;
  updatedAt: string;
  url: string;
  /** Opened by &run: this App's bot as author, on an `agent/` branch. */
  mine: boolean;
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

/** Where a pull request stands. A closed one can be reopened; a merged one cannot. */
export type PullState = "open" | "closed" | "merged";

interface RawPull {
  number: number;
  title: string;
  body: string | null;
  state: string;
  merged?: boolean;
  html_url: string;
  updated_at: string;
  user: { login: string };
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref: string };
  additions: number;
  deletions: number;
  changed_files: number;
}

interface RawFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export async function listPulls(request: Request, repo: string, token: string, botLogin: string): Promise<PullSummary[]> {
  const raw = (await request("GET", `/repos/${repo}/pulls?state=open&per_page=50`, token)) as RawPull[];
  return raw.map((p) => ({
    number: p.number,
    title: p.title,
    author: p.user.login,
    headRef: p.head.ref,
    updatedAt: p.updated_at,
    url: p.html_url,
    mine: p.user.login === botLogin && p.head.ref.startsWith("agent/"),
  }));
}

export async function getPull(request: Request, repo: string, token: string, n: number): Promise<PullDetail> {
  const p = (await request("GET", `/repos/${repo}/pulls/${n}`, token)) as RawPull;
  const files = (await request("GET", `/repos/${repo}/pulls/${n}/files?per_page=100`, token)) as RawFile[];
  return {
    number: p.number,
    title: p.title,
    body: p.body ?? "",
    author: p.user.login,
    headRef: p.head.ref,
    baseRef: p.base.ref,
    headSha: p.head.sha,
    state: p.state === "open" ? "open" : "closed",
    fork: p.head.repo?.full_name.toLowerCase() !== repo.toLowerCase(),
    url: p.html_url,
    additions: p.additions,
    deletions: p.deletions,
    changedFiles: p.changed_files,
    files: files.map((f) => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch ?? null })),
  };
}

export async function pullState(request: Request, repo: string, token: string, n: number): Promise<PullState> {
  const p = (await request("GET", `/repos/${repo}/pulls/${n}`, token)) as RawPull;
  return p.merged ? "merged" : p.state === "open" ? "open" : "closed";
}

/** A file's content at the pull request's head, null when it is not a readable file or the pull request is a fork. */
export async function getPullFile(request: Request, repo: string, token: string, n: number, path: string): Promise<string | null> {
  const p = (await request("GET", `/repos/${repo}/pulls/${n}`, token)) as RawPull;
  if (p.head.repo?.full_name.toLowerCase() !== repo.toLowerCase()) return null;
  // "." and ".." would be resolved by the URL and reach another API route.
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  const encoded = segments.map(encodeURIComponent).join("/");
  let raw: unknown;
  try {
    raw = await request("GET", `/repos/${repo}/contents/${encoded}?ref=${p.head.sha}`, token);
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) return null;
    throw err;
  }
  const file = raw as { type?: string; encoding?: string; content?: string } | null;
  if (!file || Array.isArray(file) || file.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string") return null;
  const bin = atob(file.content.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export async function defaultBranchHead(request: Request, repo: string, token: string): Promise<{ branch: string; sha: string }> {
  const info = (await request("GET", `/repos/${repo}`, token)) as { default_branch: string };
  const ref = (await request("GET", `/repos/${repo}/git/ref/heads/${info.default_branch}`, token)) as { object: { sha: string } };
  return { branch: info.default_branch, sha: ref.object.sha };
}
