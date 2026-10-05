// The session's view model: reduce(view, frame) folds the event stream into what the UI shows (P3-a).
// Pure and free of React, so a live run and a replay of the stored log give the same items.

import type { AgentEvent, DiffSummary, ErrorSource, PlanStep, QuestionOption, ReviewVerdict, Severity, Status } from "../../../src/core/events";
import { RESTORED_NOTE, type ServerFrame } from "../../../src/session/protocol";
import { parseDiff } from "./diff";
import { isTestPath } from "./format";

export interface StepRow {
  callId: string;
  name: string;
  arg: string;
  output: { stream: "stdout" | "stderr" | "result"; text: string }[];
  exitCode?: number | null;
  done: boolean;
  declined?: boolean;
  error?: string;
  meta?: { bytes?: number; files?: number };
  additions?: number;
  deletions?: number;
  durationMs?: number;
  expanded: boolean;
  startedAt: number;
}

export interface Usage {
  model: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
}

export type TimelineItem =
  | { key: string; kind: "user"; text: string; pending: boolean }
  | { key: string; kind: "assistant"; text: string; streaming: boolean; stepId?: string; usage?: Usage }
  | { key: string; kind: "reasoning"; text: string; streaming: boolean }
  | { key: string; kind: "routed"; task: "daily" | "complex"; model: string; reasoning: string }
  | { key: string; kind: "steps"; rows: StepRow[] }
  | { key: string; kind: "question"; question: string }
  /** What the agent says it did when it asks to finish: its last word in the conversation. */
  | { key: string; kind: "summary"; text: string }
  | { key: string; kind: "notice"; title: string; message: string }
  | { key: string; kind: "failure"; source: ErrorSource; title: string; message: string; next?: string }
  | { key: string; kind: "approved"; finish: boolean }
  | { key: string; kind: "pr"; url: string; number?: number; branch?: string; updated: boolean }
  | { key: string; kind: "review_posted"; url: string; verdict: ReviewVerdict };

export interface GateView {
  approvalId: string;
  tool: string;
  reason: string;
  summary?: string;
  /** finish's pull request title, as the agent wrote it. */
  title?: string;
  diffSummary?: DiffSummary;
  command?: string;
  paths?: string[];
  primary: string;
  secondary: string;
  /** The open call this gate is about, if any. */
  callId?: string;
}

export interface ChangeView {
  path: string;
  additions: number;
  deletions: number;
  diff: string | null;
  saved?: boolean;
  unavailableReason?: string;
}

export interface FindingView {
  id: string;
  path: string;
  line: number;
  severity: Severity;
  text: string;
  inline: boolean;
  dismissed: boolean;
  edited: boolean;
  /** On GitHub already: a later review of this session leaves it out. */
  posted: boolean;
}

export interface SessionView {
  lastSeq: number;
  /** When the last event was written (server clock): a recent one arrived live, an old one is a replay. */
  lastTs: number;
  status: Status | null;
  items: TimelineItem[];
  gate: GateView | null;
  changes: ChangeView[];
  testPaths: string[];
  header: { step: number; contextTokens: number; contextWindow: number; cost: number };
  sending: boolean;
  refused: string | null;
  composerEnabled: boolean;
  lastCommand: { command: string; exitCode: number | null } | null;
  /** Usage by stepId, until the step's assistant message arrives. */
  usageByStep: Record<string, Usage>;
  /** The pull request this session opened, if any. */
  pr: { url: string; number?: number; branch?: string } | null;
  findings: FindingView[];
  posted: { url: string; verdict: ReviewVerdict } | null;
  /** The agent's current plan; each plan_updated replaces it. */
  plan: PlanStep[] | null;
  /** The question the agent is waiting on, until the user answers. */
  question: { id: string; question: string; options: QuestionOption[] } | null;
}

export function initialView(): SessionView {
  return {
    lastSeq: 0,
    lastTs: 0,
    status: null,
    items: [],
    gate: null,
    changes: [],
    testPaths: [],
    header: { step: 0, contextTokens: 0, contextWindow: 0, cost: 0 },
    sending: false,
    refused: null,
    composerEnabled: true,
    lastCommand: null,
    usageByStep: {},
    pr: null,
    findings: [],
    posted: null,
    plan: null,
    question: null,
  };
}

