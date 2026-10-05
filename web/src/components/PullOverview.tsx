import { useState } from "react";
import type { PullDetail } from "../api";
import { AuthorAvatar, authorName } from "./Author";
import { Chevron } from "./Chevron";
import { Markdown } from "./Markdown";

const BRANCH = "rounded-md bg-fill px-1.5 py-px font-mono text-xs text-text";

/** Where the pull request goes, and the description its author wrote, framed as the author's post so it does not read as the agent's reply. */
export function PullOverview({ pull, defaultOpen = true }: { pull: PullDetail; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section aria-label="Pull request" className="flex flex-col gap-3">
      <div data-branches className="flex flex-wrap items-center gap-1.5 text-[13px] text-text-secondary">
        from <span className={BRANCH}>{pull.headRef}</span> into <span className={BRANCH}>{pull.baseRef}</span>
      </div>
      <div className="overflow-hidden rounded-xl border border-black/10">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex h-10 w-full cursor-pointer items-center gap-2 bg-sidebar px-3.5 text-left">
          <AuthorAvatar pull={pull} />
          <span className="text-[13px] font-semibold">{authorName(pull)}</span>
          <span className="grow text-xs text-text-secondary">Description</span>
          <Chevron open={open} />
        </button>
        {open && <div className="border-t border-black/8 px-4 py-3">{pull.body.trim() === "" ? <p className="m-0 text-text-secondary">No description.</p> : <Markdown text={pull.body} />}</div>}
      </div>
    </section>
  );
}
