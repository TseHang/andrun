import { useState } from "react";
import { getFile } from "../api";
import type { SessionView } from "../state/reducer";
import { parseDiff } from "../state/diff";
import { changeTotals, firstLine, isPreviewable, isDeliverable, TASK_FORMAT_NOTE } from "../state/format";
import { DiffView } from "./DiffView";
import { HtmlPreview } from "./HtmlPreview";

const SMALL_BUTTON = "shrink-0 cursor-pointer rounded-full bg-fill px-2.5 py-0.5 text-xs font-medium";

function Card({ sessionId, change, task }: { sessionId: string; change: SessionView["changes"][number]; task: boolean }) {
  const [open, setOpen] = useState(true);
  const [preview, setPreview] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const download = async () => {
    setDownloadError(null);
    try {
      const content = await getFile(sessionId, change.path);
      if (content === null) return setDownloadError("File is not available for download.");
      const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = change.path.split("/").at(-1)!;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setDownloadError("Could not download the file.");
    }
  };
  const saved = change.saved !== false;
  const deleted = change.diff !== null && /\+\+\+ \/dev\/null/.test(change.diff);
  const isNew = change.diff !== null && parseDiff(change.diff).isNew;
  const canPreview = change.diff !== null && isPreviewable(change.path) && (!task || (saved && !deleted));
  return (
    <div data-file={change.path} className="mb-3 overflow-hidden rounded-xl border border-black/10">
      <div className="flex items-center gap-2 bg-sidebar pr-3 font-mono text-xs">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-w-0 grow cursor-pointer items-center gap-2 py-2 pl-3 text-left">
          <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" className={`shrink-0 text-text-secondary ${open ? "rotate-90" : ""}`}>
            <path d="M3.5 1.5 7 5l-3.5 3.5" />
          </svg>
          <span className="min-w-0 grow truncate font-semibold">{change.path}</span>
          <span className="shrink-0 text-text-secondary">{isNew ? `new file · +${change.additions}` : `+${change.additions} −${change.deletions}`}</span>
        </button>
        {task && saved && !deleted && (
          <button type="button" onClick={() => void download()} className={SMALL_BUTTON}>Download</button>
        )}
        {canPreview && (
          <button type="button" onClick={() => setPreview(!preview)} className={SMALL_BUTTON}>
            {preview ? "Diff" : "Preview"}
          </button>
        )}
      </div>
      {downloadError && <div role="alert" className="px-3 py-2 text-xs text-failed">{downloadError}</div>}
      {open &&
        (task && !saved ? (
          <div className="px-3 py-2.5 text-xs text-text-secondary">{change.unavailableReason ?? "Too large to save (over 1 MB)"}</div>
        ) : change.diff === null ? (
          <div className="px-3 py-2.5 text-xs text-text-secondary">Changed by a command. Diff not available.</div>
        ) : canPreview && preview ? (
          <HtmlPreview load={() => getFile(sessionId, change.path)} path={change.path} version={change.diff} />
        ) : (
          <DiffView diff={change.diff} />
        ))}
    </div>
  );
}

function InfoRow({ label, children, testId }: { label: string; children: string; testId?: string }) {
  return (
    <div className="flex justify-between gap-3 px-3 py-2 text-xs">
      <span className="text-text-secondary">{label}</span>
      <span data-testid={testId} className="text-right">{children}</span>
    </div>
  );
}

export function ChangesPanel({ id, view, sandboxRunning, sha, onHide, mode = "code", motion = "" }: { id: string; view: SessionView; sandboxRunning: boolean; sha: string; onHide: () => void; mode?: "code" | "review" | "task"; motion?: string }) {
  const task = mode === "task";
  const changes = task ? view.changes.filter((c) => isDeliverable(c.path)) : view.changes;
  const totals = changeTotals(changes);
  const wide = changes.length > 0 || view.gate !== null;
  const last = view.lastCommand;
  return (
    <aside
      aria-label={task ? "Files" : "Changes"}
      className={`min-h-0 min-w-0 shrink-0 overflow-y-auto border-l border-black/10 px-5 pt-4 pb-[calc(var(--bar-h,116px)+60px)] ${wide ? "w-[min(520px,45%)]" : "w-[400px]"} ${motion}`}
    >
      {task && <div className="mb-3 text-xs text-text-secondary">{TASK_FORMAT_NOTE}</div>}
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-[15px] font-semibold">{task ? "Files" : "Changes"}</h2>
        <span className="flex items-baseline gap-3 text-xs text-text-secondary">
          <span>
          {totals.files === 0 ? (
            "None yet"
          ) : (
            <>
              {`${totals.files} ${totals.files === 1 ? "file" : "files"} · `}
              <span className="text-done-text">+{totals.additions}</span> <span className="text-failed">−{totals.deletions}</span>
            </>
          )}
          </span>
          <button type="button" onClick={onHide} className={SMALL_BUTTON}>
            {task ? "Hide files" : "Hide changes"}
          </button>
        </span>
      </div>
      {!task && view.testPaths.length > 0 && (
        <div className="mb-3 rounded-xl bg-warning-bg p-3 text-xs text-warning-text">
          <div className="font-semibold">This change edits a test</div>
          <div className="mt-1 font-mono break-words">{view.testPaths.join(", ")}</div>
        </div>
      )}
      {changes.length === 0 ? (
        <div className="mb-4 rounded-xl bg-sidebar px-4 py-8 text-center">
          <div className="text-[13px] font-semibold">{task ? "No files yet" : "No changes yet"}</div>
          <div className="mt-1 text-xs text-text-secondary">{task ? "Deliverable files appear here as the agent writes them." : "Diffs appear here as the agent edits files."}</div>
        </div>
      ) : (
        changes.map((c) => <Card key={c.path} sessionId={id} change={c} task={task} />)
      )}
      {last && (
        <div className="mb-4 flex items-baseline gap-1.5 text-xs text-text-secondary">
          <span className="shrink-0">Last command:</span>
          <code title={last.command} className="min-w-0 truncate font-mono text-text">{firstLine(last.command)}</code>
          <span className={`shrink-0 ${last.exitCode === 0 ? "text-done-text" : "text-failed"}`}>· exit {last.exitCode === null ? "timed out" : last.exitCode}</span>
        </div>
      )}
      <div className="divide-y divide-white rounded-xl bg-sidebar">
        <InfoRow label="Sandbox" testId="sandbox-state">{sandboxRunning ? "Running" : "Stopped · starts again with your next message"}</InfoRow>
        <InfoRow label="Network">{task ? "Web, read-only (GET)" : "Off"}</InfoRow>
        {!task && <InfoRow label="Base commit">{sha.slice(0, 7)}</InfoRow>}
      </div>
    </aside>
  );
}
