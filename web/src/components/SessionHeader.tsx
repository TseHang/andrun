import { useEffect, useRef, useState } from "react";
import type { Status } from "../../../src/core/events";
import { useApp } from "../context";
import { formatCost, formatTokens } from "../state/format";
import type { SessionView } from "../state/reducer";
import { PanelIcon } from "./Icons";
import { Spinner } from "./Spinner";
import { CLOSED_DOT, DOT, STATUS_COLOR, STATUS_TEXT, closedText, type ClosedPr } from "./StatusLabel";

interface Props {
  title: string;
  status: Status;
  /** Set when the session's pull request was merged or closed (A26). */
  prState?: ClosedPr;
  header: SessionView["header"];
  review: boolean;
  onDelete: () => void;
  moreRef: React.RefObject<HTMLButtonElement | null>;
  /** The side panel's toggle, always in the same place: what the panel lists ("changes", "files") and how many. */
  panel?: { hidden: boolean; noun: string; count: number; onToggle: () => void };
}

export function SessionHeader({ title, status, prState, header, review, onDelete, moreRef, panel }: Props) {
  const { config } = useApp();
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const closed = closedText(status, prState);
  const over = header.cost > config.costNotice;
  const notice = `This session has cost more than ¥${config.costNotice}. Smaller tasks cost less: consider splitting the work.`;
  const pct = header.contextWindow > 0 ? Math.min(100, (header.contextTokens / header.contextWindow) * 100) : 0;

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      moreRef.current?.focus();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menu.current?.contains(t) || moreRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, moreRef]);

  return (
    <header className="flex h-[52px] shrink-0 items-center gap-3.5 border-b border-black/8 pl-7 pr-3">
      <h1 className="m-0 min-w-0 truncate text-[15px] font-semibold tracking-[-0.01em]">{title}</h1>
      <span data-testid="session-status" className={`flex shrink-0 items-center gap-1.5 font-medium ${closed ? "text-text-secondary" : STATUS_COLOR[status]}`}>
        {status === "running" && <Spinner />}
        {closed ? <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${CLOSED_DOT}`} /> : (status === "awaiting_approval" || status === "awaiting_input" || status === "done" || status === "failed" || status === "budget_exceeded") && <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${DOT[status]}`} />}
        {closed ?? (review && status === "awaiting_approval" ? "Ready to post" : STATUS_TEXT[status])}
      </span>
      <span className="grow" />
      {review && <span className="shrink-0 text-text-secondary">Read-only review</span>}
      <span className="shrink-0 text-text-secondary">Step {header.step}</span>
      {header.contextWindow > 0 && (
        <span className="flex shrink-0 items-center gap-1.5 text-text-secondary">
          <span className="flex h-1 w-12 overflow-hidden rounded-full bg-[#e5e5ea]">
            <span className="bg-text-secondary" style={{ width: `${pct}%` }} />
          </span>
          <span>
            {formatTokens(header.contextTokens)} of {formatTokens(header.contextWindow)}
          </span>
        </span>
      )}
      {header.cost > 0 && (
        <span className="relative flex shrink-0 items-center gap-1">
          <span data-testid="session-cost" data-over-notice={over} className={over ? "text-failed" : "text-text-secondary"}>
            {formatCost(header.cost)}
          </span>
          {over && (
            <>
              <svg role="img" aria-label={notice} tabIndex={0} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className="peer rounded-full text-failed">
                <circle cx="8" cy="8" r="6.5" />
                <path d="M8 7.2v4" strokeLinecap="round" />
                <circle cx="8" cy="4.8" r="0.5" fill="currentColor" />
              </svg>
              {/* Shown on hover and on keyboard focus: a native title appears for neither touch nor keyboard. */}
              <span role="tooltip" className="absolute right-0 top-6 z-10 hidden w-64 rounded-lg bg-white p-2.5 text-xs text-text shadow-[0_0_0_0.5px_rgba(0,0,0,0.14),0_10px_36px_rgba(0,0,0,0.18)] peer-hover:block peer-focus:block">
                {notice}
              </span>
            </>
          )}
        </span>
      )}
      {panel && (
        <button
          type="button"
          aria-label={panel.hidden ? `Show ${panel.noun} · ${panel.count}` : `Hide ${panel.noun}`}
          aria-pressed={!panel.hidden}
          title={panel.hidden ? `Show ${panel.noun}` : `Hide ${panel.noun}`}
          onClick={panel.onToggle}
          className={`press flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 ${panel.hidden ? "text-text-secondary hover:bg-black/6" : "bg-black/6 text-text"}`}
        >
          <PanelIcon />
          {panel.hidden && panel.count > 0 && <span className="text-xs font-medium tabular-nums">{panel.count}</span>}
        </button>
      )}
      <div className="relative">
        <button
          ref={moreRef}
          type="button"
          aria-label="More"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex size-8 cursor-pointer items-center justify-center rounded-lg text-text-secondary"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <circle cx="3" cy="8" r="1.3" />
            <circle cx="8" cy="8" r="1.3" />
            <circle cx="13" cy="8" r="1.3" />
          </svg>
        </button>
        {open && (
          <div ref={menu} role="menu" className="absolute right-0 top-9 z-10 flex w-40 flex-col rounded-xl bg-white p-[5px] shadow-[0_0_0_0.5px_rgba(0,0,0,0.14),0_10px_36px_rgba(0,0,0,0.18)]">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onDelete();
              }}
              className="flex h-7 cursor-pointer items-center rounded-md px-2 text-left text-danger-text hover:bg-danger-bg"
            >
              Delete
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
