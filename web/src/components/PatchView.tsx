import type { Severity } from "../../../src/core/events";
import type { PullFile } from "../api";
import { parseDiff } from "../state/diff";
import type { FindingView } from "../state/reducer";

const KIND = {
  add: "bg-diff-add-bg text-diff-add-text",
  del: "bg-diff-del-bg text-diff-del-text",
  context: "",
  hunk: "bg-sidebar text-text-secondary",
};
const SIGN = { add: "+", del: "−", context: " ", hunk: "" };

export const SEVERITY: Record<Severity, { label: string; className: string }> = {
  high: { label: "High", className: "text-failed" },
  medium: { label: "Medium", className: "text-warning-text" },
  low: { label: "Low", className: "text-text-secondary" },
};

/** One file of a pull request: GitHub's hunks, and a note under each new-side line a kept finding sits on. */
export function FileDiff({ file, findings = [] }: { file: PullFile; findings?: FindingView[] }) {
  const parsed = file.patch === null ? null : parseDiff(file.patch);
  const notes = findings.filter((f) => f.path === file.path && f.inline && !f.dismissed);
  return (
    <div className="shrink-0 overflow-hidden rounded-xl shadow-[0_0_0_1px_rgba(0,0,0,0.08)]">
      <div className="flex h-9 items-center gap-3 bg-sidebar px-3.5 font-mono text-xs">
        <span className="min-w-0 grow truncate">{file.path}</span>
        <span className="shrink-0 text-text-secondary">{file.status}</span>
        <span className="shrink-0 text-diff-add-text">+{file.additions}</span>
        <span className="shrink-0 text-diff-del-text">−{file.deletions}</span>
      </div>
      {parsed ? (
        <div className="overflow-x-auto py-1.5 font-mono text-[11.5px] leading-[1.6]">
          <div className="min-w-max">
            {parsed.lines.map((l, i) => {
              const here = l.newNo === null ? [] : notes.filter((f) => f.line === l.newNo);
              return (
                <div key={i} data-diff={l.kind} {...(l.newNo !== null && { "data-line": `${file.path}:${l.newNo}` })} className={KIND[l.kind]}>
                  <div className="flex whitespace-pre">
                    <span className="w-8 shrink-0 pr-1 text-right text-text-tertiary select-none">{l.oldNo ?? ""}</span>
                    <span className="w-8 shrink-0 pr-1 text-right text-text-tertiary select-none">{l.newNo ?? ""}</span>
                    <span className="w-4 shrink-0 text-center select-none">{SIGN[l.kind]}</span>
                    <span>{l.text}</span>
                  </div>
                  {here.map((f) => (
                    <div key={f.id} className="mx-3.5 my-2 ml-16 flex flex-col gap-0.5 rounded-lg bg-white px-3 py-2 font-sans text-[13px] leading-snug whitespace-normal text-text shadow-[0_0_0_1px_rgba(0,0,0,0.08)]">
                      <span className={`text-xs font-semibold ${SEVERITY[f.severity].className}`}>{SEVERITY[f.severity].label}</span>
                      <span className="break-words">{f.text}</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
          {parsed.elided && <div className="px-3 py-1.5 text-text-secondary">Diff too large to show in full</div>}
        </div>
      ) : (
        <div className="px-3.5 py-3 text-text-secondary">Diff not available</div>
      )}
    </div>
  );
}
