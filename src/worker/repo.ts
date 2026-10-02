// Repo download (ADR D10): the Worker fetches the tarball at a pinned commit and streams it into the
// sandbox, so the sandbox needs no network and no token. The demo repo is public (P2-h).

const REPO = /^[\w.-]+\/[\w.-]+$/;
const SHA = /^[0-9a-f]{40}$/;

export async function fetchTarball(repo: string, sha: string): Promise<ReadableStream<Uint8Array>> {
  if (!REPO.test(repo) || !SHA.test(sha)) throw new Error(`invalid repository reference: ${repo}@${sha}`);
  const res = await fetch(`https://codeload.github.com/${repo}/tar.gz/${sha}`);
  if (!res.ok || !res.body) throw new Error(`could not download ${repo}@${sha.slice(0, 7)}: HTTP ${res.status}`);
  return res.body as ReadableStream<Uint8Array>;
}
