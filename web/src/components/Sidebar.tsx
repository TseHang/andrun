import type { SessionSummary } from "../../../src/session/protocol";
import type { Status } from "../../../src/core/events";
import { LIST_COLOR, StatusLabel, closedText } from "./StatusLabel";
import { PlusIcon, PullRequestIcon } from "./Icons";
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

const SIDEBAR_ICON = (
  <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="3" width="12" height="10" rx="2" />
    <path d="M6 3v10" />
  </svg>
);

const ICON_BUTTON = "press flex size-8 cursor-pointer items-center justify-center rounded-lg";
const SHORTCUT = "⌘\\";
/** A nav row: an icon and a label, as in Claude's sidebar; the rail keeps the icon alone. */
const NAV = "press flex h-8 items-center gap-2.5 rounded-lg px-2.5 font-medium";
/** The icon's slot: a round tile for New, a plain icon otherwise. */
const NEW_TILE = "flex size-5 items-center justify-center rounded-full bg-black/8";

export function Sidebar({ sessions, stale, path, live, pullCount, collapsed = false, instant = false, onToggle }: Props) {
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
            <button type="button" aria-label="Hide sidebar" title={`Hide sidebar (${SHORTCUT})`} onClick={onToggle} className={`${ICON_BUTTON} text-text-secondary`}>
              {SIDEBAR_ICON}
            </button>
          </div>
        </div>
        <div className="flex flex-col gap-px">
          <a href="/" aria-current={path === "/" ? "page" : undefined} className={`${NAV} ${path === "/" ? "bg-black/6" : "hover:bg-black/4"}`}>
            <span className={NEW_TILE}>
              <PlusIcon size={12} />
            </span>
            New session
          </a>
          <a href="/prs" aria-current={onPrs ? "page" : undefined} className={`${NAV} ${onPrs ? "bg-black/6" : "hover:bg-black/4"}`}>
            <span className="flex size-5 items-center justify-center text-text-secondary">
              <PullRequestIcon size={16} />
            </span>
            <span className="grow">Review PRs</span>
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
        <a href="/" aria-label="New session" title="New session" aria-current={path === "/" ? "page" : undefined} className={`${ICON_BUTTON} mt-2 ${path === "/" ? "bg-black/6" : "hover:bg-black/4"}`}>
          <span className={NEW_TILE}>
            <PlusIcon size={12} />
          </span>
        </a>
        <a href="/prs" aria-label={pullCount ? `Review PRs · ${pullCount}` : "Review PRs"} title="Review PRs" aria-current={onPrs ? "page" : undefined} className={`${ICON_BUTTON} relative text-text-secondary ${onPrs ? "bg-black/6" : "hover:bg-black/4"}`}>
          <PullRequestIcon size={16} />
          {pullCount ? <span aria-hidden="true" className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-accent" /> : null}
        </a>
      </div>
    </div>
  );
}