export function addPending(view: SessionView, text: string): SessionView {
  return { ...view, items: [...view.items, { key: `pending:${view.items.length}`, kind: "user", text, pending: true }] };
}

export function markSending(view: SessionView): SessionView {
  return { ...view, sending: true, refused: null };
}

/**
 * On reconnect: unfinished streamed text goes; the persisted message replaces it (P3-k).
 * A frame lost in the drop never gets an answer, so sending ends and unacknowledged bubbles go;
 * one that was delivered comes back through the replay as a message.
 */
export function dropStreaming(view: SessionView): SessionView {
  return { ...view, sending: false, items: view.items.filter((i) => !((i.kind === "assistant" || i.kind === "reasoning") && i.streaming) && !(i.kind === "user" && i.pending)) };
}

export function reduce(view: SessionView, frame: ServerFrame): SessionView {
  if (frame.type === "rejected") return { ...view, sending: false, refused: frame.reason, items: view.items.filter((i) => !(i.kind === "user" && i.pending)) };
  if (frame.seq <= view.lastSeq) return view;
  return { ...apply(withStep(view, frame), frame), lastSeq: frame.seq, lastTs: frame.ts };
}

function withStep(view: SessionView, ev: AgentEvent): SessionView {
  const n = ev.stepId && /^s(\d+)$/.exec(ev.stepId);
  if (!n || Number(n[1]) <= view.header.step) return view;
  return { ...view, header: { ...view.header, step: Number(n[1]) } };
}

// ---- helpers -------------------------------------------------------------

const settle = (row: StepRow): StepRow => ({
  ...row,
  expanded: !row.done || (row.name === "run_command" && row.exitCode !== undefined && row.exitCode !== 0) || row.error !== undefined,
});

function mapRows(items: TimelineItem[], fn: (row: StepRow) => StepRow): TimelineItem[] {
  return items.map((i) => (i.kind === "steps" ? { ...i, rows: i.rows.map(fn) } : i));
}

const allRows = (view: SessionView): StepRow[] => view.items.flatMap((i) => (i.kind === "steps" ? i.rows : []));

const openRow = (view: SessionView): StepRow | undefined => allRows(view).filter((r) => !r.done).at(-1);

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Walks a unified diff: `---`/`+++` is a file header only outside a hunk, where the @@ counts say how many lines remain. */
function scanPatch(patch: string): { paths: string[]; additions: number; deletions: number } {
  const lines = patch.split("\n");
  const paths: string[] = [];
  const clean = (p: string) => p.split("\t")[0]!.replace(/^[ab]\//, "");
  let additions = 0;
  let deletions = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith("-")) {
        deletions++;
        oldLeft--;
      } else if (line.startsWith("+")) {
        additions++;
        newLeft--;
      } else if (!line.startsWith("\\")) {
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
    } else if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      const from = clean(line.slice(4));
      const to = clean(lines[++i]!.slice(4));
      const path = to === "/dev/null" ? from : to;
      if (path !== "/dev/null" && !paths.includes(path)) paths.push(path);
    }
  }
  return { paths, additions, deletions };
}

function newRow(ev: Extract<AgentEvent, { type: "tool_call" }>): StepRow {
  const args = (ev.args && typeof ev.args === "object" ? ev.args : {}) as Record<string, unknown>;
  const row: StepRow = { callId: ev.callId, name: ev.name, arg: ev.summary, output: [], done: false, expanded: true, startedAt: ev.ts };
  if (ev.name === "run_command") row.arg = str(args.command);
  else if (ev.name === "read_file" || ev.name === "write_file") row.arg = str(args.path);
  else if (ev.name === "list_files") row.arg = str(args.path) || ".";
  if (ev.name === "apply_patch") {
    const patch = str(args.patch);
    const { paths, additions, deletions } = scanPatch(patch);
    row.arg = paths.join(", ");
    Object.assign(row, { additions, deletions });
  } else if (ev.name === "write_file") {
    const content = str(args.content);
    row.additions = content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
    row.deletions = 0;
  }
  return row;
}

