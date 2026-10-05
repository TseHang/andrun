import type { ReactNode } from "react";

/** A section of the side panel: an icon, a title, and what it counts on the right. */
export function SectionTitle({ icon, title, meta }: { icon: ReactNode; title: string; meta?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-1.5">
      <span className="text-text-secondary">{icon}</span>
      <h2 className="grow text-[13px] font-semibold">{title}</h2>
      {meta !== undefined && <span className="text-xs text-text-secondary">{meta}</span>}
    </div>
  );
}
