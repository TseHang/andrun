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
}

export function Sidebar({ sessions, stale, path, live, pullCount }: Props) {
  const { config } = useApp();
  const openId = /^\/s\/([^/]+)/.exec(path)?.[1];
  const onPrs = /^\/prs(\/|$)/.test(path);
  return (
    <nav aria-label="Workspace" className="flex w-[248px] shrink-0 flex-col gap-[18px] border-r border-black/8 bg-sidebar px-2.5 py-3.5">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between pl-2.5 pt-0.5">
          <a href="/" aria-label="&run home" className="rounded-md">
            <Wordmark />
          </a>
          <a href="/" aria-label="New session" className="flex size-8 items-center justify-center rounded-lg text-accent">
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M11.5 2.5l2 2L7 11l-2.5.5L5 9l6.5-6.5z" />
              <path d="M13 9.5v3a1 1 0 01-1 1H3.5a1 1 0 01-1-1V4a1 1 0 011-1h3" />
            </svg>
          </a>
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
  );
}
