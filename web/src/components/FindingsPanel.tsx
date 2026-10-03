import { useState } from "react";
import type { Status } from "../../../src/core/events";
import type { ClientFrame } from "../../../src/session/protocol";
import type { FindingView, SessionView } from "../state/reducer";
import { SEVERITY } from "./PatchView";

const BADGE = "rounded-full bg-fill px-2 py-px text-[11px] text-text-secondary";
const ACTION = "h-7 cursor-pointer rounded-lg px-2.5 font-medium text-text-secondary disabled:cursor-default disabled:opacity-40";

function countText(findings: FindingView[], running: boolean): string {
  if (running) return `${findings.length} so far`;
  const dismissed = findings.filter((f) => f.dismissed).length;
  const kept = findings.length - dismissed;
  return dismissed > 0 ? `${kept} kept, ${dismissed} dismissed` : `${kept} kept`;
}

export function FindingsPanel({ view, status, send, onJump }: { view: SessionView; status: Status; send: (f: ClientFrame) => boolean; onJump: (path: string, line: number) => void }) {
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
  const running = status === "running";
  const editable = status === "awaiting_approval" && !view.posted;
  const findings = view.findings;

  const save = (f: FindingView) => {
    const text = editing?.draft.trim() ?? "";
    if (!text || text === f.text) return;
    if (send({ type: "finding", id: f.id, text })) setEditing(null);
  };

  return (
    <aside aria-label="Findings" className="flex w-[340px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-black/8 p-5">
      <div className="flex items-baseline gap-2">
        <h2 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">Findings</h2>
        {(running || findings.length > 0) && <span className="text-text-secondary">{countText(findings, running)}</span>}
      </div>
      {running && <p className="m-0 text-xs text-text-secondary">You can edit findings when the agent has finished.</p>}
      {!running && findings.length === 0 && <p className="m-0 text-text-secondary">No findings.</p>}
      <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
        {findings.map((f) => {
          const sev = SEVERITY[f.severity];
          const where = `${f.path}:${f.line}`;
          return (
            <li key={f.id} data-finding={f.id} className={`flex flex-col gap-1.5 rounded-xl p-3 shadow-[0_0_0_1px_rgba(0,0,0,0.08)] ${f.dismissed ? "bg-sidebar text-text-tertiary" : ""}`}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className={`text-xs font-semibold ${f.dismissed ? "" : sev.className}`}>{sev.label}</span>
                {f.inline ? (
                  <a
                    href={`#${where}`}
                    onClick={(e) => {
                      e.preventDefault();
                      onJump(f.path, f.line);
                    }}
                    className="min-w-0 truncate font-mono text-xs text-accent-text"
                  >
                    {where}
                  </a>
                ) : (
                  <>
                    <span className="min-w-0 truncate font-mono text-xs text-text-secondary">{where}</span>
                    <span className={BADGE}>In summary</span>
                  </>
                )}
                {f.edited && <span className={BADGE}>Edited</span>}
              </div>
              {editing?.id === f.id ? (
                <>
                  <label htmlFor={`finding-${f.id}`} className="sr-only">
                    Finding text
                  </label>
                  <textarea
                    id={`finding-${f.id}`}
                    rows={4}
                    value={editing.draft}
                    onChange={(e) => setEditing({ id: f.id, draft: e.target.value })}
                    className="w-full resize-y rounded-lg bg-black/5 p-2 text-[13px] leading-5 text-text transition-[background-color,box-shadow] focus:bg-white focus:shadow-[0_0_0_1px_rgba(0,0,0,0.2)]"
                  />
                  <div className="flex gap-1">
                    <button type="button" disabled={!editable || !editing.draft.trim() || editing.draft.trim() === f.text} onClick={() => save(f)} className="h-7 cursor-pointer rounded-lg bg-fill px-3 font-semibold disabled:cursor-default disabled:opacity-40">
                      Save
                    </button>
                    <button type="button" onClick={() => setEditing(null)} className={ACTION}>
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="m-0 break-words whitespace-pre-wrap">{f.text}</p>
                  <div className="flex gap-1">
                    {f.dismissed ? (
                      <button type="button" disabled={!editable} onClick={() => send({ type: "finding", id: f.id, dismissed: false })} className={ACTION}>
                        Restore
                      </button>
                    ) : (
                      <>
                        <button type="button" disabled={!editable} onClick={() => setEditing({ id: f.id, draft: f.text })} className={ACTION}>
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
            </li>
          );
        })}
      </ul>
      {running && <p className="m-0 text-xs text-text-secondary">Still reading. More findings may appear.</p>}
    </aside>
  );
}
