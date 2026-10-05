import { WorkerEntrypoint } from "cloudflare:workers";
import { proxyEgress, type EgressOptions } from "../sandbox/egress";
import type { Env } from "./env";

export class EgressGate extends WorkerEntrypoint<Env, EgressOptions> {
  override fetch(request: Request): Promise<Response> {
    return proxyEgress(request, { ...this.ctx.props, enabled: this.env.TASK_NETWORK !== "0", killSwitch: this.env.KILL_SWITCH === "1" });
  }
}
