import { useState } from "react";
import type { Status } from "../../../src/core/events";
import { MAX_PR_SUMMARY_CHARS, MAX_PR_TITLE_CHARS, type ClientFrame } from "../../../src/session/protocol";
import { planNote, prTarget } from "../state/format";
import { markSending, type GateView, type SessionView } from "../state/reducer";
import { PencilIcon, PullRequestIcon } from "./Icons";
import { Markdown } from "./Markdown";
import { PullReviews } from "./PullReviews";
import { SectionTitle } from "./SectionTitle";
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
  const [open, setOpen] = useState(true);
  // A closed pull request's session takes nothing more (A26), so it offers no approval.
  const gate = view.gate?.tool === "finish" && status === "awaiting_approval" && !session.closed ? view.gate : null;
  const target = prTarget(view.pr?.branch, session.id, session.baseBranch);

  if (gate) return <FinishGate key={gate.approvalId} gate={gate} view={view} session={session} target={target} send={send} update={update} />;

  if (!session.code) return null;
  const pr = view.pr;
  const canAsk = status === "awaiting_input" && view.changes.length > 0 && !session.closed;
  if (!pr && !canAsk) return null;
  return (
    <section aria-label="Pull request" className="mb-5">
      <SectionTitle icon={<PullRequestIcon />} title="Pull request" toggle={{ open, onClick: () => setOpen(!open) }} />
      <div hidden={!open} className="rounded-xl bg-sidebar p-3">
        {pr ? (
          <>
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="font-semibold">{pr.number !== undefined ? `#${pr.number}` : "Opened"}</span>
              <a href={pr.url} target="_blank" rel="noreferrer" className="text-accent-text">
                View on GitHub
              </a>
            </div>
            <div className={`mt-1 font-mono break-all ${SMALL}`}>{target}</div>
            {pr.number !== undefined && !session.closed && <PullReviews pr={pr.number} status={status} send={send} />}
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

const FIELD = "w-full rounded-lg bg-black/5 p-2 text-[13px] leading-5 text-text transition-[background-color,box-shadow] focus:bg-white focus:shadow-[0_0_0_1px_rgba(0,0,0,0.2)] motion-reduce:transition-none";

/**
 * The finish approval. In Code it shows the pull request's title and description, which the human can edit
 * (Edit toggles the fields) before approving; the edits replace what the agent wrote.
 */
function FinishGate({ gate, view, session, target, send, update }: { gate: GateView; view: SessionView; session: SessionInfo; target: string; send: (f: ClientFrame) => boolean; update: (fn: (v: SessionView) => SessionView) => void }) {
  const [offline, setOffline] = useState(false);
  const agentTitle = gate.title ?? session.title ?? "";
  const agentSummary = gate.summary ?? "";
  const [title, setTitle] = useState(agentTitle);
  const [summary, setSummary] = useState(agentSummary);
  const [editing, setEditing] = useState(false);
  const note = planNote(view.plan);
  const edited = title.trim() !== agentTitle.trim() || summary.trim() !== agentSummary.trim();

  const approve = () => {
    const sent = send({
      type: "approve",
      approvalId: gate.approvalId,
      ...(session.code && title.trim() && title.trim() !== agentTitle.trim() && { title: title.trim() }),
      // An emptied description is sent too: the pull request then has none of the agent's text.
      ...(session.code && summary.trim() !== agentSummary.trim() && { summary: summary.trim() }),
    });
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
      <SectionTitle icon={<PullRequestIcon />} title={session.code ? "Pull request" : "Finish"} />
      <div className="rounded-xl bg-warning-bg p-3">
        <div className="text-xs font-semibold text-accent-text">Approval required</div>
        <div className={`mt-0.5 ${SMALL}`}>{session.code ? "The agent is done. Approve to open a pull request." : "The agent is done. Approve to finish."}</div>
        {session.code && (
          <div data-pr-description className="mt-2.5 rounded-lg bg-white p-2.5">
            <div className="flex items-center gap-2">
              <span className="grow text-[11px] font-semibold tracking-wide text-text-secondary uppercase">{edited && !editing ? "Description · edited" : "Description"}</span>
              <button type="button" aria-expanded={editing} onClick={() => setEditing(!editing)} className="press flex cursor-pointer items-center gap-1 rounded-full bg-fill px-2.5 py-0.5 text-xs font-medium">
                {editing ? "Done" : <><PencilIcon />Edit</>}
              </button>
            </div>
            {editing ? (
              <div className="mt-2 flex flex-col gap-2">
                <label className="sr-only" htmlFor="pr-title">Pull request title</label>
                <input id="pr-title" value={title} maxLength={MAX_PR_TITLE_CHARS} placeholder={agentTitle || "Title"} onChange={(e) => setTitle(e.target.value)} className={`${FIELD} font-semibold`} />
                <label className="sr-only" htmlFor="pr-summary">Pull request description</label>
                <textarea id="pr-summary" rows={8} value={summary} maxLength={MAX_PR_SUMMARY_CHARS} placeholder="What changed, how it was checked, what is open" onChange={(e) => setSummary(e.target.value)} className={`${FIELD} resize-y`} />
                {edited && (
                  <button type="button" onClick={() => { setTitle(agentTitle); setSummary(agentSummary); }} className="self-start cursor-pointer text-xs text-text-secondary hover:text-text">
                    Reset to the agent's text
                  </button>
                )}
              </div>
            ) : (
              <>
                <div className="mt-1.5 text-[13px] font-semibold break-words">{title.trim() || agentTitle}</div>
                {summary.trim() ? (
                  <div className="mt-1 max-h-40 overflow-y-auto">
                    <Markdown text={summary.trim()} className="text-xs leading-relaxed" />
                  </div>
                ) : (
                  <div className="mt-1 text-xs text-text-secondary">No description.</div>
                )}
              </>
            )}
          </div>
        )}
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
