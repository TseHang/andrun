import { useEffect, useMemo, useState } from "react";
import type { Status } from "../../../src/core/events";
import type { ClientFrame } from "../../../src/session/protocol";
import { getPull, type PullDetail } from "../api";
import type { SessionView } from "../state/reducer";
import { FindingsPanel } from "./FindingsPanel";
import { FileDiff } from "./PatchView";
import { Timeline, type SessionInfo } from "./Timeline";

type Tab = "activity" | "files";
type Diff = { kind: "loading" } | { kind: "ready"; pull: PullDetail } | { kind: "error"; message: string };

const TABS: { id: Tab; label: string }[] = [
  { id: "activity", label: "Activity" },
  { id: "files", label: "Files changed" },
];

/** The review's body: the agent's activity or the diff on the left, the findings on the right. */
export function ReviewBody({ view, status, session, pr, send }: { view: SessionView; status: Status; session: SessionInfo; pr: number | null; send: (f: ClientFrame) => boolean }) {
  const [tab, setTab] = useState<Tab>("activity");
  const [jump, setJump] = useState<{ key: string } | null>(null);
  const [diff, setDiff] = useState<Diff>({ kind: "loading" });

  // What a post did (the review card, or GitHub's refusal) is in the timeline: show it.
  const outcomes = view.items.filter((i) => i.kind === "review_posted" || (i.kind === "failure" && i.source === "github")).length;
  useEffect(() => {
    if (outcomes > 0) setTab("activity");
  }, [outcomes]);

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

  // The jump waits for the tab and the diff to be on screen.
  useEffect(() => {
    if (!jump || tab !== "files" || diff.kind !== "ready") return;
    document.querySelector(`[data-line="${CSS.escape(jump.key)}"]`)?.scrollIntoView({ block: "center" });
    setJump(null);
  }, [jump, tab, diff]);

  const kept = useMemo(() => view.findings.filter((f) => !f.dismissed), [view.findings]);

  return (
    <>
      <div className="flex min-h-0 min-w-0 grow flex-col">
        <div className="flex shrink-0 px-7 pt-3">
          <div role="tablist" aria-label="View" className="flex rounded-[9px] bg-fill p-0.5">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={`h-7 cursor-pointer rounded-[7px] px-3.5 ${tab === t.id ? "bg-white font-semibold shadow-[0_1px_2px_rgba(0,0,0,0.14),0_0_0_0.5px_rgba(0,0,0,0.04)]" : ""}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        {tab === "activity" ? (
          <Timeline view={view} session={session} />
        ) : (
          <div className="flex min-h-0 grow flex-col gap-3.5 overflow-y-auto py-4 pb-44 pl-7 pr-5">
            {diff.kind === "loading" && <span className="text-text-secondary">Loading the diff</span>}
            {diff.kind === "error" && <span className="text-text-secondary">{diff.message}</span>}
            {diff.kind === "ready" && diff.pull.files.map((f) => <FileDiff key={f.path} file={f} findings={kept} />)}
          </div>
        )}
      </div>
      <FindingsPanel
        view={view}
        status={status}
        send={send}
        onJump={(path, line) => {
          setTab("files");
          setJump({ key: `${path}:${line}` });
        }}
      />
    </>
  );
}
