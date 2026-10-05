import { useState, type ReactNode } from "react";
import type { PullDetail } from "../api";
import type { FindingView } from "../state/reducer";
import { FileIcon } from "./Icons";
import { FileDiff, type Jump } from "./PatchView";
import { SectionTitle } from "./SectionTitle";

/**
 * Files changed, on the right of the page, laid out like a Code session's Changes. Without a `pull` it shows `notice`
 * (loading, or why there is no diff). The page header's panel button shows and hides it.
 */
export function ReviewFilesPanel({ pull, findings, note, jump, notice, motion = "" }: { pull: PullDetail | null; findings: FindingView[]; note?: (f: FindingView) => ReactNode; jump?: Jump | null; notice?: string; motion?: string }) {
  const files = pull?.files ?? [];
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  // Expand all / Collapse all: a new `round` remounts the cards with that state; each card still folds on its own.
  const [all, setAll] = useState({ open: true, round: 0 });
  return (
    <aside aria-label="Files changed" className={`min-h-0 min-w-0 w-[55%] shrink-0 overflow-y-auto border-l border-black/10 px-5 pt-4 pb-6 ${motion}`}>
      <SectionTitle
        icon={<FileIcon />}
        title="Files changed"
        toggle={files.length > 0 ? { open: all.open, onClick: () => setAll({ open: !all.open, round: all.round + 1 }) } : undefined}
        meta={
          pull && (
            <>
              {`${files.length} ${files.length === 1 ? "file" : "files"} · `}
              <span className="text-done-text">+{additions}</span> <span className="text-failed">−{deletions}</span>
            </>
          )
        }
      />
      {notice && <div className="text-xs text-text-secondary">{notice}</div>}
      {pull?.files.map((f) => (
        <FileDiff key={`${f.path}:${all.round}`} file={f} findings={findings} note={note} previewPr={pull.fork ? undefined : pull.number} jump={jump} defaultOpen={all.open} />
      ))}
    </aside>
  );
}
