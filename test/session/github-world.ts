// Shared setup for the Phase 4 engine tests: a SessionEngine over node:sqlite, the fake container,
// a scripted model and the real GitHub client talking to the fake GitHub.

import { join } from "node:path";
import { defaultConfig } from "../../src/core/config";
import type { AgentEvent } from "../../src/core/events";
import { createGitHub, type PullFile } from "../../src/github";
import { CloudflareSandboxAdapter } from "../../src/sandbox/cloudflare-sandbox";
import { SessionEngine } from "../../src/session/engine";
import type { EngineDeps } from "../../src/session/ports";
import type { ServerFrame, SessionSummary } from "../../src/session/protocol";
import { SessionStore } from "../../src/session/store";
import { FakeContainer } from "../support/fake-container";
import { FAKE_PAT, FAKE_REPO, createFakeGitHub, testKeys } from "../support/fake-github";
import { nodeSql } from "../support/node-sql";
import { ScriptedModelClient, call, type ScriptStep } from "../support/scripted-model";
import { fixtureTarball, streamOf } from "../support/tarball";

export const SUM_FIXTURE = join(import.meta.dirname, "../../eval/fixtures/sum-off-by-one");
export const SLUGIFY_FIXTURE = join(import.meta.dirname, "../../eval/fixtures/slugify");
export const ID = "5b0e7a52-4a2f-4f0a-9d1c-0c3f1a2b3c4d";
export const BRANCH = "agent/5b0e7a52-1";
export const TASK = "make the failing test pass";
export const BRIEF = "Review this pull request.\n\n1. Correctness.\n2. Tests.";
export const IP = "203.0.113.7";

export const FIX_PATCH = [
  "--- a/src/sum.js",
  "+++ b/src/sum.js",
  "@@ -1,6 +1,6 @@",
  " export function sum(values) {",
  "   let total = 0;",
  "-  for (let i = 0; i < values.length - 1; i++) {",
  "+  for (let i = 0; i < values.length; i++) {",
  "     total += values[i];",
  "   }",
  "   return total;",
  "",
].join("\n");

export const HAPPY = (): ScriptStep[] => [
  call("apply_patch", { patch: FIX_PATCH }),
  call("run_command", { command: "npm test" }),
  call("finish", { summary: "Fixed the loop bound in sum(): it skipped the last element.", title: "Fix the loop bound in sum()" }),
];

/** The pull request under review: it adds the slugify fixture's `src/slugify.js` (3 lines). */
export const SLUGIFY_PATCH = [
  "@@ -0,0 +1,3 @@",
  "+export function slugify(title) {",
  '+  return title.toLowerCase().trim().replace(/[^a-z0-9]/g, "-");',
  "+}",
].join("\n");
export const PR_FILES: PullFile[] = [{ path: "src/slugify.js", status: "added", additions: 3, deletions: 0, patch: SLUGIFY_PATCH }];

export const containers: FakeContainer[] = [];

export function world(opts: { tarball?: Uint8Array; guard?: () => string | null } = {}) {
  const db = nodeSql();
  const container = new FakeContainer();
  containers.push(container);
  const fake = createFakeGitHub({ files: { "README.md": "# demo\n", "src/sum.js": "old\n" } });
  const github = createGitHub({
    apiUrl: "https://api.github.test",
    repo: FAKE_REPO,
    appId: "12345",
    installationId: "678",
    privateKey: testKeys().privateKey,
    pat: FAKE_PAT,
    fetch: fake.fetch,
  });
  const frames: ServerFrame[] = [];
  const upserts: SessionSummary[] = [];
  const tarballRequests: { repo: string; sha: string }[] = [];
  const guarded: string[] = [];
  const tarball = opts.tarball ?? fixtureTarball(SUM_FIXTURE);

  const engine = (model: ScriptedModelClient, over: Partial<EngineDeps> = {}) =>
    new SessionEngine({
      sql: db.sql,
      sandbox: new CloudflareSandboxAdapter({ container, files: container.files, workdir: container.workdir, tmpDir: container.tmpDir }),
      fetchTarball: async (repo, sha) => {
        tarballRequests.push({ repo, sha });
        return streamOf(tarball);
      },
      model,
      config: defaultConfig,
      repo: { name: FAKE_REPO, sha: fake.refs.get("main")! },
      github,
      guard: {
        githubWrite: async (ip) => {
          guarded.push(ip);
          return opts.guard?.() ?? null;
        },
      },
      broadcast: (frame) => frames.push(frame),
      index: {
        upsert: async (row) => {
          upserts.push(row);
        },
      },
      setAlarm: () => {},
      closeSockets: () => {},
      deleteAll: () => db.deleteAll(),
      ...over,
    });

  const store = () => new SessionStore(db.sql);
  const events = (): AgentEvent[] => store().eventsAfter(0);
  return { db, container, fake, github, frames, upserts, tarballRequests, guarded, engine, store, events };
}

