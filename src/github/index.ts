// The GitHub module's entry point: one client for the configured repo. Reads and publishing use the
// App's installation token (the bot, who writes the code); reviews use the user's PAT so they are
// posted as the user (the reviewer).

import { createAppAuth } from "./app-auth";
import { GitHubError, createRequest } from "./client";
import { publish, type PublishInput, type PublishResult } from "./publish";
import { defaultBranchHead, getPull, listPulls, type PullDetail, type PullSummary } from "./pulls";
import { postReview, type ReviewInput } from "./review";

export { GitHubError } from "./client";
export { commentableLines, numberedPatch } from "./diff-lines";
export type { PublishFile, PublishInput, PublishResult } from "./publish";
export type { PullDetail, PullFile, PullSummary } from "./pulls";
export { REVIEW_FOOTER, buildReview } from "./review";
export type { ReviewComment, ReviewFinding, ReviewInput } from "./review";

export interface GitHubConfig {
  apiUrl: string;
  repo: string;
  appId: string;
  installationId: string;
  privateKey: string;
  pat: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface GitHub {
  defaultBranchHead(): Promise<{ branch: string; sha: string }>;
  publish(input: PublishInput): Promise<PublishResult>;
  listPulls(): Promise<PullSummary[]>;
  getPull(n: number): Promise<PullDetail>;
  postReview(input: ReviewInput): Promise<{ url: string }>;
}

export function createGitHub(config: GitHubConfig): GitHub {
  const request = createRequest(config.apiUrl, config.fetch ?? fetch);
  const auth = createAppAuth({
    appId: config.appId,
    installationId: config.installationId,
    privateKey: config.privateKey,
    request,
    now: config.now ?? Date.now,
  });
  const { repo } = config;
  // A token is letters, digits and underscores. A secret pasted with a stray character fails in
  // transit with an error that says nothing about the cause, so it is refused here.
  const userToken = async () => {
    const pat = config.pat.trim();
    if (!/^[A-Za-z0-9_]+$/.test(pat)) throw new GitHubError("GITHUB_PAT is not a valid token: set the secret again", 0);
    return pat;
  };
  return {
    defaultBranchHead: async () => defaultBranchHead(request, repo, await auth.token()),
    publish: async (input) => publish(request, repo, await auth.token(), await auth.botLogin(), input),
    listPulls: async () => listPulls(request, repo, await auth.token(), await auth.botLogin()),
    getPull: async (n) => getPull(request, repo, await auth.token(), n),
    postReview: async (input) => postReview(request, repo, await userToken(), input),
  };
}
