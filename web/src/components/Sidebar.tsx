import type { SessionSummary } from "../../../src/session/protocol";
import type { Status } from "../../../src/core/events";
import { useApp } from "../context";
import { LIST_COLOR, StatusLabel, closedText } from "./StatusLabel";
import { Wordmark } from "./Wordmark";

interface Props {
  sessions: SessionSummary[];
  stale: boolean;
  path: string;
  live: { id: string; status: Status } | null;
  /** Open pull requests; null when the list failed or has not loaded. */
  pullCount: number | null;
  collapsed?: boolean;
  /** The last toggle came from the keyboard: it takes effect at once, with no slide. */
  instant?: boolean;
  onToggle?: () => void;
}

const NEW_SESSION_ICON = (
  <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M11.5 2.5l2 2L7 11l-2.5.5L5 9l6.5-6.5z" />
    <path d="M13 9.5v3a1 1 0 01-1 1H3.5a1 1 0 01-1-1V4a1 1 0 011-1h3" />
  </svg>
);

const SIDEBAR_ICON = (
  <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="3" width="12" height="10" rx="2" />
    <path d="M6 3v10" />
  </svg>
);

const ICON_BUTTON = "press flex size-8 cursor-pointer items-center justify-center rounded-lg";
const SHORTCUT = "⌘\\";

export function Sidebar({ sessions, stale, path, live, pullCount, collapsed = false, instant = false, onToggle }: Props) {
  const { config } = useApp();
  const openId = /^\/s\/([^/]+)/.exec(path)?.[1];
  const onPrs = /^\/prs(\/|$)/.test(path);
  return (
    <div
      className={`relative shrink-0 overflow-hidden border-r border-black/8 bg-sidebar ${instant ? "" : "transition-[width] duration-240 ease-drawer motion-reduce:transition-none"} ${collapsed ? "w-[52px]" : "w-[248px]"}`}
    >
      <nav aria-label="Workspace" inert={collapsed} className={`flex h-full w-[248px] flex-col gap-[18px] px-2.5 py-3.5 ${instant ? "" : "transition-opacity duration-150"} ${collapsed ? "opacity-0" : ""}`}>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between pl-2.5 pt-0.5">
            <a href="/" aria-label="&run home" className="rounded-md">
              <Wordmark />
            </a>
            <span className="flex">
              <button type="button" aria-label="Hide sidebar" title={`Hide sidebar (${SHORTCUT})`} onClick={onToggle} className={`${ICON_BUTTON} text-text-secondary`}>
                {SIDEBAR_ICON}
              </button>
              <a href="/" aria-label="New session" className={`${ICON_BUTTON} text-accent`}>
                {NEW_SESSION_ICON}
              </a>
            </span>
          </div>
          <div className="truncate px-2.5 font-mono text-[11px] text-text-secondary">{config.repo}</div>
        </div>
        <div className="flex flex-col gap-px">
          <a href="/" aria-current={path === "/" ? "page" : undefined} className={`flex h-8 items-center rounded-lg px-2.5 font-medium ${path === "/" ? "bg-black/6" : ""}`}>
            Code
          </a>
          <a
            href="/prs"
            aria-current={onPrs ? "page" : undefined}
            className={`flex h-8 items-center justify-between rounded-lg px-2.5 font-medium ${onPrs ? "bg-black/6" : ""}`}
          >
            <span>Review PRs</span>
            {pullCount !== null && <span className="text-text-secondary">{pullCount}</span>}
          </a>
        </div>
        <div className="flex min-h-0 grow flex-col gap-px overflow-y-auto">
          <div className="px-2.5 pb-1 text-[11px] font-semibold text-text-secondary">Recent</div>
          {sessions.length === 0 && <div className="px-2.5 py-1.5 text-text-tertiary">No sessions yet</div>}
          {sessions.map((s) => {
            const status = live && live.id === s.id ? live.status : s.status;
            const closed = closedText(status, s.prState) !== null;
            return (
              <a
                key={s.id}
                href={`/s/${s.id}`}
                aria-current={openId === s.id ? "page" : undefined}
                className={`flex flex-col gap-px rounded-lg px-2.5 py-1.5 ${openId === s.id ? "bg-black/6" : ""}`}
              >
                <span className="truncate font-medium">{s.title}</span>
                <span className="flex items-center gap-1.5">
                  <StatusLabel status={status} prState={s.prState} className={`text-[11px] ${closed ? "text-text-secondary" : LIST_COLOR(status)}`} />
                  {s.mode === "review" && <span data-tag="review" className="rounded-full bg-fill px-1.5 text-[11px] text-text-secondary">Review</span>}
                {s.mode === "task" && <span data-tag="task" className="rounded-full bg-fill px-1.5 text-[11px] text-text-secondary">Task</span>}
                </span>
              </a>
            );
          })}
        </div>
        {stale && <div className="px-2.5 text-[11px] text-text-secondary">Could not refresh</div>}
      </nav>
      {/* Collapsed: a rail with the two things still needed, the way back and a new session. */}
      <div inert={!collapsed} className={`absolute inset-y-0 left-0 flex w-[52px] flex-col items-center gap-1 pt-4 pb-3.5 ${instant ? "" : "transition-opacity duration-150"} ${collapsed ? "" : "opacity-0"}`}>
        <button type="button" aria-label="Show sidebar" title={`Show sidebar (${SHORTCUT})`} onClick={onToggle} className={`${ICON_BUTTON} text-text-secondary`}>
          {SIDEBAR_ICON}
        </button>
        <a href="/" aria-label="New session" className={`${ICON_BUTTON} text-accent`}>
          {NEW_SESSION_ICON}
        </a>
      </div>
    </div>
  );
}
