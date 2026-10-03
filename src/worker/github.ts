// The GitHub client of this Worker isolate (one per isolate, so the installation token is cached
// across requests) with a budget on outgoing GitHub requests. There is no login, so the per-IP
// limits alone would let several addresses use up the App's hourly GitHub quota (ADR D14).

import { createGitHub, type GitHub } from "../github";
import type { Env } from "./env";

const clients = new Map<string, GitHub>();

/**
 * `scope` names the budget: the public routes and the sessions each have their own, so requests to
 * the list cannot use up what approving a pull request or posting a review needs.
 */
export function githubFor(env: Env, scope: "routes" | "sessions"): GitHub {
  const existing = clients.get(scope);
  if (existing) return existing;
  const client = createGitHub({
    apiUrl: env.GITHUB_API_URL,
    repo: env.DEMO_REPO,
    appId: env.GITHUB_APP_ID,
    installationId: env.GITHUB_APP_INSTALLATION_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    pat: env.GITHUB_PAT,
    fetch: async (input, init) => {
      // One key per scope: the budget is for the whole Worker, not per visitor.
      const { success } = await env.GITHUB_API_LIMITER.limit({ key: scope });
      if (!success) return Response.json({ message: "&run has used its GitHub request budget for this minute. Try again shortly." }, { status: 429 });
      return fetch(input, init);
    },
  });
  clients.set(scope, client);
  return client;
}
