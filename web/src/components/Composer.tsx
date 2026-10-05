import { useEffect, useState } from "react";
import type { ClientFrame } from "../../../src/session/protocol";
import { addPending, type SessionView } from "../state/reducer";

/** What "Open pull request" sends: the agent answers by finishing, which asks for approval. */
const OPEN_PR = "Open a pull request for these changes.";
const BAR = "pointer-events-auto rounded-2xl border border-black/10 bg-white/80 px-4 py-2.5 shadow-lg backdrop-blur-xl";

/** In the composer's place once the session's pull request is merged or closed: nothing more can be sent (A26). */
export function ClosedBar({ pr }: { pr: { number: number; state: "merged" | "closed" } }) {
  return (
    <div role="status" className={`${BAR} flex items-center gap-3 text-[13px]`}>
      <span className="min-w-0 grow text-text-secondary">
        Pull request #{pr.number} was {pr.state}. This session is closed.
      </span>
      <a href="/" className="shrink-0 font-semibold text-accent-text">
        New session
      </a>
    </div>
  );
}

export function Composer({ view, running, waiting, code, send, update }: { view: SessionView; running: boolean; waiting: boolean; code: boolean; send: (f: ClientFrame) => boolean; update: (fn: (v: SessionView) => SessionView) => void }) {
  const [text, setText] = useState("");
  // Stop was pressed: it takes effect at the agent's next check, and a second frame would only be refused.
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    if (!running || view.refused) setStopping(false);
  }, [running, view.refused]);
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    if (!send({ type: "message", text: t })) return;
    if (running) update((v) => addPending(v, t));
    setText("");
  };
  // The queue hint shows only once there is something to queue.
  const hint = running ? (text.trim() ? "The agent reads your message after its current step" : null) : view.pr?.number !== undefined ? `Adds a commit to pull request #${view.pr.number}` : null;
  return (
    <form
      aria-label="Message the agent"
      className={BAR}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="flex items-center gap-3">
        <input
          aria-label="Message to the agent"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={running ? "Redirect the agent" : waiting ? "Reply to the agent" : view.posted ? "Ask &run for another look" : "Send a message to continue"}
          className="h-9 min-w-0 grow rounded-[10px] bg-black/5 px-3 text-[14px] transition-[background-color,box-shadow] focus:bg-white focus:shadow-[0_0_0_1px_rgba(0,0,0,0.2)]"
        />
        {waiting && code && view.changes.length > 0 && (
          <button
            type="button"
            onClick={() => void send({ type: "message", text: OPEN_PR })}
            className="h-9 shrink-0 cursor-pointer rounded-[10px] bg-black/6 px-4 text-[13px] font-semibold text-text"
          >
            Open pull request
          </button>
        )}
        {running && (
          <button
            type="button"
            disabled={stopping}
            onClick={() => setStopping(send({ type: "stop" }))}
            className="h-9 shrink-0 cursor-pointer rounded-[10px] bg-black/6 px-4 text-[13px] font-semibold text-text disabled:cursor-default disabled:text-text-tertiary"
          >
            {stopping ? "Stopping" : "Stop"}
          </button>
        )}
        <button type="submit" disabled={!text.trim()} className="h-9 shrink-0 cursor-pointer rounded-[10px] bg-black/6 px-4 text-[13px] font-semibold text-text disabled:cursor-default disabled:bg-black/4 disabled:text-text-tertiary">
          Send
        </button>
      </div>
      {/* Under the input, so a hint never takes the input's width. */}
      {(hint || view.refused) && (
        <div className="mt-1.5 flex flex-wrap gap-x-3 px-1 text-xs">
          {hint && <span className="text-text-tertiary">{hint}</span>}
          {view.refused && (
            <span role="alert" className="text-failed">
              {view.refused}
            </span>
          )}
        </div>
      )}
    </form>
  );
}
