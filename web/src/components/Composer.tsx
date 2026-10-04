import { useState } from "react";
import type { ClientFrame } from "../../../src/session/protocol";
import { addPending, type SessionView } from "../state/reducer";

const BAR = "pointer-events-auto flex items-center gap-3 rounded-2xl border border-black/10 bg-white/80 px-4 py-2.5 shadow-lg backdrop-blur-xl";

export function Composer({ view, running, send, update }: { view: SessionView; running: boolean; send: (f: ClientFrame) => boolean; update: (fn: (v: SessionView) => SessionView) => void }) {
  const [text, setText] = useState("");
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    if (!send({ type: "message", text: t })) return;
    if (running) update((v) => addPending(v, t));
    setText("");
  };
  return (
    <form
      aria-label="Message the agent"
      className={BAR}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        aria-label="Message to the agent"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={running ? "Redirect the agent" : "Send a message to continue"}
        className="h-9 min-w-0 grow rounded-[10px] bg-black/5 px-3 text-[14px] transition-[background-color,box-shadow] focus:bg-white focus:shadow-[0_0_0_1px_rgba(0,0,0,0.2)]"
      />
      {view.pr?.number !== undefined && !running && <span className="shrink-0 text-xs text-text-tertiary">Adds a commit to pull request #{view.pr.number}</span>}
      {running && <span className="shrink-0 text-xs text-text-tertiary">Added at the next step</span>}
      {view.refused && (
        <span role="alert" className="shrink-0 text-xs text-failed">
          {view.refused}
        </span>
      )}
      <button type="submit" disabled={!text.trim()} className="h-9 shrink-0 cursor-pointer rounded-[10px] bg-black/6 px-4 text-[13px] font-semibold text-text disabled:cursor-default disabled:bg-black/4 disabled:text-text-tertiary">
        Send
      </button>
    </form>
  );
}
