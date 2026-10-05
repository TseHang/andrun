import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ReviewVerdict } from "../../../src/core/events";
import { EMPTY_REVIEW, MAX_REVIEW_COMMENT_CHARS, type ClientFrame } from "../../../src/session/protocol";
import { useApp } from "../context";
import { markSending, type GateView, type SessionView } from "../state/reducer";
import { Spinner } from "./Spinner";
import { ChatInput } from "./ChatInput";

const ICON = { width: 14, height: 14, viewBox: "0 0 14 14", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, className: "shrink-0" } as const;

const VERDICTS: { value: ReviewVerdict; label: string; button: string; text: string; bg: string; icon: ReactNode }[] = [
  {
    value: "COMMENT",
    label: "Comment",
    button: "Post comments",
    text: "text-text",
    bg: "bg-accent",
    icon: (
      <svg {...ICON}>
        <path d="M2 2.5h10v7H6.5L4 12V9.5H2z" />
      </svg>
    ),
  },
  {
    value: "APPROVE",
    label: "Approve",
    button: "Approve",
    text: "text-done-text",
    bg: "bg-done",
    icon: (
      <svg {...ICON}>
        <path d="m2.5 7.5 3 3 6-7" />
      </svg>
    ),
  },
  {
    value: "REQUEST_CHANGES",
    label: "Request changes",
    button: "Request changes",
    text: "text-failed",
    bg: "bg-failed",
    icon: (
      <svg {...ICON}>
        <circle cx="7" cy="7" r="5.5" />
        <path d="m5 5 4 4M9 5 5 9" />
      </svg>
    ),
  },
];

// A secondary action: small, but plainly a button.
const LINK = "press cursor-pointer rounded-full bg-fill px-2.5 py-1 text-xs font-medium text-text hover:bg-black/8";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The review's finish gate: says what will be posted and as whom, and takes the verdict. */
export function PostBar({ view, gate, send, update }: { view: SessionView; gate: GateView; send: (f: ClientFrame) => boolean; update: (fn: (v: SessionView) => SessionView) => void }) {
  const { config } = useApp();
  const [verdict, setVerdict] = useState<ReviewVerdict>("COMMENT");
  const [asking, setAsking] = useState(false);
  const [comment, setComment] = useState("");
  const [body, setBody] = useState("");
  const [offline, setOffline] = useState(false);
  const radios = useRef<(HTMLButtonElement | null)[]>([]);
  const input = useRef<HTMLTextAreaElement>(null);
  const text = comment.trim();
  const sending = view.sending;
  const kept = view.findings.filter((f) => !f.dismissed && !f.posted);
  const inline = kept.filter((f) => f.inline).length;
  const current = VERDICTS.find((v) => v.value === verdict)!;
  const summary = gate.summary?.trim() ?? "";
  // GitHub refuses a Comment or Request changes review that says nothing.
  const empty = verdict !== "APPROVE" && !body.trim() && kept.length === 0;

  useEffect(() => {
    if (asking) input.current?.focus();
  }, [asking]);

  const fire = (frame: ClientFrame) => {
    const sent = send(frame);
    setOffline(!sent);
    if (sent) update(markSending);
  };
  const post = () => fire({ type: "post_review", approvalId: gate.approvalId, verdict, ...(body.trim() && { comment: body.trim() }) });
  const reject = () => text && fire({ type: "reject", approvalId: gate.approvalId, comment: text });

  const move = (e: KeyboardEvent) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (VERDICTS.findIndex((v) => v.value === verdict) + step + VERDICTS.length) % VERDICTS.length;
    setVerdict(VERDICTS[next]!.value);
    radios.current[next]?.focus();
  };

  return (
    <form
      aria-label="Post review"
      className="pointer-events-auto rounded-2xl border border-black/10 bg-white/80 p-4 shadow-lg backdrop-blur-xl"
      onSubmit={(e) => {
        e.preventDefault();
        if (!sending) reject();
      }}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
        <span className="font-semibold">{`${plural(inline, "inline comment")}, ${plural(kept.length - inline, "note")} in the summary`}</span>
        <span className="grow" />
        <span className="shrink-0 text-xs text-text-secondary">Posts to GitHub as {config.repo.split("/")[0]}</span>
      </div>
      <textarea
        aria-label="Review comment"
        rows={2}
        maxLength={MAX_REVIEW_COMMENT_CHARS}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Leave a comment"
        className="mt-3 block max-h-40 min-h-9 w-full resize-y rounded-[10px] bg-black/5 px-3 py-2 text-[14px] leading-5 transition-[background-color,box-shadow] focus:bg-white focus:shadow-[0_0_0_1px_rgba(0,0,0,0.2)]"
      />
      {summary && !body.includes(summary) && (
        <button type="button" onClick={() => setBody((body.trim() ? `${body.trim()}\n\n${summary}` : summary).slice(0, MAX_REVIEW_COMMENT_CHARS))} className={`mt-2 ${LINK}`}>
          Use &run's summary
        </button>
      )}
      <div role="radiogroup" aria-label="Verdict" data-verdict={verdict} onKeyDown={move} className="mt-3 flex rounded-[9px] bg-fill p-0.5">
        {VERDICTS.map((v, i) => (
          <button
            key={v.value}
            ref={(el) => {
              radios.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={verdict === v.value}
            tabIndex={verdict === v.value ? 0 : -1}
            onClick={() => setVerdict(v.value)}
            className={`flex h-7 min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-[7px] px-2 whitespace-nowrap transition-colors motion-reduce:transition-none ${verdict === v.value ? `bg-white font-semibold shadow-[0_1px_2px_rgba(0,0,0,0.14),0_0_0_0.5px_rgba(0,0,0,0.04)] ${v.text}` : "text-text-secondary"}`}
          >
            {v.icon}
            {v.label}
          </button>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button type="button" aria-expanded={asking} onClick={() => setAsking(!asking)} className={LINK}>
          Ask &run for another look
        </button>
        <span className="grow" />
        <button type="button" disabled={sending || empty} onClick={post} className={`press flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] font-medium text-white disabled:cursor-default disabled:opacity-60 ${current.bg}`}>
          {sending ? (
            <>
              <Spinner />
              Sending
            </>
          ) : (
            current.button
          )}
        </button>
      </div>
      {empty && <div className="mt-2 text-right text-xs text-text-secondary">{EMPTY_REVIEW}</div>}
      {(view.refused || offline) && (
        <div role="alert" className="mt-2 text-xs text-failed">
          {view.refused ?? "Not connected. Try again in a moment."}
        </div>
      )}
      {asking && (
        <div className="mt-3 flex items-end gap-2">
          <ChatInput
            ref={input}
            aria-label="Comment for the agent"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Ask the agent for another look instead"
            className="min-w-0 grow"
          />
          <button type="submit" disabled={sending || !text} className="press shrink-0 rounded-full bg-fill px-3.5 py-1.5 text-[13px] font-medium disabled:opacity-40">
            Send
          </button>
        </div>
      )}
    </form>
  );
}
