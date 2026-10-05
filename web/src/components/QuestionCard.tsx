import { useState } from "react";
import type { ClientFrame } from "../../../src/session/protocol";
import type { SessionView } from "../state/reducer";

type Question = NonNullable<SessionView["question"]>;

export function QuestionCard({ view, question, send }: { view: SessionView; question: Question; send: (f: ClientFrame) => boolean }) {
  const [answer, setAnswer] = useState("");
  const [offline, setOffline] = useState(false);
  const [sent, setSent] = useState(false);
  const text = answer.trim();
  // A refused answer can be sent again.
  const locked = sent && !view.refused;

  // The card goes away when the user message arrives, so a sent answer stays disabled until then.
  const reply = (t: string) => {
    if (locked || !t) return;
    const ok = send({ type: "message", text: t });
    setOffline(!ok);
    if (ok) setSent(true);
  };

  return (
    <form
      aria-label="Question from the agent"
      className="pointer-events-auto rounded-2xl border border-black/10 bg-white/80 p-4 shadow-lg backdrop-blur-xl"
      onSubmit={(e) => {
        e.preventDefault();
        reply(text);
      }}
    >
      <div className="min-w-0 text-[14px] font-semibold break-words whitespace-pre-wrap">{question.question}</div>
      <div className="mt-3 flex flex-col gap-2">
        {question.options.map((o) => (
          <button
            key={o.label}
            type="button"
            data-option
            disabled={locked}
            onClick={() => reply(o.label)}
            className="press flex w-full min-w-0 flex-col items-start rounded-[10px] bg-black/5 px-3 py-2 text-left disabled:opacity-60"
          >
            <span className="min-w-0 text-[13px] font-medium break-words">{o.label}</span>
            {o.description && <span className="min-w-0 text-xs break-words text-text-secondary">{o.description}</span>}
          </button>
        ))}
      </div>
      {(view.refused || offline) && (
        <div role="alert" className="mt-2 text-xs text-failed">
          {view.refused ?? "Not connected. Try again in a moment."}
        </div>
      )}
      <div className="mt-3 flex items-center gap-2">
        <input
          aria-label="Your answer"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="Or type your answer"
          className="h-9 min-w-0 grow rounded-[10px] bg-black/5 px-3 text-[14px] transition-[background-color,box-shadow] focus:bg-white focus:shadow-[0_0_0_1px_rgba(0,0,0,0.2)]"
        />
        <button type="submit" disabled={!text || locked} className="press h-9 shrink-0 cursor-pointer rounded-[10px] bg-black/6 px-4 text-[13px] font-semibold text-text disabled:cursor-default disabled:bg-black/4 disabled:text-text-tertiary">
          Send
        </button>
      </div>
    </form>
  );
}
