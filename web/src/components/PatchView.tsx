import { useEffect, useRef, useState } from "react";
import type { Severity } from "../../../src/core/events";
import { getPullFile, type PullFile } from "../api";
import { parseDiff } from "../state/diff";
import { isPreviewable, severityLabel } from "../state/format";
import type { FindingView } from "../state/reducer";
import { Avatar } from "./Avatar";
import { Chevron } from "./Chevron";
import { PreviewPane } from "./HtmlPreview";
import { EyeIcon } from "./Icons";

const KIND = {
  add: "bg-diff-add-bg text-diff-add-text",
  del: "bg-diff-del-bg text-diff-del-text",
  context: "",
  hunk: "bg-sidebar text-text-secondary",
};
const SIGN = { add: "+", del: "−", context: " ", hunk: "" };

export const SEVERITY: Record<Severity, string> = {
  high: "text-failed",
  medium: "text-warning-text",
  low: "text-text-secondary",
};

export interface Jump {
  path: string;
  line: number;
  nonce: number;
}

/** The post header of a finding: who wrote it, and how much it matters. */
export function FindingHeader({ severity, muted = false }: { severity: Severity; muted?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <Avatar />
      <span className="text-[13px] font-semibold">&run</span>
      <span className={`text-xs font-semibold ${muted ? "" : SEVERITY[severity]}`}>{severityLabel(severity)}</span>
    </div>
  );
}

/**
 * One file of a pull request, as a card that folds: GitHub's hunks, and a note under each new-side line a kept finding sits on.
 * `previewPr` (the pull request's number) turns on Preview for an HTML file; a `jump` to this file opens the card and scrolls to the line.
 */
export function FileDiff({ file, findings = [], previewPr, jump }: { file: PullFile; findings?: FindingView[]; previewPr?: number; jump?: Jump | null }) {
  const [open, setOpen] = useState(true);
  const [preview, setPreview] = useState(false);
  const scroll = useRef(false);
  const parsed = file.patch === null ? null : parseDiff(file.patch);
  const notes = findings.filter((f) => f.path === file.path && f.inline && !f.dismissed);
  const canPreview = previewPr !== undefined && isPreviewable(file.path) && file.patch !== null && file.status !== "removed";

  useEffect(() => {
    if (jump?.path !== file.path) return;
    scroll.current = true;
    setOpen(true);
    setPreview(false);
  }, [jump]);
  useEffect(() => {
    if (!scroll.current || !open || preview) return;
    scroll.current = false;
    document.querySelector(`[data-line="${CSS.escape(`${jump!.path}:${jump!.line}`)}"]`)?.scrollIntoView({ block: "center" });
  });

  return (
    <div data-file={file.path} className="shrink-0 overflow-hidden rounded-xl shadow-[0_0_0_1px_rgba(0,0,0,0.08)]">
      <div className="flex h-9 items-center gap-2 bg-sidebar pr-3 font-mono text-xs">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex h-full min-w-0 grow cursor-pointer items-center gap-2 pl-3.5 text-left">
          <Chevron open={open} />
          <span className="min-w-0 grow truncate">{file.path}</span>
          <span className="shrink-0 text-text-secondary">{file.status}</span>
          <span className="shrink-0 text-diff-add-text">+{file.additions}</span>
          <span className="shrink-0 text-diff-del-text">−{file.deletions}</span>
        </button>
        {canPreview && (
          <button type="button" onClick={() => setPreview(!preview)} className="press flex shrink-0 cursor-pointer items-center gap-1 rounded-full bg-fill px-2.5 py-0.5 text-xs font-medium">
            {!preview && <EyeIcon />}
            {preview ? "Diff" : "Preview"}
          </button>
        )}
      </div>
      {open &&
        (canPreview && preview ? (
          <PreviewPane inline load={() => getPullFile(previewPr, file.path)} path={file.path} version={file.patch!} />
        ) : parsed ? (
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
                      <div key={f.id} className="mx-3.5 my-2 ml-16 flex flex-col gap-1.5 rounded-lg bg-white px-3 py-2 font-sans text-[13px] leading-snug whitespace-normal text-text shadow-[0_0_0_1px_rgba(0,0,0,0.08)]">
                        <FindingHeader severity={f.severity} />
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
        ))}
    </div>
  );
}
