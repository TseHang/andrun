import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Status } from "../../../src/core/events";
import type { ClientFrame } from "../../../src/session/protocol";
import { getPull, type PullDetail } from "../api";
import type { SessionView } from "../state/reducer";
import { Findings } from "./Findings";
import type { Jump } from "./PatchView";
import { PullOverview } from "./PullOverview";
import { ReviewFilesPanel } from "./ReviewFilesPanel";
import { Timeline, type SessionInfo } from "./Timeline";

export type Diff = { kind: "loading" } | { kind: "ready"; pull: PullDetail } | { kind: "error"; message: string };

/** The reviewed pull request with its diff, read once per number. */
export function usePull(pr: number | null): Diff {
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
  return diff;
}

/**
 * The review's body: the pull request, the agent's activity and the findings in one column, the files on the right. `bar` sits under the column.
 * The page owns the files panel's visibility (its toggle is in the header); a jump to a finding shows it.
 */
export function ReviewBody({ view, status, session, diff, send, bar, files }: { view: SessionView; status: Status; session: SessionInfo; diff: Diff; send: (f: ClientFrame) => boolean; bar: ReactNode; files: { hidden: boolean; reopened: boolean; show: () => void } }) {
  const [jump, setJump] = useState<Jump | null>(null);
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
                files.show();
                setJump({ path, line, nonce: Date.now() });
              }}
            />
          }
        />
        {bar}
      </div>
      {!files.hidden && (
        <ReviewFilesPanel
          motion={files.reopened ? "side-in" : ""}
          pull={pull}
          findings={kept}
          jump={jump}
          notice={diff.kind === "loading" ? "Loading the diff" : diff.kind === "error" ? diff.message : undefined}
        />
      )}
    </>
  );
}
