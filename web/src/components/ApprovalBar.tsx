import { useRef, useState } from "react";
import type { ClientFrame } from "../../../src/session/protocol";
import { markSending, type GateView, type SessionView } from "../state/reducer";
import { Spinner } from "./Spinner";
import { ChatInput } from "./ChatInput";

const FALLBACK: Record<string, string> = { run_command: "Do not run this command.", apply_patch: "Do not apply this patch." };

/** A gate in the middle of a run (a command, a patch): it blocks the agent, so it sits where the composer was. The finish approval is in the side panel. */
export function ApprovalBar({ view, gate, send, update }: { view: SessionView; gate: GateView; send: (f: ClientFrame) => boolean; update: (fn: (v: SessionView) => SessionView) => void }) {
  const [comment, setComment] = useState("");
  const [offline, setOffline] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const text = comment.trim();
  const open = gate.callId !== undefined;
  const sending = view.sending;

  const fire = (frame: ClientFrame) => {
    const sent = send(frame);
    setOffline(!sent);
    if (sent) update(markSending);
  };
  const approve = () => fire({ type: "approve", approvalId: gate.approvalId });
  const reject = (c: string) => fire({ type: "reject", approvalId: gate.approvalId, comment: c });
  const secondary = () => {
    if (!open) return text ? reject(text) : input.current?.focus();
    reject(text || FALLBACK[gate.tool] || "Do not run this command.");
  };
  const secondaryDisabled = sending;

  return (
    <form
      aria-label="Approval"
      className="pointer-events-auto rounded-2xl border border-black/10 bg-white/80 p-4 shadow-lg backdrop-blur-xl"
      onSubmit={(e) => {
        e.preventDefault();
        if (text && !secondaryDisabled) secondary();
      }}
    >
      <div className="flex items-baseline gap-2 text-[13px]">
        <span className="font-semibold text-accent-text">Approval required · {gate.tool}</span>
        <span className="min-w-0 grow text-text-secondary">{gate.reason}</span>
      </div>
      {gate.command && <div className="mt-2 rounded-lg bg-sidebar px-2.5 py-1.5 font-mono text-xs break-all">{gate.command}</div>}
      {gate.paths && gate.paths.length > 0 && <div className="mt-2 rounded-lg bg-sidebar px-2.5 py-1.5 font-mono text-xs break-all">{gate.paths.join(", ")}</div>}
      {(view.refused || offline) && (
        <div role="alert" className="mt-2 text-xs text-failed">
          {view.refused ?? "Not connected. Try again in a moment."}
        </div>
      )}
      <div className="mt-3 flex items-end gap-2">
        <ChatInput
          ref={input}
          aria-label="Comment for the agent"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Tell the agent what to do instead"
          className="min-w-0 grow"
        />
        <button type="button" disabled={secondaryDisabled} onClick={secondary} className="press shrink-0 rounded-full bg-fill px-3.5 py-1.5 text-[13px] font-medium disabled:opacity-40">
          {gate.secondary}
        </button>
        <button type="button" disabled={sending} onClick={approve} className="press flex shrink-0 items-center gap-1.5 rounded-full bg-accent px-3.5 py-1.5 text-[13px] font-medium text-white disabled:opacity-60">
          {sending ? (
            <>
              <Spinner />
              Sending
            </>
          ) : (
            gate.primary
          )}
        </button>
      </div>
    </form>
  );
}
