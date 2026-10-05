import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { SessionView, TimelineItem } from "../state/reducer";
import { activityLabel, modelLabel, prTarget, usageLine } from "../state/format";
import { Activity } from "./Activity";
import { Enter, isLive } from "./Enter";
import { Markdown } from "./Markdown";
import { StepGroup } from "./StepGroup";

const NOTE = "No files changed, so no pull request was opened.";
const VERDICT = { COMMENT: "Comment", APPROVE: "Approve", REQUEST_CHANGES: "Request changes" };

export interface SessionInfo {
  id: string;
  /** The session's title: the pull request's title when the agent gives none. */
  title?: string;
  code: boolean;
  baseBranch: string | null;
  pr: number | null;
  /** The pull request was merged or closed: the session takes no more messages (A26). */
  closed?: boolean;
  /** A review: its summary belongs to the post bar, not the conversation. */
  review?: boolean;
}

const GITHUB_LINK = (url: string) => (
  <a href={url} target="_blank" rel="noreferrer" className="text-accent-text">
    View on GitHub
  </a>
);

/** `latest`: the last posted review, which says how the review goes on. */
function Item({ item, session, latest, live }: { item: TimelineItem; session: SessionInfo; latest: boolean; live: boolean }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="my-3 flex flex-col items-end">
          <div data-item="user" className="max-w-[80%] rounded-2xl bg-fill px-3.5 py-2 text-[14px] break-words whitespace-pre-wrap">
            {item.text}
          </div>
          {item.pending && <div className="mt-1 text-xs text-text-secondary">Queued · read after the current step</div>}
        </div>
      );
    case "assistant": {
      const u = item.usage;
      return (
        <div data-item="assistant" className="my-3 flex items-start gap-2">
          <span role="img" aria-label="&run" className="w-4 shrink-0 text-[15px] leading-relaxed font-semibold text-accent">&</span>
          <div className="min-w-0 grow">
            <Markdown text={item.text} />
            {item.streaming && <span aria-hidden="true" className="ml-0.5 inline-block h-[1em] w-0.5 translate-y-0.5 bg-text" style={{ animation: "blink 1s steps(2) infinite" }} />}
            {u && <div className="mt-1 text-xs text-text-tertiary">{usageLine(u)}</div>}
          </div>
        </div>
      );
    }
    case "reasoning":
      return (
        <details data-item="reasoning" open={item.streaming} className="my-3 pl-6 text-xs text-text-secondary">
          <summary className="cursor-pointer select-none">{item.streaming ? <span className="shimmer">Reasoning…</span> : "Reasoning"}</summary>
          <div className="mt-1.5 border-l-2 border-black/10 pl-3 leading-relaxed break-words whitespace-pre-wrap text-text-tertiary">{item.text}</div>
        </details>
      );
    case "routed":
      return (
        <div data-item="routed" className="my-3 pl-6 text-xs text-text-secondary">
          Auto · {item.task === "complex" ? "complex task" : "daily coding"} → <span className="font-mono text-[11px]">{modelLabel(item.model)}</span> · {item.reasoning}
        </div>
      );
    case "summary":
      if (session.review) return null;
      return (
        <div data-item="summary" className="my-3 flex items-start gap-2">
          <span role="img" aria-label="&run" className="w-4 shrink-0 text-[15px] leading-relaxed font-semibold text-accent">&</span>
          <div className="min-w-0 grow">
            <Markdown text={item.text} />
          </div>
        </div>
      );
    case "question":
      return (
        <div className="my-3">
          <Markdown text={item.question} />
        </div>
      );
    case "steps":
      return <StepGroup rows={item.rows} live={live} />;
    case "notice":
      return (
        <div className="my-3 rounded-xl bg-sidebar p-3.5">
          <div className="text-[13px] font-semibold">{item.title}</div>
          <div className="mt-0.5 text-xs text-text-secondary">{item.message}</div>
        </div>
      );
    case "failure":
      return (
        <div className="my-3 rounded-xl bg-sidebar p-3.5">
          <div className={`text-[13px] font-semibold ${item.source === "budget" ? "" : "text-failed"}`}>{item.title}</div>
          <div className="mt-2 rounded-lg bg-white p-2.5 font-mono text-xs break-words whitespace-pre-wrap">{item.message}</div>
          {item.next && <div className="mt-2 text-xs text-text-secondary">{item.next}</div>}
        </div>
      );
    case "pr":
      return (
        <div data-testid="pr-card" className="my-3 rounded-xl bg-sidebar p-3.5">
          <div className="text-[13px] font-semibold">{`Pull request${item.number !== undefined ? ` #${item.number}` : ""} ${item.updated ? "updated" : "opened"}`}</div>
          <div className="mt-1 font-mono text-xs text-text-secondary">{prTarget(item.branch, session.id, session.baseBranch)}</div>
          <div className="mt-1 text-xs text-text-secondary">Opened by the &run bot. {GITHUB_LINK(item.url)}</div>
        </div>
      );
    case "review_posted":
      return (
        <div data-testid="review-card" className="my-3 rounded-xl bg-sidebar p-3.5">
          <div className="text-[13px] font-semibold">Review posted · {VERDICT[item.verdict]}</div>
          <div className="mt-1 text-xs">{GITHUB_LINK(item.url)}</div>
          {/* This session reads the commit it started on; a newer one needs a new review. */}
          {latest && !session.closed && (
            <div className="mt-1 text-xs text-text-secondary">
              Keep asking &run here. New commits on the pull request?{" "}
              <a href={session.pr === null ? "/prs" : `/prs/${session.pr}`} className="text-accent-text">
                Review again
              </a>
            </div>
          )}
        </div>
      );
    case "approved":
      return (
        <div className="my-4 flex items-center gap-3 text-xs text-text-secondary">
          <div className="h-px grow bg-black/10" />
          <span className="flex items-center gap-1">
            <span aria-hidden="true" data-pop className="text-done">✓</span>Approved
          </span>
          <div className="h-px grow bg-black/10" />
        </div>
      );
  }
}

/** `before` and `after` sit in the scrolling column, around the activity (a review shows the pull request and the findings there). */
export function Timeline({ view, session, before, after }: { view: SessionView; session: SessionInfo; before?: ReactNode; after?: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const height = useRef(0);
  // Follow only if the view was at the bottom before this render's content was added.
  useLayoutEffect(() => {
    const el = ref.current!;
    if (height.current - el.clientHeight - el.scrollTop <= 40) el.scrollTop = el.scrollHeight;
    height.current = el.scrollHeight;
  });

  const activity = activityLabel(view);
  const lastPosted = view.items.filter((i) => i.kind === "review_posted").at(-1);
  const live = isLive(view);
  return (
    <section aria-label="Timeline" ref={ref} className="min-h-0 min-w-0 grow overflow-y-auto">
      <div className="mx-auto max-w-[720px] px-6 pt-4 pb-[calc(var(--bar-h,116px)+60px)]">
        {before}
        {view.items.map((item, i) => (
          <Enter key={item.key} live={live} motion={item.kind === "approved" || item.kind === "pr" ? "enter-slow" : "enter"}>
            <Item item={item} session={session} latest={item === lastPosted} live={live} />
            {session.code && item.kind === "approved" && item.finish && view.items[i + 1]?.kind !== "pr" && <p className="text-center text-xs text-text-secondary">{NOTE}</p>}
          </Enter>
        ))}
        {activity && <Activity label={activity} />}
        {after}
      </div>
    </section>
  );
}
