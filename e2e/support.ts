// Helpers for the E2E specs: they run against `wrangler dev` + the fake model (playwright.config.ts).

import { expect, type APIRequestContext, type Page } from "@playwright/test";
import type { AgentEvent } from "../src/core/events";
import type { SessionSnapshot } from "../src/session/protocol";

export const BASE = "http://localhost:8787";
export const TASK = "make the failing test pass";

/** Each API-created session comes from its own address, so the create limit (5 a minute per IP) is not hit. */
const ip = () => `198.51.100.${Math.floor(Math.random() * 250) + 1}`;

export async function createSession(request: APIRequestContext, task: string, model?: string): Promise<string> {
  const res = await request.post(`${BASE}/sessions`, {
    data: { mode: "code", task, ...(model && { model }) },
    headers: { "cf-connecting-ip": ip() },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

export async function snapshot(request: APIRequestContext, id: string): Promise<SessionSnapshot> {
  return (await (await request.get(`${BASE}/sessions/${id}`)).json()) as SessionSnapshot;
}

export async function waitForStatus(request: APIRequestContext, id: string, status: string, ms = 120_000): Promise<SessionSnapshot> {
  const deadline = Date.now() + ms;
  for (;;) {
    const s = await snapshot(request, id);
    if (s.status === status) return s;
    if (Date.now() > deadline) throw new Error(`session ${id} is ${s.status}, not ${status}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Sends one client frame over a fresh socket, the way another tab would. */
export async function sendFrame(id: string, frame: unknown): Promise<void> {
  const ws = new WebSocket(`${BASE.replace("http", "ws")}/sessions/${id}/ws?lastSeq=999999`);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("socket error"));
  });
  ws.send(JSON.stringify(frame));
  await new Promise((r) => setTimeout(r, 300));
  ws.close();
}

/** The whole persisted log, as a reload would replay it. */
export async function replay(id: string): Promise<AgentEvent[]> {
  const ws = new WebSocket(`${BASE.replace("http", "ws")}/sessions/${id}/ws?lastSeq=0`);
  const events: AgentEvent[] = [];
  ws.onmessage = (e) => events.push(JSON.parse(String(e.data)) as AgentEvent);
  await new Promise((r) => setTimeout(r, 1500));
  ws.close();
  return events;
}

/**
 * The fake GitHub numbers pull requests from 12 again after a reset, so sessions left by earlier tests
 * would be linked to the new pull requests. The GitHub specs start from an empty session list.
 */
export async function deleteAllSessions(request: APIRequestContext): Promise<void> {
  const rows = (await (await request.get(`${BASE}/sessions`)).json()) as { id: string }[];
  for (const row of rows) await deleteSession(request, row.id);
}

export async function deleteSession(request: APIRequestContext, id: string): Promise<void> {
  await request.delete(`${BASE}/sessions/${id}`, { headers: { "cf-connecting-ip": ip() } });
}

// ---------- The fake GitHub (`pnpm fake-github`, test/support/fake-github.ts) ----------

const GH = "http://localhost:8789";
const ghPost = async (path: string, body: unknown = {}) =>
  (await fetch(`${GH}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

export interface GitHubState {
  refs: Record<string, string>;
  pulls: { number: number; title: string; body: string; user: string; headRef: string; baseRef: string; state: string }[];
  reviews: { pull: number; user: string; commit_id: string; event: string; body: string; comments: { path: string; line: number; side: string; body: string }[] }[];
  comments: { id: number; pull: number; user: string; path: string; line: number; body: string; in_reply_to_id?: number }[];
  writes: string[];
  authors: Record<string, string>;
}

export const gh = {
  reset: () => ghPost("/__reset"),
  state: async () => (await (await fetch(`${GH}/__state`)).json()) as GitHubState,
  /** The next `times` requests whose path matches get this status. */
  fail: (f: { method?: string; path: string; status: number; body?: unknown; times?: number }) => ghPost("/__fail", f),
  addPull: (p: Record<string, unknown>) => ghPost("/__pull", p) as Promise<{ number: number; headSha: string }>,
};

export const SLUGIFY_PATCH = ["@@ -0,0 +1,6 @@", "+export function slugify(text) {", "+  return text", "+    .toLowerCase()", '+    .replace(/ /g, "-")', '+    .replace(/[^a-z0-9-]/g, "");', "+}"].join("\n");

/** Pull request #14 by the bot, with the planted bug of spec test E on line 4 of src/slugify.js. */
export const seedReviewPull = () =>
  gh.addPull({
    number: 14,
    title: "Add slugify helper",
    body: "## Why\n\nWe need **slugs** for the URLs.",
    headRef: "agent/1a2b3c4d-1",
    files: [
      { filename: "src/slugify.js", status: "added", additions: 6, deletions: 0, patch: SLUGIFY_PATCH },
      { filename: "logo.png", status: "added", additions: 0, deletions: 0 },
    ],
  });

// ---------- The screen (selectors shared by the specs) ----------

export const ui = (page: Page) => ({
  sidebar: page.getByRole("navigation", { name: "Workspace" }),
  status: page.getByTestId("session-status"),
  timeline: page.getByRole("region", { name: "Timeline" }),
  changes: page.getByRole("complementary", { name: "Changes" }),
  approval: page.getByRole("form", { name: "Approval" }),
  composer: page.getByRole("form", { name: "Message the agent" }),
  sandbox: page.getByTestId("sandbox-state"),
  prCard: page.getByTestId("pr-card"),
  reviewCard: page.getByTestId("review-card"),
  findings: page.getByRole("region", { name: "Findings" }),
  files: page.getByRole("complementary", { name: "Files changed" }),
  overview: page.getByRole("region", { name: "Pull request" }),
  startCard: page.getByRole("region", { name: "&run review" }),
  postBar: page.getByRole("form", { name: "Post review" }),
  prRow: (n: number) => page.locator(`[data-pr="${n}"]`),
  rows: (name?: string) => page.locator(name ? `[data-step-name="${name}"]` : "[data-step-name]"),
});

/** Records every text the session status shows, and whether some texts ever appeared, from now on. */
export async function watch(page: Page, texts: string[]): Promise<() => Promise<string[]>> {
  await page.evaluate((watched) => {
    const w = window as unknown as { __seen: Set<string> };
    w.__seen = new Set();
    const look = () => {
      const s = document.querySelector("[data-testid=session-status]")?.textContent?.trim();
      if (s) w.__seen.add(`status:${s}`);
      const body = document.body.innerText;
      for (const t of watched) if (body.includes(t)) w.__seen.add(t);
    };
    look();
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  }, texts);
  return () => page.evaluate(() => [...(window as unknown as { __seen: Set<string> }).__seen]);
}
