// Reading pull requests and the default branch, with the App's installation token.

import type { Request } from "./client";

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

interface RawPull {
  number: number;
  title: string;
  state: string;
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

export async function defaultBranchHead(request: Request, repo: string, token: string): Promise<{ branch: string; sha: string }> {
  const info = (await request("GET", `/repos/${repo}`, token)) as { default_branch: string };
  const ref = (await request("GET", `/repos/${repo}/git/ref/heads/${info.default_branch}`, token)) as { object: { sha: string } };
  return { branch: info.default_branch, sha: ref.object.sha };
}
