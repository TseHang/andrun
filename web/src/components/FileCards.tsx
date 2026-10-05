import type { ChangeView } from "../state/reducer";
import { isPreviewable } from "../state/format";
import { EyeIcon, GlobeIcon } from "./Icons";

/** A Task's web pages, at the end of the conversation: one card each, which opens the page in the side panel. */
export function FileCards({ changes, onOpen }: { changes: ChangeView[]; onOpen: (path: string) => void }) {
  const pages = changes.filter((c) => isPreviewable(c.path) && c.diff !== null && c.saved !== false && !/\+\+\+ \/dev\/null/.test(c.diff));
  if (pages.length === 0) return null;
  return (
    <div aria-label="Pages" role="list" className="my-3 flex flex-col gap-2 pl-6">
      {pages.map((c) => (
        <div key={c.path} role="listitem" data-page={c.path} className="flex items-center gap-3 rounded-xl border border-black/10 p-2.5 pr-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-sidebar text-accent">
            <GlobeIcon size={18} />
          </span>
          <span className="flex min-w-0 grow flex-col">
            <span className="truncate text-[13px] font-semibold">{c.path.split("/").at(-1)}</span>
            <span className="text-xs text-text-secondary">Web page</span>
          </span>
          <button type="button" onClick={() => onOpen(c.path)} className="press flex shrink-0 cursor-pointer items-center gap-1 rounded-full bg-fill px-3 py-1 text-xs font-medium">
            <EyeIcon />
            Open
          </button>
        </div>
      ))}
    </div>
  );
}
