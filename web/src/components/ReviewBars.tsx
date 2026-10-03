import { useState } from "react";
import type { ReviewVerdict } from "../../../src/core/events";
import type { ClientFrame } from "../../../src/session/protocol";
import { useApp } from "../context";
import { markSending, type GateView, type SessionView } from "../state/reducer";
import { Spinner } from "./Spinner";

const VERDICTS: { value: ReviewVerdict; label: string; hint: string }[] = [
  { value: "COMMENT", label: "Comment", hint: "Leaves the findings as comments" },
  { value: "APPROVE", label: "Approve", hint: "Approves the pull request" },
  { value: "REQUEST_CHANGES", label: "Request changes", hint: "Asks the author to fix these before merging" },
];

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The review's finish gate: says what will be posted and as whom, and takes the verdict. */
export function PostBar({ view, gate, send, update }: { view: SessionView; gate: GateView; send: (f: ClientFrame) => boolean; update: (fn: (v: SessionView) => SessionView) => void }) {
  const { config } = useApp();
  const [verdict, setVerdict] = useState<ReviewVerdict>("COMMENT");
  const [comment, setComment] = useState("");
  const [offline, setOffline] = useState(false);
  const text = comment.trim();
  const sending = view.sending;
  const kept = view.findings.filter((f) => !f.dismissed);
  const inline = kept.filter((f) => f.inline).length;

  const fire = (frame: ClientFrame) => {
    const sent = send(frame);
    setOffline(!sent);
    if (sent) update(markSending);
  };
  const post = () => fire({ type: "post_review", approvalId: gate.approvalId, verdict });
  const reject = () => text && fire({ type: "reject", approvalId: gate.approvalId, comment: text });

  return (
    <form
      aria-label="Post review"
      className="pointer-events-auto rounded-2xl border border-black/10 bg-white/80 p-4 shadow-lg backdrop-blur-xl"
      onSubmit={(e) => {
        e.preventDefault();
        if (!sending) reject();
      }}
    >
      <div className="flex items-baseline gap-2 text-[13px]">
        <span className="font-semibold">{`${plural(inline, "inline comment")}, ${plural(kept.length - inline, "note")} in the summary`}</span>
        <span className="grow" />
        <span className="shrink-0 text-xs text-text-secondary">Posts to GitHub as {config.repo.split("/")[0]}</span>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <div role="radiogroup" aria-label="Verdict" className="flex items-center gap-4">
          {VERDICTS.map((v) => (
            <label key={v.value} className="flex cursor-pointer items-center gap-1.5">
              <input type="radio" name="verdict" value={v.value} checked={verdict === v.value} onChange={() => setVerdict(v.value)} className="accent-accent" />
              {v.label}
            </label>
          ))}
        </div>
        <span className="min-w-0 grow truncate text-xs text-text-secondary">{VERDICTS.find((v) => v.value === verdict)!.hint}</span>
        <button type="button" disabled={sending} onClick={post} className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-accent px-3.5 py-1.5 text-[13px] font-medium text-white disabled:cursor-default disabled:opacity-60">
          {sending ? (
            <>
              <Spinner />
              Sending
            </>
          ) : (
            "Post review"
          )}
        </button>
      </div>
      {(view.refused || offline) && (
        <div role="alert" className="mt-2 text-xs text-failed">
          {view.refused ?? "Not connected. Try again in a moment."}
        </div>
      )}
      <div className="mt-3 flex items-center gap-2">
        <input
          aria-label="Comment for the agent"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Ask the agent for another look instead"
          className="h-9 min-w-0 grow rounded-[10px] bg-black/5 px-3 text-[14px] transition-[background-color,box-shadow] focus:bg-white focus:shadow-[0_0_0_1px_rgba(0,0,0,0.2)]"
        />
        <button type="submit" disabled={sending || !text} className="shrink-0 rounded-full bg-fill px-3.5 py-1.5 text-[13px] font-medium disabled:opacity-40">
          Send
        </button>
      </div>
    </form>
  );
}

/** After the review was posted the session is closed: the composer is off and a new review starts from the pull request. */
export function PostedBar({ pr }: { pr: number | null }) {
  return (
    <div className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-black/10 bg-white/80 px-4 py-2.5 shadow-lg backdrop-blur-xl">
      <span className="text-[13px] text-text-secondary">This review was posted.</span>
      <form aria-label="Message the agent" className="contents" onSubmit={(e) => e.preventDefault()}>
        <input aria-label="Message to the agent" disabled className="sr-only" />
      </form>
      <span className="grow" />
      <a href={pr === null ? "/prs" : `/prs/${pr}`} className="rounded-full bg-accent px-3.5 py-1.5 text-[13px] font-medium text-white">
        Review again
      </a>
    </div>
  );
}
