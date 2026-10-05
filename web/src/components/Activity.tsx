import { useEffect, useState } from "react";

/** Seconds on one activity before its elapsed time shows: a quick step needs no clock. */
const SHOW_AFTER = 3;

/**
 * What the agent is doing right now: the &run mark breathes in the column where its reply will land,
 * the label shimmers, and after a few seconds the time on this activity counts up.
 */
export function Activity({ label }: { label: string }) {
  const [start, setStart] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    const t0 = Date.now();
    setStart(t0);
    setNow(t0);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [label]);
  const seconds = Math.floor((now - start) / 1000);

  return (
    <div className="my-3 flex items-center gap-2">
      <span aria-hidden="true" data-mark className="w-4 shrink-0 text-[15px] leading-relaxed font-semibold text-accent" style={{ animation: "breathe 1.4s ease-in-out infinite" }}>
        &
      </span>
      <span role="status" className="shimmer text-xs">
        {label}
      </span>
      {seconds >= SHOW_AFTER && (
        <span aria-hidden="true" className="text-xs text-text-tertiary tabular-nums">
          {seconds}s
        </span>
      )}
    </div>
  );
}
