// Worker entry: static assets are served by the platform; everything else goes through the router.

import { githubFor } from "./github";
import { WORKSPACE_NAME, type Env } from "./env";
import { handle } from "./router";
import type { RouterEnv, SessionStub } from "./types";

export { EgressGate } from "./egress-gate";
export { SessionDO } from "./session-do";
export { WorkspaceDO } from "./workspace-do";

function routerEnv(env: Env): RouterEnv {
  return {
    session: (id) => env.SESSION.getByName(id) as unknown as SessionStub,
    workspace: env.WORKSPACE.getByName(WORKSPACE_NAME),
    createLimiter: env.CREATE_LIMITER,
    deleteLimiter: env.DELETE_LIMITER,
    killSwitch: env.KILL_SWITCH === "1",
    debugEndpoints: env.DEBUG_ENDPOINTS === "1",
    repo: { name: env.DEMO_REPO, sha: env.DEMO_SHA || null },
    github: githubFor(env, "routes"),
    githubWrites: env.GITHUB_WRITES === "1" && env.KILL_SWITCH !== "1",
    githubReadLimiter: env.GITHUB_READ_LIMITER,
    newId: () => crypto.randomUUID(),
  };
}

export default {
  fetch: (request, env) => handle(request, routerEnv(env)),
} satisfies ExportedHandler<Env>;
