import { useState } from "react";
import type { Status } from "../../../src/core/events";
import type { PullRow } from "../api";
import { useApp } from "../context";
import { relativeTime } from "../state/format";

type Tab = "All" | "Needs review" | "My PRs";
const TABS: Tab[] = ["All", "Needs review", "My PRs"];
const EMPTY: Record<Tab, string> = {
  All: "No open pull requests.",
  "Needs review": "No pull requests need a review.",
  "My PRs": "&run has not opened a pull request yet.",
};

const PILL = "flex h-[30px] w-[116px] items-center justify-center rounded-full font-semibold";

function reviewState(status: Status | undefined): { text: string; className: string } {
  switch (status) {
    case "running":
      return { text: "Review in progress", className: "text-text-secondary" };
    case "awaiting_approval":
      return { text: "Review drafted", className: "text-accent-text" };
    case "done":
      return { text: "Reviewed", className: "text-text-secondary" };
    case undefined:
      return { text: "Needs review", className: "text-text-secondary" };
    default:
      return { text: "Review stopped", className: "text-text-secondary" };
  }
}

function age(updatedAt: string): string {
  const t = relativeTime(Date.parse(updatedAt), Date.now());
  return t === "now" ? "just now" : `${t} ago`;
}

function Row({ pull }: { pull: PullRow }) {
  const { codeSession, reviewSession } = pull;
  const state = reviewState(reviewSession?.status);
  const waiting = !reviewSession && (pull.openComments ?? 0) > 0 ? pull.openComments! : 0;
  return (
    <div data-pr={pull.number} className="flex min-h-[68px] items-center gap-4 border-t border-black/8 px-1 last:border-b">
      <div className="flex min-w-0 grow flex-col gap-0.5">
        <span className="truncate text-[14px] font-semibold">
          {pull.title} <span className="font-normal text-text-secondary">#{pull.number}</span>
        </span>
        <span className="truncate text-xs text-text-secondary">
          {pull.mine ? "Opened by &run" : pull.author} · {pull.headRef} · {age(pull.updatedAt)}
        </span>
      </div>
      {waiting > 0 ? <span className="text-accent-text">{`${waiting} ${waiting === 1 ? "comment" : "comments"} to answer`}</span> : <span className={state.className}>{state.text}</span>}
      {codeSession && (
        <a href={`/s/${codeSession.id}`} className={`${PILL} bg-black/6`}>
          View session
        </a>
      )}
      {reviewSession && (
        <a href={`/s/${reviewSession.id}`} className={`${PILL} bg-black/6`}>
          View review
        </a>
      )}
      {!reviewSession && (
        <a href={`/prs/${pull.number}`} className={`${PILL} bg-accent text-white`}>
          Start review
        </a>
      )}
    </div>
  );
}

export function PullRequestsPage({ pulls, error }: { pulls: PullRow[] | null; error: string | null }) {
  const { config, refreshPulls } = useApp();
  const [tab, setTab] = useState<Tab>("All");
  const shown = (pulls ?? []).filter((p) => (tab === "Needs review" ? p.reviewSession?.status !== "done" : tab === "My PRs" ? p.mine : true));
  return (
    <main className="flex min-w-0 grow flex-col items-center overflow-y-auto px-12 pb-10 pt-14">
      <div className="flex w-[860px] flex-col gap-5">
        <div className="flex items-end gap-4">
          <div className="flex flex-col gap-0.5">
            <h1 className="m-0 text-[28px] font-bold leading-[1.15] tracking-[-0.022em]">Pull requests</h1>
            <span className="text-text-secondary">{config.repo}, live from GitHub</span>
          </div>
          <span className="grow" />
          <div role="tablist" aria-label="Filter" className="flex rounded-[9px] bg-fill p-0.5">
            {TABS.map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`h-7 cursor-pointer rounded-[7px] px-3.5 ${tab === t ? "bg-white font-semibold shadow-[0_1px_2px_rgba(0,0,0,0.14),0_0_0_0.5px_rgba(0,0,0,0.04)]" : ""}`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
        {error ? (
          <div role="alert" className="flex items-center gap-3 rounded-lg bg-danger-bg px-3 py-2 text-danger-text">
            <span className="grow">{error}</span>
            <button type="button" onClick={refreshPulls} className="shrink-0 cursor-pointer rounded-full bg-white px-3.5 py-1 font-semibold">
              Retry
            </button>
          </div>
        ) : pulls === null ? null : shown.length === 0 ? (
          <div className="border-y border-black/8 py-10 text-center text-text-secondary">{EMPTY[tab]}</div>
        ) : (
          <div className="flex flex-col">
            {shown.map((p) => (
              <Row key={p.number} pull={p} />
            ))}
          </div>
        )}
        <p className="m-0 max-w-[620px] text-xs text-text-secondary">My PRs are the pull requests &run opened from this workspace. Reviews are posted as TseHang.</p>
      </div>
    </main>
  );
}
