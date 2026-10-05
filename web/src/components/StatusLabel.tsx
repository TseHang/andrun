import type { Status } from "../../../src/core/events";
import { Spinner } from "./Spinner";

export const STATUS_TEXT: Record<Status, string> = {
  idle: "Idle",
  running: "Running",
  awaiting_approval: "Awaiting approval",
  awaiting_input: "Waiting for you",
  done: "Done",
  failed: "Failed",
  budget_exceeded: "Limit reached",
};

export const DOT: Record<Status, string> = {
  idle: "bg-text-tertiary",
  running: "bg-accent",
  awaiting_approval: "bg-accent",
  awaiting_input: "bg-accent",
  done: "bg-done",
  failed: "bg-failed",
  budget_exceeded: "bg-failed",
};

export const STATUS_COLOR: Record<Status, string> = {
  idle: "text-text-secondary",
  running: "text-text-secondary",
  awaiting_approval: "text-accent-text",
  awaiting_input: "text-accent-text",
  done: "text-done-text",
  failed: "text-failed",
  budget_exceeded: "text-failed",
};

/** Sidebar text colour: only the statuses that wait for the human are coloured; the dot carries the rest. */
export const LIST_COLOR = (s: Status) => (s === "awaiting_approval" || s === "awaiting_input" ? "text-accent-text" : "text-text-secondary");

export type ClosedPr = "merged" | "closed";

/** A session whose pull request was merged or closed takes no more messages (A26): that is shown in place of its status, unless a run is still going. */
export const closedText = (status: Status, prState?: ClosedPr): string | null => (!prState || status === "running" ? null : prState === "merged" ? "Merged" : "Closed");
export const CLOSED_DOT = "bg-text-tertiary";

/** Dot (a spinner while running) and the status text, as shown in lists. */
export function StatusLabel({ status, prState, className = "" }: { status: Status; prState?: ClosedPr; className?: string }) {
  const closed = closedText(status, prState);
  return (
    <span className={`flex items-center gap-1.5 ${className}`}>
      {status === "running" ? <Spinner size={8} /> : <span className={`size-1.5 shrink-0 rounded-full ${closed ? CLOSED_DOT : DOT[status]}`} />}
      <span>{closed ?? STATUS_TEXT[status]}</span>
    </span>
  );
}
