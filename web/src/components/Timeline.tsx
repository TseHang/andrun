import { useLayoutEffect, useRef } from "react";
import type { SessionView, TimelineItem } from "../state/reducer";
import { modelLabel, prTarget } from "../state/format";
import { StepGroup } from "./StepGroup";

const NOTE = "No files changed, so no pull request was opened.";
const VERDICT = { COMMENT: "Comment", APPROVE: "Approve", REQUEST_CHANGES: "Request changes" };

export interface SessionInfo {
  id: string;
  code: boolean;
  baseBranch: string | null;
}

const GITHUB_LINK = (url: string) => (
  <a href={url} target="_blank" rel="noreferrer" className="text-accent-text">
    View on GitHub
  </a>
);

function Item({ item, session }: { item: TimelineItem; session: SessionInfo }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="my-3 flex flex-col items-end">
          <div data-item="user" className="max-w-[80%] rounded-2xl bg-fill px-3.5 py-2 text-[14px] break-words whitespace-pre-wrap">
            {item.text}
          </div>
          {item.pending && <div className="mt-1 text-xs text-text-secondary">Queued for the next step</div>}
        </div>
      );
    case "assistant": {
      const u = item.usage;
      return (
        <div className="my-3">
          <p className="text-[15px] leading-relaxed break-words whitespace-pre-wrap">
            {item.text}
            {item.streaming && <span aria-hidden="true" className="ml-0.5 inline-block h-[1em] w-0.5 translate-y-0.5 bg-text" style={{ animation: "blink 1s steps(2) infinite" }} />}
          </p>
          {u && (
            <div className="mt-1 text-xs text-text-tertiary">
              {`${modelLabel(u.model)} · ${u.tokensIn.toLocaleString("en-US")} in · ${u.tokensOut.toLocaleString("en-US")} out · ${(u.latencyMs / 1000).toFixed(1)} s`}
            </div>
          )}
        </div>
      );
    }
    case "steps":
      return <StepGroup rows={item.rows} />;
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
        </div>
      );
    case "approved":
      return (
        <div className="my-4 flex items-center gap-3 text-xs text-text-secondary">
          <div className="h-px grow bg-black/10" />
          <span className="flex items-center gap-1">
            <span aria-hidden="true" className="text-done">✓</span>Approved
          </span>
          <div className="h-px grow bg-black/10" />
        </div>
      );
  }
}

export function Timeline({ view, session }: { view: SessionView; session: SessionInfo }) {
  const ref = useRef<HTMLElement>(null);
  const height = useRef(0);
  // Follow only if the view was at the bottom before this render's content was added.
  useLayoutEffect(() => {
    const el = ref.current!;
    if (height.current - el.clientHeight - el.scrollTop <= 40) el.scrollTop = el.scrollHeight;
    height.current = el.scrollHeight;
  });

  return (
    <section aria-label="Timeline" ref={ref} className="min-h-0 min-w-0 grow overflow-y-auto">
      <div className="mx-auto max-w-[720px] px-6 pt-4 pb-44">
        {view.items.map((item, i) => (
          <div key={item.key}>
            <Item item={item} session={session} />
            {session.code && item.kind === "approved" && item.finish && view.items[i + 1]?.kind !== "pr" && <p className="text-center text-xs text-text-secondary">{NOTE}</p>}
          </div>
        ))}
      </div>
    </section>
  );
}