function gateFor(view: SessionView, ev: Extract<AgentEvent, { type: "approval_required" }>): GateView {
  const gate: GateView = {
    approvalId: ev.approvalId,
    tool: ev.tool,
    reason: ev.reason,
    ...(ev.summary !== undefined && { summary: ev.summary }),
    ...(ev.title !== undefined && { title: ev.title }),
    ...(ev.diffSummary !== undefined && { diffSummary: ev.diffSummary }),
    primary: "Let it continue",
    secondary: "Redirect",
  };
  if (ev.tool === "finish") return { ...gate, primary: "Approve", secondary: "Send" };
  const open = openRow(view);
  if (open?.name === "run_command") return { ...gate, command: open.arg, callId: open.callId, primary: "Run once", secondary: "Don't run" };
  if (open?.name === "apply_patch") return { ...gate, paths: open.arg.split(", ").filter(Boolean), callId: open.callId, primary: "Apply", secondary: "Don't apply" };
  return gate;
}

/** Puts a user bubble in the timeline, resolving a pending one with the same text. */
function withUser(items: TimelineItem[], key: string, text: string): TimelineItem[] {
  const item: TimelineItem = { key, kind: "user", text, pending: false };
  const at = items.findIndex((i) => i.kind === "user" && i.pending && i.text.trim() === text.trim());
  if (at < 0) return [...items, item];
  return items.map((i, n) => (n === at ? item : i));
}

function withChanges(view: SessionView, changes: ChangeView[]): SessionView {
  return { ...view, changes, testPaths: changes.map((c) => c.path).filter(isTestPath) };
}

function fromSummary(changes: ChangeView[], summary: DiffSummary): ChangeView[] {
  const known = changes.filter((c) => c.diff !== null);
  const extra = summary.files
    .filter((f) => !known.some((c) => c.path === f.path))
    .map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions, diff: null }));
  return [...known, ...extra];
}

function failureOf(ev: Extract<AgentEvent, { type: "error" }>): TimelineItem {
  const key = `e:${ev.seq}`;
  if (ev.source === "sandbox" && ev.message.startsWith(RESTORED_NOTE)) {
    return { key, kind: "notice", title: "Your changes are on a fresh checkout", message: ev.message };
  }
  const title = { model: "ai& did not answer", budget: "Limit reached", github: "GitHub error", sandbox: "The sandbox was lost", tool: "" }[ev.source];
  return { key, kind: "failure", source: ev.source, title, message: ev.message, ...(ev.next !== undefined && { next: ev.next }) };
}

// ---- events --------------------------------------------------------------

