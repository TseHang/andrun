// Publishing a session's changes as a pull request (ADR D9, P4-f): one branch per round, a tree that is
// always "base tree + all files" so every push is cumulative, and no force push. Every step can be
// retried: a retry reuses the commit, the ref and the pull request the first attempt left behind.

import { GitHubError, type Request } from "./client";

export type PublishFile = { path: string; content: string } | { path: string; deleted: true };

export interface PublishInput {
  branchPrefix: string;
  round: number;
  baseSha: string;
  baseBranch: string;
  title: string;
  body: string;
  files: PublishFile[];
}

export interface PublishResult {
  number: number;
  url: string;
  branch: string;
  round: number;
  updated: boolean;
}

interface RawPull {
  number: number;
  state: string;
  html_url: string;
}

interface RawCommit {
  tree: { sha: string };
  parents: { sha: string }[];
}

export async function publish(request: Request, repo: string, token: string, input: PublishInput): Promise<PublishResult> {
  const get = (path: string) => request("GET", `/repos/${repo}${path}`, token);
  const post = (path: string, body: unknown) => request("POST", `/repos/${repo}${path}`, token, body);
  const owner = repo.split("/")[0];

  let round = input.round;
  let branch = `${input.branchPrefix}-${round}`;
  let pulls: RawPull[];
  for (;;) {
    pulls = (await get(`/pulls?head=${owner}:${branch}&state=all`)) as RawPull[];
    if (pulls[0]?.state !== "closed") break;
    round += 1;
    branch = `${input.branchPrefix}-${round}`;
  }
  const open = pulls.find((p) => p.state === "open");

  const tree = await buildTree(get, post, input);

  const existing = await get(`/git/ref/heads/${branch}`).catch((e: unknown) => {
    if (e instanceof GitHubError && e.status === 404) return undefined;
    throw e;
  });
  let updated = false;
  if (!existing) {
    const commit = (await post("/git/commits", { message: input.title, tree, parents: [input.baseSha] })) as { sha: string };
    await post("/git/refs", { ref: `refs/heads/${branch}`, sha: commit.sha });
  } else {
    const head = (existing as { object: { sha: string } }).object.sha;
    const headCommit = (await get(`/git/commits/${head}`)) as RawCommit;
    const fromBase = headCommit.parents.length === 1 && headCommit.parents[0]?.sha === input.baseSha;
    if (pulls.length === 0 && !fromBase) throw new GitHubError(`branch ${branch} already exists and was not created by this session`, 409);
    if (headCommit.tree.sha !== tree) {
      const commit = (await post("/git/commits", { message: input.title, tree, parents: [head] })) as { sha: string };
      await request("PATCH", `/repos/${repo}/git/refs/heads/${branch}`, token, { sha: commit.sha, force: false });
      updated = open !== undefined;
    }
  }

  const pull =
    open ?? ((await post("/pulls", { title: input.title, head: branch, base: input.baseBranch, body: input.body })) as RawPull);
  return { number: pull.number, url: pull.html_url, branch, round, updated };
}

type Send = (path: string, body?: unknown) => Promise<unknown>;

/** Creates the blobs and the tree for base tree + all files; returns the tree sha. */
async function buildTree(get: Send, post: Send, input: PublishInput): Promise<string> {
  const base = (await get(`/git/commits/${input.baseSha}`)) as RawCommit;
  const listing = (await get(`/git/trees/${base.tree.sha}?recursive=1`)) as { tree: { path: string; mode: string }[] };
  const modes = new Map(listing.tree.map((e) => [e.path, e.mode]));

  const entries: { path: string; mode: string; type: "blob"; sha: string | null }[] = [];
  for (const file of input.files) {
    if ("deleted" in file) {
      if (modes.has(file.path)) entries.push({ path: file.path, mode: "100644", type: "blob", sha: null });
      continue;
    }
    const blob = (await post("/git/blobs", { content: file.content, encoding: "utf-8" })) as { sha: string };
    entries.push({ path: file.path, mode: modes.get(file.path) ?? "100644", type: "blob", sha: blob.sha });
  }
  const created = (await post("/git/trees", { base_tree: base.tree.sha, tree: entries })) as { sha: string };
  return created.sha;
}
