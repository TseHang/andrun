import { useState } from "react";
import type { ClientFrame } from "../../../src/session/protocol";
import { addPending, type SessionView } from "../state/reducer";

const BAR = "pointer-events-auto mx-auto flex max-w-[860px] items-center gap-3 rounded-2xl border border-black/10 bg-white/80 px-4 py-2.5 shadow-lg backdrop-blur-xl";

export function Composer({ view, running, send, update }: { view: SessionView; running: boolean; send: (f: ClientFrame) => boolean; update: (fn: (v: SessionView) => SessionView) => void }) {
  const [text, setText] = useState("");
  if (!view.composerEnabled) {
    return (
      <div className={BAR}>
        <span className="grow text-[13px] text-text-secondary">Limit reached. Start a new session to continue.</span>
        <form aria-label="Message the agent" className="contents" onSubmit={(e) => e.preventDefault()}>
          <input aria-label="Message to the agent" disabled className="sr-only" />
          <button type="submit" disabled className="sr-only">Send</button>
        </form>
        <a href="/" className="rounded-full bg-accent px-3.5 py-1.5 text-[13px] font-medium text-white">New session</a>
      </div>
    );
  }
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
        className="min-w-0 grow bg-transparent py-1 text-[14px] outline-none"
      />
      {running && <span className="shrink-0 text-xs text-text-tertiary">Added at the next step</span>}
      <button type="submit" disabled={!text.trim()} className="shrink-0 rounded-full bg-accent px-3.5 py-1.5 text-[13px] font-medium text-white disabled:opacity-40">
        Send
      </button>
    </form>
  );
}
