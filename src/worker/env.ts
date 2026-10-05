// Bindings and variables of the deployed Worker (see wrangler.jsonc).

import type { SessionDO } from "./session-do";
import type { WorkspaceDO } from "./workspace-do";

export interface Env {
  SESSION: DurableObjectNamespace<SessionDO>;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  CREATE_LIMITER: RateLimit;
  DELETE_LIMITER: RateLimit;
  GITHUB_WRITE_LIMITER: RateLimit;
  GITHUB_READ_LIMITER: RateLimit;
  /** Every request this Worker sends to GitHub counts against it, under one shared key. */
  GITHUB_API_LIMITER: RateLimit;
  /** Worker secret (`wrangler secret put`); `.dev.vars` locally. Never passed into the sandbox. */
  AIAND_API_KEY: string;
  AIAND_BASE_URL: string;
  GITHUB_API_URL: string;
  GITHUB_WRITES: string;
  /** Worker secrets (`wrangler secret put`); `.dev.vars` locally. Never passed into the sandbox or to the browser. */
  GITHUB_APP_ID: string;
  GITHUB_APP_INSTALLATION_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_PAT: string;
  DEMO_REPO: string;
  DEMO_SHA: string;
  KILL_SWITCH: string;
  TASK_NETWORK: string;
  DEBUG_ENDPOINTS: string;
}

/** The one WorkspaceDO (ADR D16). */
export const WORKSPACE_NAME = "workspace";

// Populate the platform's typed loopback bindings (`ctx.exports`).
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- augment the platform namespace
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("./index");
      durableNamespaces: "SessionDO" | "WorkspaceDO";
    }
  }
}
