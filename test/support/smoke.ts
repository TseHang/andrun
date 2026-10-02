// Runtime check of a running &run Worker (local `wrangler dev` or the deployed URL).
// Usage: pnpm smoke [baseUrl] [--flow happy|kill] [--task "…"]
//   happy: create → gate → replay check → reject → gate → approve → done → delete (S16)
//   kill:  create → kill the sandbox mid-run → failed → message → rebuilt → gate (S17, spec test D)
// Each flow starts one session, so against a real model it costs one session's tokens.

import type { AgentEvent } from "../../src/core/events";
import type { ServerFrame } from "../../src/session/protocol";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const base = (args[0] && !args[0].startsWith("--") ? args[0] : "http://localhost:8787").replace(/\/+$/, "");
const flow = flag("flow") ?? "happy";
const task = flag("task") ?? "make the failing test pass";
const WAIT_MS = 180_000;

const t0 = Date.now();
const log = (msg: string) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
function check(cond: unknown, what: string): void {
  if (!cond) throw new Error(`FAILED: ${what}`);
  log(`ok: ${what}`);
}

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

class Client {
  readonly frames: ServerFrame[] = [];
  readonly ws: WebSocket;
  closed: number | null = null;
  constructor(id: string, lastSeq = 0) {
    this.ws = new WebSocket(`${base.replace(/^http/, "ws")}/sessions/${id}/ws?lastSeq=${lastSeq}`);
    this.ws.onmessage = (e) => {
      const frame = JSON.parse(String(e.data)) as ServerFrame;
      this.frames.push(frame);
      if (frame.type === "status") log(`status: ${frame.status}`);
      else if (frame.type === "tool_call") log(`step: ${frame.summary}`);
      else if (frame.type === "error") log(`error[${frame.source}]: ${frame.message}`);
      else if (frame.type === "rejected") log(`rejected: ${frame.reason}`);
    };
    this.ws.onclose = (e) => (this.closed = e.code);
  }
  get events(): AgentEvent[] {
    return this.frames.filter((f): f is AgentEvent => f.type !== "rejected" && f.type !== "message_delta");
  }
  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }
  async until(what: string, pred: (frames: ServerFrame[]) => boolean, ms = WAIT_MS): Promise<void> {
    const deadline = Date.now() + ms;
    while (!pred(this.frames)) {
      if (Date.now() > deadline) throw new Error(`FAILED: timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  /** Waits for the n-th `status` event with this value. */
  status(status: string, nth = 1): Promise<void> {
    return this.until(`status ${status} #${nth}`, (f) => f.filter((e) => e.type === "status" && e.status === status).length >= nth);
  }
  lastStatus(): string | undefined {
    return this.events.flatMap((e) => (e.type === "status" ? [e.status] : [])).at(-1);
  }
  pendingApproval(): string {
    const resolved = new Set(this.events.flatMap((e) => (e.type === "approval_resolved" ? [e.approvalId] : [])));
    const open = this.events.flatMap((e) => (e.type === "approval_required" && !resolved.has(e.approvalId) ? [e.approvalId] : []));
    if (open.length !== 1) throw new Error(`FAILED: expected one open approval, found ${open.length}`);
    return open[0]!;
  }
}

async function create(): Promise<{ id: string; client: Client }> {
  const created = await api("POST", "/sessions", { mode: "code", task, repo: "evil/repo" });
  check(created.status === 201 && typeof created.body?.["id"] === "string", "POST /sessions → 201 with an id");
  const id = created.body!["id"] as string;
  log(`session ${id}`);
  const client = new Client(id);
  await client.until("the sandbox step", (f) => f.some((e) => e.type === "tool_call" && e.name === "sandbox_setup"), 10_000);
  log("ok: 'Starting sandbox…' step is visible");
  return { id, client };
}

async function happy(): Promise<void> {
  check((await api("POST", "/sessions", { mode: "review", task: "x" })).status === 400, "invalid body → 400");
  const { id, client } = await create();

  await client.status("awaiting_approval");
  const ready = client.events.find((e) => e.type === "tool_output" && e.stream === "result" && e.chunk.startsWith("ready in"));
  log(`sandbox: ${ready && ready.type === "tool_output" ? ready.chunk : "?"}`);
  check(client.frames.some((f) => f.type === "message_delta"), "assistant text streamed as message_delta");
  check(client.events.some((e) => e.type === "file_changed"), "a file_changed event carried the diff");
  const gate = client.events.find((e) => e.type === "approval_required");
  log(`gate: ${JSON.stringify(gate && gate.type === "approval_required" ? { summary: gate.summary, diff: gate.diffSummary } : null)}`);

  // A page refresh: a new socket replays the persisted history; one that is up to date gets nothing.
  const seen = client.events;
  const refreshed = new Client(id, 0);
  await refreshed.until("the replay", (f) => f.length >= seen.length, 10_000);
  check(JSON.stringify(refreshed.events) === JSON.stringify(seen), `replay from lastSeq=0 equals the live history (${seen.length} events)`);
  check(!refreshed.frames.some((f) => f.type === "message_delta"), "the replay has no message_delta");
  const mid = seen[Math.floor(seen.length / 2)]!.seq;
  const partial = new Client(id, mid);
  await partial.until("the partial replay", (f) => f.length >= seen.filter((e) => e.seq > mid).length, 10_000);
  check(partial.events.every((e) => e.seq > mid), `replay from lastSeq=${mid} has only later events`);
  partial.ws.close();

  const snapshot = await api("GET", `/sessions/${id}`);
  check(snapshot.body?.["status"] === "awaiting_approval" && snapshot.body["pending"] !== null, "GET /sessions/:id shows the pending approval");
  log(`debug: ${JSON.stringify(snapshot.body?.["debug"])}`);

  client.send({ type: "approve", approvalId: "stale" });
  await client.until("the refusal", (f) => f.some((e) => e.type === "rejected"), 10_000);
  log("ok: a stale approval id is refused");

  client.send({ type: "reject", approvalId: client.pendingApproval(), comment: "also add a test for the empty array case" });
  await client.status("awaiting_approval", 2);
  check(true, "reject + comment loops back to the gate");

  client.send({ type: "approve", approvalId: client.pendingApproval() });
  await client.status("done");
  await refreshed.status("done"); // the second tab saw it too
  check(true, "approve → done, on both sockets");

  const list = await fetch(`${base}/sessions`).then((r) => r.json() as Promise<{ id: string; status: string }[]>);
  check(list.find((s) => s.id === id)?.status === "done", "GET /sessions lists the session as done");
  // The container is destroyed right after `done` is broadcast, so give it a moment.
  let running = true;
  for (let i = 0; i < 40 && running; i++) {
    const after = await api("GET", `/sessions/${id}`);
    running = (after.body?.["debug"] as { containerRunning?: boolean } | undefined)?.containerRunning !== false;
    if (running) await new Promise((r) => setTimeout(r, 250));
  }
  check(!running, "the container is destroyed after done");

  check((await api("DELETE", `/sessions/${id}`)).status === 204, "DELETE → 204");
  check((await api("GET", `/sessions/${id}`)).status === 404, "GET after delete → 404");
  await client.until("the socket to close", () => client.closed !== null, 10_000);
  check(client.closed === 1000, "the socket was closed with 1000");
  refreshed.ws.close();
}

async function kill(): Promise<void> {
  const { id, client } = await create();
  await client.until("the first command", (f) => f.some((e) => e.type === "tool_call" && e.name === "run_command"));
  const killedAt = Date.now();
  const res = await api("POST", `/sessions/${id}/debug/kill-sandbox`);
  check(res.status === 200, "kill-sandbox → 200");
  await client.status("failed", 1);
  const took = Date.now() - killedAt;
  check(took < 15_000, `failed ${took} ms after the kill`);
  check(client.events.some((e) => e.type === "error" && e.source === "sandbox"), "error{source:sandbox} is visible");
  const list = await fetch(`${base}/sessions`).then((r) => r.json() as Promise<{ id: string; status: string }[]>);
  check(list.find((s) => s.id === id)?.status === "failed", "GET /sessions lists the session as failed");

  client.send({ type: "message", text: "please continue" });
  await client.status("awaiting_approval");
  check(client.events.filter((e) => e.type === "tool_call" && e.name === "sandbox_setup").length === 2, "the sandbox was rebuilt for the new turn");
  check((await api("DELETE", `/sessions/${id}`)).status === 204, "DELETE → 204");
}

(flow === "kill" ? kill() : happy())
  .then(() => {
    log("ALL CHECKS PASSED");
    process.exit(0);
  })
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
