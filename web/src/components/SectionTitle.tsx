import type { ReactNode } from "react";
import { ChevronIcon } from "./Icons";

/**
 * A section of the side panel: an icon, a title, and what it counts on the right.
 * With `toggle`, the title is a button that opens or closes everything in the section.
 */
export function SectionTitle({ icon, title, meta, toggle }: { icon: ReactNode; title: string; meta?: ReactNode; toggle?: { open: boolean; onClick: () => void } }) {
  return (
    <div className="mb-2 flex items-center gap-1.5">
      <span className="text-text-secondary">{icon}</span>
      {toggle ? (
        <h2 className="grow text-[13px] font-semibold">
          <button type="button" aria-expanded={toggle.open} title={toggle.open ? "Collapse all" : "Expand all"} onClick={toggle.onClick} className="-mx-1 flex cursor-pointer items-center gap-1.5 rounded-md px-1 hover:bg-black/5">
            {title}
            <span className="text-text-secondary">
              <ChevronIcon open={toggle.open} />
            </span>
          </button>
        </h2>
      ) : (
        <h2 className="grow text-[13px] font-semibold">{title}</h2>
      )}
      {meta !== undefined && <span className="text-xs text-text-secondary">{meta}</span>}
    </div>
  );
}
