import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Status } from "../../../src/core/events";
import type { ClientFrame } from "../../../src/session/protocol";
import { getPull, type PullDetail } from "../api";
import { usePanelHidden } from "../state/hidden";
import type { SessionView } from "../state/reducer";
import { Findings } from "./Findings";
import type { Jump } from "./PatchView";
import { PullOverview } from "./PullOverview";
import { ReviewFilesPanel } from "./ReviewFilesPanel";
import { Timeline, type SessionInfo } from "./Timeline";

type Diff = { kind: "loading" } | { kind: "ready"; pull: PullDetail } | { kind: "error"; message: string };

/** The review's body: the pull request, the agent's activity and the findings in one column, the files on the right. `bar` sits under the column. */
export function ReviewBody({ view, status, session, pr, send, bar }: { view: SessionView; status: Status; session: SessionInfo; pr: number | null; send: (f: ClientFrame) => boolean; bar: ReactNode }) {
  const [hidden, setHidden] = usePanelHidden("andrun.review.files.hidden");
  const [jump, setJump] = useState<Jump | null>(null);
  const [diff, setDiff] = useState<Diff>({ kind: "loading" });

  useEffect(() => {
    if (pr === null) return setDiff({ kind: "error", message: "No pull request for this review." });
    let current = true;
    getPull(pr).then(
      (r) => current && setDiff(r === "not_found" ? { kind: "error", message: "Pull request not found." } : { kind: "ready", pull: r }),
      (e: Error) => current && setDiff({ kind: "error", message: e.message }),
    );
    return () => {
      current = false;
    };
  }, [pr]);

  const kept = useMemo(() => view.findings.filter((f) => !f.dismissed), [view.findings]);
  const pull = diff.kind === "ready" ? diff.pull : null;

  return (
    <>
      <div className="relative flex min-h-0 min-w-0 grow flex-col">
        <Timeline
          view={view}
          session={session}
          before={pull && <div className="mb-4"><PullOverview pull={pull} defaultOpen={false} /></div>}
          after={
            <Findings
              view={view}
              status={status}
              send={send}
              onJump={(path, line) => {
                setHidden(false);
                setJump({ path, line, nonce: Date.now() });
              }}
            />
          }
        />
        {bar}
      </div>
      {hidden ? (
        <div className="pointer-events-none absolute top-3 right-5 z-10">
          <button type="button" onClick={() => setHidden(false)} className="pointer-events-auto cursor-pointer rounded-full bg-fill px-3 py-1 text-xs font-medium">
            {pull ? `Show files · ${pull.files.length}` : "Show files"}
          </button>
        </div>
      ) : (
        <ReviewFilesPanel
          pull={pull}
          findings={kept}
          jump={jump}
          notice={diff.kind === "loading" ? "Loading the diff" : diff.kind === "error" ? diff.message : undefined}
          onHide={() => {
            setJump(null);
            setHidden(true);
          }}
        />
      )}
    </>
  );
}
