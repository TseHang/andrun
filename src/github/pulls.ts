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

export interface ReviewReply {
  id: number;
  author: string;
  body: string;
  createdAt: string;
}

export interface ReviewThread {
  id: number;
  author: string;
  path: string;
  line: number;
  body: string;
  createdAt: string;
  url: string;
  replies: ReviewReply[];
  answered: boolean;
}

interface RawComment {
  id: number;
  user: { login: string };
  path: string;
  line: number | null;
  body: string;
  created_at: string;
  html_url: string;
  in_reply_to_id?: number;
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
    fork: p.head.repo?.full_name !== repo,
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

/** The review comments of a pull request, grouped into threads: a comment with no parent starts one. */
export async function listReviewComments(request: Request, repo: string, token: string, n: number): Promise<ReviewThread[]> {
  const raw = (await request("GET", `/repos/${repo}/pulls/${n}/comments?per_page=100`, token)) as RawComment[];
  const threads = new Map<number, ReviewThread>();
  for (const c of raw) {
    if (c.in_reply_to_id === undefined || c.in_reply_to_id === null) {
      threads.set(c.id, { id: c.id, author: c.user.login, path: c.path, line: c.line ?? 0, body: c.body, createdAt: c.created_at, url: c.html_url, replies: [], answered: false });
    }
  }
  for (const c of raw) {
    const thread = c.in_reply_to_id === undefined || c.in_reply_to_id === null ? undefined : threads.get(c.in_reply_to_id);
    if (!thread) continue;
    thread.replies.push({ id: c.id, author: c.user.login, body: c.body, createdAt: c.created_at });
    thread.answered = true;
  }
  return [...threads.values()];
}

/** Replies in a review comment's thread, as the App bot: the pull request's author answers its reviewer. */
export async function replyToComment(request: Request, repo: string, token: string, n: number, commentId: number, text: string): Promise<{ id: number; url: string }> {
  const res = (await request("POST", `/repos/${repo}/pulls/${n}/comments/${commentId}/replies`, token, { body: text })) as { id: number; html_url: string };
  return { id: res.id, url: res.html_url };
}
