import { useState } from "react";
import type { Status } from "../../../src/core/events";
import type { ClientFrame } from "../../../src/session/protocol";
import { planNote, prTarget } from "../state/format";
import { markSending, type SessionView } from "../state/reducer";
import { Spinner } from "./Spinner";
import type { SessionInfo } from "./Timeline";

/** What "Open pull request" sends: the agent answers by finishing, which asks for approval. */
export const OPEN_PR = "Open a pull request for these changes.";

const SMALL = "text-xs text-text-secondary";

/**
 * The side panel's action: the finish approval (open the pull request, or finish a Task), the button that asks
 * the agent to finish, or the pull request already opened. Asking for changes is a message in the composer.
 */
export function PullRequestSection({ view, status, session, send, update }: { view: SessionView; status: Status; session: SessionInfo; send: (f: ClientFrame) => boolean; update: (fn: (v: SessionView) => SessionView) => void }) {
  const [offline, setOffline] = useState(false);
  const gate = view.gate?.tool === "finish" && status === "awaiting_approval" ? view.gate : null;
  const target = prTarget(view.pr?.branch, session.id, session.baseBranch);

  if (gate) {
    const note = planNote(view.plan);
    const approve = () => {
      const sent = send({ type: "approve", approvalId: gate.approvalId });
      setOffline(!sent);
      if (sent) update(markSending);
    };
    return (
      <form
        aria-label="Approval"
        className="mb-5"
        onSubmit={(e) => {
          e.preventDefault();
          approve();
        }}
      >
        <h2 className="mb-2 text-[13px] font-semibold">{session.code ? "Pull request" : "Finish"}</h2>
        <div className="rounded-xl bg-warning-bg p-3">
          <div className="text-xs font-semibold text-accent-text">Approval required</div>
          <div className={`mt-0.5 ${SMALL}`}>{session.code ? "The agent is done. Approve to open a pull request." : "The agent is done. Approve to finish."}</div>
          {session.code && <div className="mt-2 font-mono text-xs break-all">{target}</div>}
          {note && <div className="mt-2 text-xs text-warning-text">{note}</div>}
          {(view.refused || offline) && (
            <div role="alert" className="mt-2 text-xs text-failed">
              {view.refused ?? "Not connected. Try again in a moment."}
            </div>
          )}
          <button type="submit" disabled={view.sending} className="press mt-3 flex h-9 w-full cursor-pointer items-center justify-center gap-1.5 rounded-[10px] bg-accent text-[13px] font-semibold text-white disabled:cursor-default disabled:opacity-60">
            {view.sending ? (
              <>
                <Spinner />
                Sending
              </>
            ) : session.code ? (
              "Approve and open PR"
            ) : (
              gate.primary
            )}
          </button>
          <div className={`mt-2 ${SMALL}`}>Or ask for changes in the message box.</div>
        </div>
      </form>
    );
  }

  if (!session.code) return null;
  const pr = view.pr;
  const canAsk = status === "awaiting_input" && view.changes.length > 0 && !session.closed;
  if (!pr && !canAsk) return null;
  return (
    <section aria-label="Pull request" className="mb-5">
      <h2 className="mb-2 text-[13px] font-semibold">Pull request</h2>
      <div className="rounded-xl bg-sidebar p-3">
        {pr ? (
          <>
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="font-semibold">{pr.number !== undefined ? `#${pr.number}` : "Opened"}</span>
              <a href={pr.url} target="_blank" rel="noreferrer" className="text-accent-text">
                View on GitHub
              </a>
            </div>
            <div className={`mt-1 font-mono break-all ${SMALL}`}>{target}</div>
          </>
        ) : (
          <div className={`font-mono break-all ${SMALL}`}>{target}</div>
        )}
        {canAsk && (
          <>
            <button
              type="button"
              onClick={() => setOffline(!send({ type: "message", text: OPEN_PR }))}
              className="press mt-3 h-9 w-full cursor-pointer rounded-[10px] bg-black/6 text-[13px] font-semibold"
            >
              {pr ? "Update pull request" : "Open pull request"}
            </button>
            {offline && (
              <div role="alert" className="mt-2 text-xs text-failed">
                Not connected. Try again in a moment.
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
