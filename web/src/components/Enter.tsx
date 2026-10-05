import { useState, type ReactNode } from "react";
import type { SessionView } from "../state/reducer";

/** An event this recent arrived live; anything older is the stored log replayed on load. */
const LIVE_MS = 3000;

export function isLive(view: SessionView): boolean {
  return view.lastTs > Date.now() - LIVE_MS;
}

/**
 * Plays `motion` (a class from styles.css) once, when this mounts while the session is live.
 * The choice is made at mount, so a later render never replays it.
 */
export function Enter({ live, motion = "enter", className = "", children }: { live: boolean; motion?: string; className?: string; children: ReactNode }) {
  const [play] = useState(live);
  return <div className={`${play ? motion : ""} ${className}`.trim() || undefined}>{children}</div>;
}
