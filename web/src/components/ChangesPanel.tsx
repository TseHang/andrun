import { useState } from "react";
import { getFile, getPullFile } from "../api";
import type { Status } from "../../../src/core/events";
import type { ClientFrame } from "../../../src/session/protocol";
import type { SessionView } from "../state/reducer";
import { parseDiff } from "../state/diff";
import { changeTotals, firstLine, isPreviewable, isDeliverable, TASK_FORMAT_NOTE } from "../state/format";
import { Chevron } from "./Chevron";
import { DiffView } from "./DiffView";
import { PreviewPane } from "./HtmlPreview";
import { BoxIcon, DownloadIcon, EyeIcon, FileIcon } from "./Icons";
import { PlanCard } from "./PlanCard";
import { PullRequestSection } from "./PullRequestSection";
import { SectionTitle } from "./SectionTitle";
import type { SessionInfo } from "./Timeline";

const SMALL_BUTTON = "press flex shrink-0 cursor-pointer items-center gap-1 rounded-full bg-fill px-2.5 py-0.5 font-sans text-xs font-medium";

function Card({ sessionId, change, task, onPreview, defaultOpen }: { sessionId: string; change: SessionView["changes"][number]; task: boolean; onPreview: () => void; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
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
          <Chevron open={open} />
          <span className="min-w-0 grow truncate font-semibold">{change.path}</span>
          <span className="shrink-0 text-text-secondary">{isNew ? `new file · +${change.additions}` : `+${change.additions} −${change.deletions}`}</span>
        </button>
        {task && saved && !deleted && (
          <button type="button" onClick={() => void download()} className={SMALL_BUTTON}>
            <DownloadIcon />
            Download
          </button>
        )}
        {canPreview && (
          <button type="button" onClick={onPreview} className={SMALL_BUTTON}>
            <EyeIcon />
            Preview
          </button>
        )}
      </div>
      {downloadError && <div role="alert" className="px-3 py-2 text-xs text-failed">{downloadError}</div>}
      {open &&
        (task && !saved ? (
          <div className="px-3 py-2.5 text-xs text-text-secondary">{change.unavailableReason ?? "Too large to save (over 1 MB)"}</div>
        ) : change.diff === null ? (
          <div className="px-3 py-2.5 text-xs text-text-secondary">Changed by a command. Diff not available.</div>
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

/**
 * What the agent hands over, on the right: its plan, the pull request (or the finish approval), the changes, the sandbox.
 * `preview` names an HTML file shown in the panel's place, wider, until Back.
 */
export function ChangesPanel({ view, status, session, send, update, sandboxRunning, sha, preview = null, onPreview = () => {}, mode = "code", motion = "" }: { view: SessionView; status: Status; session: SessionInfo; send: (f: ClientFrame) => boolean; update: (fn: (v: SessionView) => SessionView) => void; sandboxRunning: boolean; sha: string; preview?: string | null; onPreview?: (path: string | null) => void; mode?: "code" | "review" | "task"; motion?: string }) {
  const id = session.id;
  const task = mode === "task";
  const changes = task ? view.changes.filter((c) => isDeliverable(c.path)) : view.changes;
  const totals = changeTotals(changes);
  const wide = changes.length > 0 || view.gate !== null;
  const last = view.lastCommand;
  const label = task ? "Files" : "Changes";
  // Expand all / Collapse all: a new `round` remounts the cards with that state; each card still toggles on its own.
  const [all, setAll] = useState({ open: true, round: 0 });

  const shown = preview === null ? undefined : changes.find((c) => c.path === preview && c.diff !== null);
  if (shown) {
    return (
      <aside aria-label={label} className={`flex min-h-0 min-w-0 w-[55%] shrink-0 flex-col border-l border-black/10 p-4 ${motion}`}>
        <PreviewPane load={() => getFile(id, shown.path)} loadFile={async (path) => (await getFile(id, path)) ?? (session.pr === null ? null : getPullFile(session.pr, path))} path={shown.path} version={shown.diff!} onBack={() => onPreview(null)} />
      </aside>
    );
  }

  return (
    <aside aria-label={label} className={`min-h-0 min-w-0 shrink-0 overflow-y-auto border-l border-black/10 px-5 pt-4 pb-6 ${wide ? "w-[min(520px,45%)]" : "w-[400px]"} ${motion}`}>
      {view.plan && <PlanCard plan={view.plan} active={status === "running"} />}
      <PullRequestSection view={view} status={status} session={session} send={send} update={update} />
      <SectionTitle
        icon={<FileIcon />}
        title={label}
        toggle={changes.length > 0 ? { open: all.open, onClick: () => setAll({ open: !all.open, round: all.round + 1 }) } : undefined}
        meta={
          totals.files === 0 ? (
            "None yet"
          ) : (
            <>
              {`${totals.files} ${totals.files === 1 ? "file" : "files"} · `}
              <span className="text-done-text">+{totals.additions}</span> <span className="text-failed">−{totals.deletions}</span>
            </>
          )
        }
      />
      {task && <div className="mb-3 text-xs text-text-secondary">{TASK_FORMAT_NOTE}</div>}
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
        changes.map((c) => <Card key={`${c.path}:${all.round}`} sessionId={id} change={c} task={task} defaultOpen={all.open} onPreview={() => onPreview(c.path)} />)
      )}
      <div className="mt-5">
        <SectionTitle icon={<BoxIcon />} title="Environment" />
      </div>
      {last && (
        <div className="mb-2 flex items-baseline gap-1.5 text-xs text-text-secondary">
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
