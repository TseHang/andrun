import { useState } from "react";
import type { PullDetail } from "../api";
import { Chevron } from "./Chevron";
import { Markdown } from "./Markdown";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Who wants to merge what, and the description the author wrote. */
export function PullOverview({ pull, defaultOpen = true }: { pull: PullDetail; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const size = `${plural(pull.changedFiles, "file")}, ${pull.additions} added${pull.deletions > 0 ? `, ${pull.deletions} removed` : ""}`;
  return (
    <section aria-label="Pull request" className="flex flex-col gap-2">
      <div className="text-[13px] text-text-secondary">
        <span>{`${pull.author} wants to merge ${pull.headRef} into ${pull.baseRef}`}</span> <span className="text-xs">{`· ${size} · head ${pull.headSha.slice(0, 7)}`}</span>
      </div>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-fit cursor-pointer items-center gap-2 py-1 text-xs font-semibold">
        <Chevron open={open} />
        Description
      </button>
      {open && (pull.body.trim() === "" ? <p className="m-0 text-text-secondary">No description.</p> : <Markdown text={pull.body} />)}
    </section>
  );
}
