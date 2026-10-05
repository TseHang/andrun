import type { PullDetail } from "../api";
import type { FindingView } from "../state/reducer";
import { FileDiff, type Jump } from "./PatchView";

/** Files changed, on the right of the page. Without a `pull` it shows `notice` (loading, or why there is no diff). */
export function ReviewFilesPanel({ pull, findings, onHide, jump, notice, motion = "" }: { pull: PullDetail | null; findings: FindingView[]; onHide: () => void; jump?: Jump | null; notice?: string; motion?: string }) {
  const files = pull?.files ?? [];
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  return (
    <aside aria-label="Files changed" className={`flex min-h-0 w-[58%] shrink-0 flex-col gap-3.5 overflow-y-auto border-l border-black/8 px-5 pt-4 pb-6 ${motion}`}>
      <div className="flex items-baseline justify-between">
        <h2 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">Files changed</h2>
        <span className="flex items-baseline gap-3 text-xs text-text-secondary">
          {pull && (
            <span>
              {`${files.length} ${files.length === 1 ? "file" : "files"} · `}
              <span className="text-done-text">+{additions}</span> <span className="text-failed">−{deletions}</span>
            </span>
          )}
          <button type="button" onClick={onHide} className="shrink-0 cursor-pointer rounded-full bg-fill px-2.5 py-0.5 text-xs font-medium">
            Hide files
          </button>
        </span>
      </div>
      {notice && <span className="text-text-secondary">{notice}</span>}
      {pull?.files.map((f) => (
        <FileDiff key={f.path} file={f} findings={findings} previewPr={pull.fork ? undefined : pull.number} jump={jump} />
      ))}
    </aside>
  );
}
