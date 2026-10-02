// Bindings and variables of the deployed Worker (see wrangler.jsonc).

import type { SessionDO } from "./session-do";
import type { WorkspaceDO } from "./workspace-do";

export interface Env {
  SESSION: DurableObjectNamespace<SessionDO>;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  CREATE_LIMITER: RateLimit;
  DELETE_LIMITER: RateLimit;
  /** Worker secret (`wrangler secret put`); `.dev.vars` locally. Never passed into the sandbox. */
  AIAND_API_KEY: string;
  AIAND_BASE_URL: string;
  DEMO_REPO: string;
  DEMO_SHA: string;
  KILL_SWITCH: string;
  DEBUG_ENDPOINTS: string;
}

/** The one WorkspaceDO (ADR D16). */
export const WORKSPACE_NAME = "workspace";