function apply(view: SessionView, ev: AgentEvent): SessionView {
  switch (ev.type) {
    case "message": {
      if (ev.role === "user") return { ...view, question: null, items: withUser(view.items, `u:${ev.id}`, ev.text) };
      const key = `a:${ev.id}`;
      const usage = (ev.stepId && view.usageByStep[ev.stepId]) || undefined;
      const item: TimelineItem = { key, kind: "assistant", text: ev.text, streaming: false, ...(ev.stepId && { stepId: ev.stepId }), ...(usage && { usage }) };
      const has = view.items.some((i) => i.key === key);
      return { ...view, items: has ? view.items.map((i) => (i.key === key ? item : i)) : [...view.items, item] };
    }
    case "message_delta": {
      const key = `a:${ev.id}`;
      const cur = view.items.find((i) => i.key === key);
      if (!cur) {
        const item: TimelineItem = { key, kind: "assistant", text: ev.text, streaming: true, ...(ev.stepId && { stepId: ev.stepId }) };
        return { ...view, items: [...view.items, item] };
      }
      if (cur.kind !== "assistant" || !cur.streaming) return view;
      return { ...view, items: view.items.map((i) => (i === cur ? { ...cur, text: cur.text + ev.text } : i)) };
    }
    case "reasoning": {
      const item: TimelineItem = { key: `r:${ev.id}`, kind: "reasoning", text: ev.text, streaming: false };
      const has = view.items.some((i) => i.key === item.key);
      return { ...view, items: has ? view.items.map((i) => (i.key === item.key ? item : i)) : [...view.items, item] };
    }
    case "reasoning_delta": {
      const key = `r:${ev.id}`;
      const cur = view.items.find((i) => i.key === key);
      if (!cur) return { ...view, items: [...view.items, { key, kind: "reasoning", text: ev.text, streaming: true }] };
      if (cur.kind !== "reasoning" || !cur.streaming) return view;
      return { ...view, items: view.items.map((i) => (i === cur ? { ...cur, text: cur.text + ev.text } : i)) };
    }
    case "model_routed":
      return { ...view, items: [...view.items, { key: `mr:${ev.seq}`, kind: "routed", task: ev.task, model: ev.model, reasoning: ev.reasoning }] };
    case "usage": {
      const usage: Usage = { model: ev.model, tokensIn: ev.tokens_in, tokensOut: ev.tokens_out, latencyMs: ev.latency_ms };
      const items = view.items.map((i) => (i.kind === "assistant" && ev.stepId && i.stepId === ev.stepId ? { ...i, usage } : i));
      return {
        ...view,
        items,
        usageByStep: ev.stepId ? { ...view.usageByStep, [ev.stepId]: usage } : view.usageByStep,
        header: { ...view.header, contextTokens: ev.context_tokens, contextWindow: ev.context_window, cost: view.header.cost + (ev.cost ?? 0) },
      };
    }
    case "tool_call": {
      if (ev.name === "finish" || ev.name === "update_plan" || ev.name === "ask_user") return view;
      const row = newRow(ev);
      const last = view.items.at(-1);
      const items: TimelineItem[] =
        last?.kind === "steps"
          ? [...view.items.slice(0, -1), { ...last, rows: [...last.rows, row] }]
          : [...view.items, { key: `s:${ev.callId}`, kind: "steps", rows: [row] }];
      return { ...view, items };
    }
    case "question":
      return { ...view, question: { id: ev.id, question: ev.question, options: ev.options }, items: [...view.items, { key: `q:${ev.id}`, kind: "question", question: ev.question }] };
    case "tool_output": {
      const row = allRows(view).find((r) => r.callId === ev.callId);
      if (!row) return view;
      const next: StepRow = { ...row, durationMs: ev.ts - row.startedAt };
      if (ev.stream !== "result") next.output = [...row.output, { stream: ev.stream, text: ev.chunk }];
      else {
        next.done = true;
        if (row.name !== "run_command") next.output = [{ stream: "result", text: ev.chunk }];
        if (ev.exitCode !== undefined) next.exitCode = ev.exitCode;
        if (ev.meta) next.meta = ev.meta;
        if (row.name === "sandbox_setup") next.arg = ev.chunk;
      }
      const lastCommand =
        ev.stream === "result" && row.name === "run_command" && ev.exitCode !== undefined ? { command: row.arg, exitCode: ev.exitCode } : view.lastCommand;
      return { ...view, lastCommand, items: mapRows(view.items, (r) => (r === row ? settle(next) : r)) };
    }
    case "file_changed": {
      const rest = view.changes.filter((c) => c.path !== ev.path || c.diff === null);
      if (ev.diff === "" && ev.saved !== false) return withChanges(view, view.changes.filter((c) => c.path !== ev.path));
      const { additions, deletions } = parseDiff(ev.diff);
      const change: ChangeView = { path: ev.path, additions, deletions, diff: ev.diff, ...(ev.saved !== undefined && { saved: ev.saved }), ...(ev.unavailableReason && { unavailableReason: ev.unavailableReason }) };
      const at = view.changes.findIndex((c) => c.path === ev.path && c.diff !== null);
      if (at >= 0) return withChanges(view, view.changes.map((c, n) => (n === at ? change : c)));
      const withDiff = rest.filter((c) => c.diff !== null);
      return withChanges(view, [...withDiff, change, ...rest.filter((c) => c.diff === null && c.path !== ev.path)]);
    }
    case "approval_required": {
      const next = ev.diffSummary ? withChanges(view, fromSummary(view.changes, ev.diffSummary)) : view;
      const key = `sum:${ev.approvalId}`;
      const text = ev.tool === "finish" ? ev.summary?.trim() : undefined;
      const items = text && !next.items.some((i) => i.key === key) ? [...next.items, { key, kind: "summary" as const, text }] : next.items;
      return { ...next, items, gate: gateFor(view, ev) };
    }
    case "approval_resolved": {
      let items = view.items;
      if (!ev.approved && view.gate?.callId) {
        items = mapRows(items, (r) => (r.callId === view.gate!.callId ? settle({ ...r, done: true, declined: true }) : r));
      }
      if (ev.approved && !ev.auto) {
        // The server opens the pull request before it resolves the approval; the marker reads first.
        const marker: TimelineItem = { key: `ok:${ev.approvalId}`, kind: "approved", finish: view.gate?.tool === "finish" };
        const last = items.at(-1);
        if (last?.kind === "pr") items = [...items.slice(0, -1), marker, last];
        else if (last?.kind !== "review_posted") items = [...items, marker];
      }
      if (!ev.approved && ev.comment) items = withUser(items, `u:r:${ev.approvalId}`, ev.comment);
      return { ...view, items, gate: null, sending: false };
    }
    case "error": {
      if (ev.source === "tool") {
        const row = allRows(view).filter((r) => r.done).at(-1);
        if (!row) return view;
        return { ...view, items: mapRows(view.items, (r) => (r === row ? settle({ ...r, error: ev.message }) : r)) };
      }
      return { ...view, items: [...view.items, failureOf(ev)], ...(ev.source === "github" && { sending: false }) };
    }
    case "pr_opened": {
      const pr = { url: ev.url, ...(ev.number !== undefined && { number: ev.number }), ...(ev.branch !== undefined && { branch: ev.branch }) };
      return { ...view, pr, items: [...view.items, { key: `pr:${ev.seq}`, kind: "pr", ...pr, updated: ev.updated ?? false }] };
    }
    case "review_finding": {
      const finding: FindingView = {
        id: ev.id,
        path: ev.path,
        line: ev.line,
        severity: ev.severity,
        text: ev.text,
        inline: ev.inline ?? true,
        dismissed: ev.dismissed ?? false,
        edited: ev.edited ?? false,
        posted: view.findings.find((f) => f.id === ev.id)?.posted ?? false,
      };
      const has = view.findings.some((f) => f.id === ev.id);
      return { ...view, findings: has ? view.findings.map((f) => (f.id === ev.id ? finding : f)) : [...view.findings, finding] };
    }
    case "review_posted":
      // A review carries every kept finding that is not on GitHub yet.
      return { ...view, posted: { url: ev.url, verdict: ev.verdict }, findings: view.findings.map((f) => (f.dismissed ? f : { ...f, posted: true })), items: [...view.items, { key: `rp:${ev.seq}`, kind: "review_posted", url: ev.url, verdict: ev.verdict }] };
    case "plan_updated":
      return { ...view, plan: ev.plan.length > 0 ? ev.plan : null };
    case "stopped": {
      // Deltas are not persisted, so a half-written reply goes: a replay then shows the same timeline.
      const items = mapRows(
        view.items.filter((i) => !((i.kind === "assistant" || i.kind === "reasoning") && i.streaming)),
        (r) => (r.done ? r : settle({ ...r, done: true })),
      );
      const notice: TimelineItem = { key: `st:${ev.seq}`, kind: "notice", title: "Stopped", message: "Changes so far are kept. Send a message to continue." };
      // The command the stop cut off did not time out.
      return { ...view, items: [...items, notice], lastCommand: view.lastCommand?.exitCode === null ? null : view.lastCommand };
    }
    case "status": {
      const closes = ev.status === "done" || ev.status === "failed" || ev.status === "budget_exceeded";
      const items = closes ? mapRows(view.items, (r) => (r.done ? r : settle({ ...r, done: true }))) : view.items;
      const last = items.at(-1);
      const silent = ev.status === "awaiting_input" && view.question === null && last?.kind !== "assistant" && !last?.key.startsWith("st:");
      const notice: TimelineItem = { key: `n:${ev.seq}`, kind: "notice", title: "The agent stopped without a reply.", message: "Send a message to continue." };
      return { ...view, items: silent ? [...items, notice] : items, status: ev.status, composerEnabled: true };
    }
    default:
      return view;
  }
}
