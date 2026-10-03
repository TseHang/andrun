import { useEffect, useRef, useState } from "react";
import type { Status } from "../../../src/core/events";
import { useApp } from "../context";
import { formatCost, formatTokens } from "../state/format";
import type { SessionView } from "../state/reducer";
import { Spinner } from "./Spinner";
import { DOT, STATUS_COLOR, STATUS_TEXT } from "./StatusLabel";

interface Props {
  title: string;
  status: Status;
  header: SessionView["header"];
  review: boolean;
  onDelete: () => void;
  moreRef: React.RefObject<HTMLButtonElement | null>;
}

export function SessionHeader({ title, status, header, review, onDelete, moreRef }: Props) {
  const { config } = useApp();
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
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
      <span data-testid="session-status" className={`flex shrink-0 items-center gap-1.5 font-medium ${STATUS_COLOR[status]}`}>
        {status === "running" && <Spinner />}
        {(status === "awaiting_approval" || status === "done" || status === "failed" || status === "budget_exceeded") && <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${DOT[status]}`} />}
        {review && status === "awaiting_approval" ? "Ready to post" : STATUS_TEXT[status]}
      </span>
      <span className="grow" />
      {review && <span className="shrink-0 text-text-secondary">Read-only review</span>}
      <span className="shrink-0 text-text-secondary">
        Step {header.step} of {config.maxSteps}
      </span>
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
      {header.cost > 0 && <span className="shrink-0 text-text-secondary">{formatCost(header.cost)}</span>}
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
