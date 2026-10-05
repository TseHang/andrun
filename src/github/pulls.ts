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
  /** The author's GitHub avatar; null when GitHub gives none. */
  authorAvatar: string | null;
  /** Opened by &run: this App's bot as author, on an `agent/` branch. */
  mine: boolean;
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

/** A submitted review of a pull request, with its line comments: what a Code session's author is asked to address. */
export interface PullReview {
  id: number;
  author: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED";
  body: string;
  submittedAt: string;
  url: string;
  comments: { path: string; line: number | null; body: string }[];
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
  user: { login: string; avatar_url?: string };
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

/** Opened by &run: this App's bot as author, on an `agent/` branch. */
function openedByAndrun(p: RawPull, botLogin: string): boolean {
  return p.user.login === botLogin && p.head.ref.startsWith("agent/");
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
    mine: openedByAndrun(p, botLogin),
  }));
}

export async function getPull(request: Request, repo: string, token: string, botLogin: string, n: number): Promise<PullDetail> {
  const p = (await request("GET", `/repos/${repo}/pulls/${n}`, token)) as RawPull;
  const files = (await request("GET", `/repos/${repo}/pulls/${n}/files?per_page=100`, token)) as RawFile[];
  return {
    number: p.number,
    title: p.title,
    body: p.body ?? "",
    author: p.user.login,
    authorAvatar: p.user.avatar_url ?? null,
    mine: openedByAndrun(p, botLogin),
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

const REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED"]);

/** Submitted reviews, newest first; a review that says nothing (no text, no line comments) is left out. Pending and dismissed ones are not shown. */
export async function getPullReviews(request: Request, repo: string, token: string, n: number): Promise<PullReview[]> {
  const readPages = async <T>(kind: "reviews" | "comments"): Promise<T[]> => {
    const all: T[] = [];
    for (let page = 1; ; page++) {
      const rows = (await request("GET", `/repos/${repo}/pulls/${n}/${kind}?per_page=100&page=${page}`, token)) as T[];
      all.push(...rows);
      if (rows.length < 100) return all;
    }
  };
  const raw = await readPages<{ id: number; user: { login: string } | null; state: string; body: string | null; submitted_at?: string; html_url: string }>("reviews");
  const comments = await readPages<{ pull_request_review_id: number | null; path: string; line: number | null; body: string }>("comments");
  return raw
    .filter((r) => REVIEW_STATES.has(r.state))
    .map((r) => ({
      id: r.id,
      author: r.user?.login ?? "ghost",
      state: r.state as PullReview["state"],
      body: r.body ?? "",
      submittedAt: r.submitted_at ?? "",
      url: r.html_url,
      comments: comments.filter((c) => c.pull_request_review_id === r.id).map((c) => ({ path: c.path, line: c.line, body: c.body })),
    }))
    .filter((r) => r.body.trim() !== "" || r.comments.length > 0)
    .reverse();
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