export type World = ReturnType<typeof world>;

/** Sends one client frame from `IP` and waits for the run it may have started. */
export async function send(engine: SessionEngine, frame: Record<string, unknown>): Promise<ServerFrame[]> {
  const replies: ServerFrame[] = [];
  engine.handleFrame(JSON.stringify(frame), (r) => replies.push(r), { ip: IP });
  await engine.idle();
  return replies;
}

/** A Code session that ran `script` and waits at the finish gate. */
export async function codeAtGate(script: ScriptStep[] = HAPPY(), opts: Parameters<typeof world>[0] = {}, extra: ScriptStep[] = []) {
  const w = world(opts);
  const model = new ScriptedModelClient([...script, ...extra]);
  const engine = w.engine(model);
  engine.create({ id: ID, mode: "code", task: TASK, sha: w.fake.refs.get("main")!, baseBranch: "main" });
  await engine.idle();
  const pending = engine.snapshot()?.pending;
  if (!pending) throw new Error(`expected a pending approval, got ${JSON.stringify(engine.snapshot())}`);
  return { ...w, model, engine, approvalId: pending.approvalId };
}

export const REVIEW_SCRIPT = (): ScriptStep[] => [
  call("read_file", { path: "src/slugify.js" }),
  call("report_finding", { path: "src/slugify.js", line: 2, severity: "high", text: "Repeated separators are not collapsed." }),
  call("report_finding", { path: "src/slugify.js", line: 3, severity: "low", text: "No newline handling." }),
  call("report_finding", { path: "README.md", line: 3, severity: "medium", text: "The README does not mention slugify." }),
  call("report_finding", { path: "src/slugify.js", line: 1, severity: "low", text: "Consider a default export." }),
  call("run_command", { command: "rm -rf src" }),
  call("finish", { summary: "Four findings; the main one is repeated separators." }),
];

/** A Review session on pull request #14 (by the bot unless `author` says otherwise), waiting at "Ready to post". */
export async function reviewAtGate(opts: { script?: ScriptStep[]; extra?: ScriptStep[]; author?: string; files?: PullFile[]; guard?: () => string | null } = {}) {
  const w = world({ tarball: fixtureTarball(SLUGIFY_FIXTURE), guard: opts.guard });
  const files = opts.files ?? PR_FILES;
  const pull = w.fake.addPull({
    number: 14,
    title: "Add slugify helper",
    headRef: "agent/1a2b3c4d-1",
    ...(opts.author && { user: opts.author }),
    files: files.map((f) => ({ filename: f.path, status: "added", additions: f.additions, deletions: f.deletions, ...(f.patch !== null && { patch: f.patch }) })),
  });
  const model = new ScriptedModelClient([...(opts.script ?? REVIEW_SCRIPT()), ...(opts.extra ?? [])]);
  const engine = w.engine(model);
  engine.create({ id: ID, mode: "review", task: BRIEF, sha: pull.headSha, pr: { number: 14, title: pull.title, files } });
  await engine.idle();
  const pending = engine.snapshot()?.pending;
  if (!pending) throw new Error(`expected a pending approval, got ${JSON.stringify(engine.snapshot())}`);
  return { ...w, pull, model, engine, approvalId: pending.approvalId };
}

export const ofType = <T extends AgentEvent["type"]>(events: AgentEvent[], type: T) =>
  events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);

/** The findings as a client that replayed every event would hold them: the last event per id, in first-seen order. */
export function findings(events: AgentEvent[]) {
  const byId = new Map<string, Extract<AgentEvent, { type: "review_finding" }>>();
  for (const e of ofType(events, "review_finding")) byId.set(e.id, e);
  return [...byId.values()];
}
