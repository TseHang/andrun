// One Durable Object per session (ADR D5): it holds the WebSockets (Hibernation API), the session's
// SQLite, and the sandbox container. All behaviour lives in SessionEngine; this class only wires the
// platform into the engine's ports, so anything stored on `this` must be safe to lose on eviction.

import { Files } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";
import { defaultConfig } from "../core/config";
import { OpenAICompatModelClient } from "../core/model";
import { CloudflareSandboxAdapter } from "../sandbox/cloudflare-sandbox";
import type { ContainerLike } from "../sandbox/container";
import { SessionEngine } from "../session/engine";
import type { SqlStore, SqlValue } from "../session/ports";
import type { ServerFrame, SessionSnapshot } from "../session/protocol";
import { WORKSPACE_NAME, type Env } from "./env";
import { fetchTarball } from "./repo";

/** Container idle timeout (ADR D10). */
const INACTIVITY_MS = 15 * 60_000;

export class SessionDO extends DurableObject<Env> {
  private readonly engine: SessionEngine;
  /** Changes whenever this object is constructed again: shows evictions and hibernation in `debug`. */
  private readonly bootId = crypto.randomUUID();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    if (!container) throw new Error("SessionDO has no container binding");
    // The timeout belongs to this object instance; a woken object must set it again.
    // A throw inside blockConcurrencyWhile resets the object, so a failure here (a container that is
    // just stopping, for example) is logged and the object carries on.
    if (container.running) {
      void ctx.blockConcurrencyWhile(async () => {
        try {
          await container.setInactivityTimeout(INACTIVITY_MS);
        } catch (err) {
          console.error("setting the container idle timeout failed:", err);
        }
      });
    }

    const sql: SqlStore = {
      exec: <T>(query: string, ...bindings: SqlValue[]) => ctx.storage.sql.exec(query, ...bindings).toArray() as T[],
    };
    this.engine = new SessionEngine({
      sql,
      sandbox: new CloudflareSandboxAdapter({
        container: container as unknown as ContainerLike,
        files: new Files(container),
        image: () => {
          const image = container.images["sandbox"];
          if (!image) throw new Error(`no "sandbox" image on the container binding (found: ${Object.keys(container.images).join(", ") || "none"})`);
          return image;
        },
        inactivityMs: INACTIVITY_MS,
      }),
      fetchTarball,
      model: new OpenAICompatModelClient({ baseUrl: env.AIAND_BASE_URL, apiKey: env.AIAND_API_KEY }),
      config: defaultConfig,
      repo: { name: env.DEMO_REPO, sha: env.DEMO_SHA },
      broadcast: (frame) => this.broadcast(frame),
      index: { upsert: (row) => env.WORKSPACE.getByName(WORKSPACE_NAME).upsert(row) },
      setAlarm: (at) => void (at === null ? ctx.storage.deleteAlarm() : ctx.storage.setAlarm(at)),
      closeSockets: (code, reason) => {
        for (const ws of ctx.getWebSockets()) ws.close(code, reason);
      },
      deleteAll: () => ctx.storage.deleteAll(),
    });
  }

  private broadcast(frame: ServerFrame): void {
    const data = JSON.stringify(frame);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // a socket that is closing; the client replays from lastSeq when it reconnects
      }
    }
  }

  // ---------- RPC, called by the Worker ----------

  async create(input: { id: string; mode: "code"; task: string }): Promise<void> {
    this.engine.create(input);
    this.ctx.waitUntil(this.engine.idle());
  }

  async snapshot(): Promise<(SessionSnapshot & { debug: { bootId: string; containerRunning: boolean; sockets: number } }) | null> {
    const snapshot = this.engine.snapshot();
    if (!snapshot) return null;
    const debug = { bootId: this.bootId, containerRunning: this.ctx.container?.running ?? false, sockets: this.ctx.getWebSockets().length };
    return { ...snapshot, debug };
  }

  async remove(): Promise<boolean> {
    return this.engine.remove();
  }

  async killSandbox(): Promise<boolean> {
    return this.engine.killSandbox();
  }

  // ---------- WebSocket (Hibernation API) ----------

  /** The upgrade: replay what the client missed, then it receives live frames like every other socket. */
  override async fetch(request: Request): Promise<Response> {
    const lastSeq = Number(new URL(request.url).searchParams.get("lastSeq") ?? "0");
    const missed = this.engine.replay(Number.isFinite(lastSeq) ? lastSeq : 0);
    if (!missed) return Response.json({ error: "not found" }, { status: 404 });

    const { 0: client, 1: server } = new WebSocketPair();
    // No await between the replay query and accepting the socket, so no event can fall in between.
    this.ctx.acceptWebSocket(server);
    for (const event of missed) server.send(JSON.stringify(event));
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.engine.handleFrame(message, (frame) => ws.send(JSON.stringify(frame)));
    this.ctx.waitUntil(this.engine.idle());
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // already closed
    }
  }

  /** The watchdog for runs interrupted by an eviction (P2-f). */
  override async alarm(): Promise<void> {
    await this.engine.alarm();
  }
}
