import type { Status } from "../../../src/core/events";
import { Spinner } from "./Spinner";

export const STATUS_TEXT: Record<Status, string> = {
  idle: "Idle",
  running: "Running",
  awaiting_approval: "Awaiting approval",
  done: "Done",
  failed: "Failed",
  budget_exceeded: "Budget exceeded",
};

export const DOT: Record<Status, string> = {
  idle: "bg-text-tertiary",
  running: "bg-accent",
  awaiting_approval: "bg-accent",
  done: "bg-done",
  failed: "bg-failed",
  budget_exceeded: "bg-failed",
};

export const STATUS_COLOR: Record<Status, string> = {
  idle: "text-text-secondary",
  running: "text-text-secondary",
  awaiting_approval: "text-accent-text",
  done: "text-done-text",
  failed: "text-failed",
  budget_exceeded: "text-failed",
};

/** Sidebar text colour: only "Awaiting approval" is coloured; the dot carries the rest. */
export const LIST_COLOR = (s: Status) => (s === "awaiting_approval" ? "text-accent-text" : "text-text-secondary");

/** Dot (a spinner while running) and the status text, as shown in lists. */
export function StatusLabel({ status, className = "" }: { status: Status; className?: string }) {
  return (
    <span className={`flex items-center gap-1.5 ${className}`}>
      {status === "running" ? <Spinner size={8} /> : <span className={`size-1.5 shrink-0 rounded-full ${DOT[status]}`} />}
      <span>{STATUS_TEXT[status]}</span>
    </span>
  );
}
