import { useEffect, useState } from "react";
import type { Status } from "../../../src/core/events";
import { MAX_TASK_CHARS, type ClientFrame } from "../../../src/session/protocol";
import { getPullReviews, type PullReview } from "../api";
import { REVIEW_STATE, reviewMessage } from "../state/format";
import { Markdown } from "./Markdown";

const STATE_COLOR: Record<PullReview["state"], string> = { APPROVED: "text-done-text", CHANGES_REQUESTED: "text-failed", COMMENTED: "text-text-secondary" };
const REVIEW_MARKDOWN = "text-[13px] leading-relaxed [overflow-wrap:anywhere] [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-sm [&_h4]:text-sm [&_h5]:text-sm [&_h6]:text-sm [&_table]:text-xs [&_code]:text-xs";

type Load = { kind: "loading" } | { kind: "ready"; reviews: PullReview[] } | { kind: "error"; message: string };

/**
 * Reviews of the pull request this Code session opened, read from GitHub when the panel opens and on Refresh.
 * The human picks which ones to hand over (the newest by default) and the agent gets them as one message.
 */
export function PullReviews({ pr, status, send }: { pr: number; status: Status; send: (f: ClientFrame) => boolean }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const [round, setRound] = useState(0);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let current = true;
    setLoad({ kind: "loading" });
    getPullReviews(pr).then(
      (reviews) => {
        if (!current) return;
        setLoad({ kind: "ready", reviews });
        setPicked(new Set(reviews.slice(0, 1).map((r) => r.id)));
      },
      (e: Error) => current && setLoad({ kind: "error", message: e.message }),
    );
    return () => {
      current = false;
    };
  }, [pr, round]);

  const reviews = load.kind === "ready" ? load.reviews : [];
  const chosen = reviews.filter((r) => picked.has(r.id));
  const ask = () => setOffline(!send({ type: "message", text: reviewMessage(pr, chosen, MAX_TASK_CHARS) }));
  const toggle = (id: number) => setPicked((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));

  return (
    <div aria-label="Review comments" role="region" className="mt-3">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-semibold">Review comments</span>
        <button type="button" disabled={load.kind === "loading"} onClick={() => setRound(round + 1)} className="cursor-pointer text-text-secondary hover:text-text disabled:cursor-default disabled:opacity-40">
          Refresh
        </button>
      </div>
      {load.kind === "loading" && <div className="mt-1.5 text-xs text-text-secondary">Loading reviews</div>}
      {load.kind === "error" && <div className="mt-1.5 text-xs text-failed">{load.message}</div>}
      {load.kind === "ready" && reviews.length === 0 && <div className="mt-1.5 text-xs text-text-secondary">No reviews yet.</div>}
      {reviews.length > 0 && (
        <>
          <ul className="m-0 mt-2 flex max-h-[min(28rem,50vh)] list-none flex-col gap-2 overflow-y-auto p-0.5">
            {reviews.map((r) => (
              <li key={r.id} data-review={r.id} className="min-w-0 shrink-0 rounded-lg bg-white p-2.5 text-xs shadow-[0_0_0_1px_rgba(0,0,0,0.06)]">
                <div className="flex items-start justify-between gap-2">
                  <label className="flex min-w-0 cursor-pointer items-start gap-2">
                    <input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(r.id)} className="mt-0.5 shrink-0 accent-accent" />
                    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="font-semibold [overflow-wrap:anywhere]">{r.author}</span>
                      <span className={STATE_COLOR[r.state]}>{REVIEW_STATE[r.state]}</span>
                    </span>
                  </label>
                  <a href={r.url} target="_blank" rel="noreferrer" className="shrink-0 text-accent-text">
                    GitHub
                  </a>
                </div>
                {r.body.trim() && (
                  <div className="mt-2">
                    <Markdown text={r.body} className={REVIEW_MARKDOWN} />
                  </div>
                )}
                {r.comments.map((c, i) => (
                  <div key={i} className="mt-3 border-l-2 border-black/10 pl-2">
                    <div className="mb-1 font-mono text-[11px] text-text-secondary [overflow-wrap:anywhere]">{`${c.path}${c.line !== null ? `:${c.line}` : ""}`}</div>
                    <Markdown text={c.body} className={REVIEW_MARKDOWN} />
                  </div>
                ))}
              </li>
            ))}
          </ul>
          <button type="button" disabled={chosen.length === 0 || status === "running"} onClick={ask} className="press mt-2.5 h-9 w-full cursor-pointer rounded-[10px] bg-black/6 text-[13px] font-semibold disabled:cursor-default disabled:opacity-40">
            {chosen.length > 1 ? `Ask &run to address ${chosen.length} reviews` : "Ask &run to address this"}
          </button>
          {offline && (
            <div role="alert" className="mt-2 text-xs text-failed">
              Not connected. Try again in a moment.
            </div>
          )}
        </>
      )}
    </div>
  );
}
