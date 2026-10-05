import { useRef, useState } from "react";
import type { ClientFrame } from "../../../src/session/protocol";
import { planNote, prTarget } from "../state/format";
import { markSending, type GateView, type SessionView } from "../state/reducer";
import { Markdown } from "./Markdown";
import { Spinner } from "./Spinner";
import type { SessionInfo } from "./Timeline";

const FALLBACK: Record<string, string> = { run_command: "Do not run this command.", apply_patch: "Do not apply this patch." };

export function ApprovalBar({ view, gate, session, send, update }: { view: SessionView; gate: GateView; session: SessionInfo; send: (f: ClientFrame) => boolean; update: (fn: (v: SessionView) => SessionView) => void }) {
  const [comment, setComment] = useState("");
  const [offline, setOffline] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const text = comment.trim();
  const finish = gate.tool === "finish";
  const open = gate.callId !== undefined;
  const sending = view.sending;
  const opensPr = finish && session.code;
  const note = finish ? planNote(view.plan) : null;

  const fire = (frame: ClientFrame) => {
    const sent = send(frame);
    setOffline(!sent);
    if (sent) update(markSending);
  };
  const approve = () => fire({ type: "approve", approvalId: gate.approvalId });
  const reject = (c: string) => fire({ type: "reject", approvalId: gate.approvalId, comment: c });
  const secondary = () => {
    if (finish) return text && reject(text);
    if (!open) return text ? reject(text) : input.current?.focus();
    reject(text || FALLBACK[gate.tool] || "Do not run this command.");
  };
  const secondaryDisabled = sending || (finish && !text);

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
        {opensPr && <span className="shrink-0 font-mono text-xs text-text-secondary">{prTarget(view.pr?.branch, session.id, session.baseBranch)}</span>}
      </div>
      {gate.command && <div className="mt-2 rounded-lg bg-sidebar px-2.5 py-1.5 font-mono text-xs break-all">{gate.command}</div>}
      {gate.paths && gate.paths.length > 0 && <div className="mt-2 rounded-lg bg-sidebar px-2.5 py-1.5 font-mono text-xs break-all">{gate.paths.join(", ")}</div>}
      {gate.summary && (
        <div data-slot="summary" className="mt-2 max-h-[30vh] overflow-y-auto">
          <Markdown text={gate.summary} className="text-[13px] leading-normal" />
        </div>
      )}
      {note && <div className="mt-2 text-xs text-warning-text">{note}</div>}
      {(view.refused || offline) && (
        <div role="alert" className="mt-2 text-xs text-failed">
          {view.refused ?? "Not connected. Try again in a moment."}
        </div>
      )}
      <div className="mt-3 flex items-center gap-2">
        <input
          ref={input}
          aria-label="Comment for the agent"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (text && !secondaryDisabled) secondary();
            }
          }}
          placeholder={finish ? "Ask for changes instead" : "Tell the agent what to do instead"}
          className="h-9 min-w-0 grow rounded-[10px] bg-black/5 px-3 text-[14px] transition-[background-color,box-shadow] focus:bg-white focus:shadow-[0_0_0_1px_rgba(0,0,0,0.2)]"
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
            opensPr ? "Approve and open PR" : gate.primary
          )}
        </button>
      </div>
    </form>
  );
}
