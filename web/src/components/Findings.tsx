import { useState, type ReactNode } from "react";
import type { Status } from "../../../src/core/events";
import type { ClientFrame } from "../../../src/session/protocol";
import { firstLine, severityLabel } from "../state/format";
import type { FindingView, SessionView } from "../state/reducer";
import { Chevron } from "./Chevron";
import { isLive } from "./Enter";
import { FindingHeader, SEVERITY } from "./PatchView";

const BADGE = "rounded-full bg-fill px-2 py-px text-[11px] text-text-secondary";
const ACTION = "press h-7 cursor-pointer rounded-lg px-2.5 font-medium text-text-secondary disabled:cursor-default disabled:opacity-40";

function countText(findings: FindingView[], running: boolean): string {
  if (running) return `${findings.length} so far`;
  const dismissed = findings.filter((f) => f.dismissed).length;
  const kept = findings.length - dismissed;
  return dismissed > 0 ? `${kept} kept, ${dismissed} dismissed` : `${kept} kept`;
}

/**
 * One finding as a post from &run: its text, and Edit, Dismiss or Restore while the review waits at its gate. A posted finding is fixed.
 * The same post sits in the diff under its line and in the Findings list; both read the session's state, so they stay in step.
 */
export function FindingPost({ f, status, send, location }: { f: FindingView; status: Status; send: (f: ClientFrame) => boolean; location?: ReactNode }) {
  const [draft, setDraft] = useState<string | null>(null);
  const editable = status === "awaiting_approval" && !f.posted;

  const save = () => {
    const text = draft?.trim() ?? "";
    if (!text || text === f.text) return;
    if (send({ type: "finding", id: f.id, text })) setDraft(null);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <FindingHeader severity={f.severity} muted={f.dismissed} />
        {location}
        {f.edited && <span className={BADGE}>Edited</span>}
        {f.posted && <span className={BADGE}>Posted</span>}
      </div>
      {draft !== null ? (
        <>
          <label htmlFor={`finding-${f.id}`} className="sr-only">
            Finding text
          </label>
          <textarea
            id={`finding-${f.id}`}
            rows={4}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="w-full resize-y rounded-lg bg-black/5 p-2 text-[13px] leading-5 text-text transition-[background-color,box-shadow] focus:bg-white focus:shadow-[0_0_0_1px_rgba(0,0,0,0.2)]"
          />
          <div className="flex gap-1">
            <button type="button" disabled={!editable || !draft.trim() || draft.trim() === f.text} onClick={save} className="h-7 cursor-pointer rounded-lg bg-fill px-3 font-semibold disabled:cursor-default disabled:opacity-40">
              Save
            </button>
            <button type="button" onClick={() => setDraft(null)} className={ACTION}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <p className={`m-0 break-words whitespace-pre-wrap ${f.dismissed ? "text-text-tertiary line-through" : ""}`}>{f.text}</p>
          <div className="flex gap-1">
            {f.dismissed ? (
              <button type="button" disabled={!editable} onClick={() => send({ type: "finding", id: f.id, dismissed: false })} className={ACTION}>
                Restore
              </button>
            ) : (
              <>
                <button type="button" disabled={!editable} onClick={() => setDraft(f.text)} className={ACTION}>
                  Edit
                </button>
                <button type="button" disabled={!editable} onClick={() => send({ type: "finding", id: f.id, dismissed: true })} className={ACTION}>
                  Dismiss
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The review's findings, beside the conversation. A finding on a changed line lives in the diff, under that line; here it folds to one line
 * that opens it or jumps to it. A finding that goes into the review's summary has no line, so it is shown in full.
 */
export function Findings({ view, status, send, onJump }: { view: SessionView; status: Status; send: (f: ClientFrame) => boolean; onJump: (path: string, line: number) => void }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const running = status === "running";
  const findings = view.findings;
  const live = isLive(view);
  const toggle = (id: string) => setOpen((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));

  return (
    <section aria-label="Findings" className="mt-6 flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <h2 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">Findings</h2>
        {(running || findings.length > 0) && <span className="text-text-secondary">{countText(findings, running)}</span>}
      </div>
      {running && <p className="m-0 text-xs text-text-secondary">You can edit findings when the agent has finished.</p>}
      {!running && findings.length === 0 && <p className="m-0 text-text-secondary">No findings.</p>}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {findings.map((f) => {
          const where = `${f.path}:${f.line}`;
          const jump = (
            <a
              href={`#${where}`}
              onClick={(e) => {
                e.preventDefault();
                onJump(f.path, f.line);
              }}
              className="min-w-0 shrink truncate font-mono text-xs text-accent-text"
            >
              {where}
            </a>
          );
          const card = `rounded-2xl shadow-[0_0_0_1px_rgba(0,0,0,0.08)] ${f.dismissed ? "bg-sidebar text-text-tertiary" : ""}`;
          if (!f.inline)
            return (
              <Finding key={f.id} id={f.id} live={live} className={`${card} p-3.5`}>
                <FindingPost
                  f={f}
                  status={status}
                  send={send}
                  location={
                    <>
                      <span className="min-w-0 truncate font-mono text-xs text-text-secondary">{where}</span>
                      <span className={BADGE}>In summary</span>
                    </>
                  }
                />
              </Finding>
            );
          const expanded = open.has(f.id);
          return (
            <Finding key={f.id} id={f.id} live={live} className={card}>
              <div className="flex items-center gap-2 pr-3.5">
                <button type="button" aria-expanded={expanded} onClick={() => toggle(f.id)} className="flex min-w-0 grow cursor-pointer items-center gap-2 py-2.5 pl-3 text-left">
                  <Chevron open={expanded} />
                  <span className={`shrink-0 text-xs font-semibold ${f.dismissed ? "" : SEVERITY[f.severity]}`}>{severityLabel(f.severity).split(" · ")[0]}</span>
                  <span className={`min-w-0 grow truncate ${f.dismissed ? "line-through" : ""}`}>{firstLine(f.text)}</span>
                  {!expanded && f.edited && <span className={BADGE}>Edited</span>}
                  {!expanded && f.posted && <span className={BADGE}>Posted</span>}
                </button>
                {jump}
              </div>
              {expanded && (
                <div className="px-3.5 pb-3.5">
                  <FindingPost f={f} status={status} send={send} />
                </div>
              )}
            </Finding>
          );
        })}
      </ul>
      {running && <p className="m-0 text-xs text-text-secondary">Still reading. More findings may appear.</p>}
    </section>
  );
}

/** One finding in the list. A finding that arrives while the review runs rises in; the stored ones on load do not. */
function Finding({ id, live, className, children }: { id: string; live: boolean; className: string; children: ReactNode }) {
  const [play] = useState(live);
  return (
    <li data-finding={id} className={`${play ? "enter " : ""}${className}`}>
      {children}
    </li>
  );
}
