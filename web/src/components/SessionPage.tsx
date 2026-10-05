import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SessionSnapshot } from "../../../src/session/protocol";
import { UUID, deleteSession, getSnapshot } from "../api";
import { useApp } from "../context";
import { useSession } from "../socket";
import { ApprovalBar } from "./ApprovalBar";
import { changeTotals, isDeliverable } from "../state/format";
import { usePanelHidden } from "../state/hidden";
import { ChangesPanel } from "./ChangesPanel";
import { ClosedBar, Composer } from "./Composer";
import { DeleteDialog } from "./DeleteDialog";
import { FileCards } from "./FileCards";
import { Enter, isLive } from "./Enter";
import { QuestionCard } from "./QuestionCard";
import { PostBar } from "./ReviewBars";
import { ReviewBody } from "./ReviewSession";
import { SessionHeader } from "./SessionHeader";
import { Spinner } from "./Spinner";
import { Timeline } from "./Timeline";

function Notice({ title }: { title: string }) {
  return (
    <main className="flex min-w-0 grow flex-col items-center justify-center gap-3">
      <div className="text-[15px] font-semibold">{title}</div>
      <a href="/" className="text-accent-text">
        Back to Home
      </a>
    </main>
  );
}

export function SessionPage({ id }: { id: string }) {
  if (!UUID.test(id)) return <Notice title="Session not found" />;
  return <Loader key={id} id={id} />;
}

function Loader({ id }: { id: string }) {
  const [snap, setSnap] = useState<SessionSnapshot | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  const reload = useCallback(() => {
    getSnapshot(id).then(
      (s) => {
        setSnap(s);
        setFailed(false);
      },
      () => setFailed(true),
    );
  }, [id]);

  useEffect(() => {
    reload();
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);

  if (snap === null) return <Notice title="Session not found" />;
  if (snap === undefined) return failed ? <Notice title="Could not load this session" /> : <main className="grow" />;
  return <Live id={id} snap={snap} reload={reload} />;
}

function Live({ id, snap, reload }: { id: string; snap: SessionSnapshot; reload: () => void }) {
  const { navigate, refreshList, refreshPulls, reportStatus } = useApp();
  const { view, send, update, reconnecting, deleted } = useSession(id);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [changesHidden, setChangesHidden, changesReopened] = usePanelHidden("andrun.changes.hidden");
  const [error, setError] = useState<string | null>(null);
  // An HTML file shown in the side panel's place, until Back.
  const [preview, setPreview] = useState<string | null>(null);
  const openPreview = (path: string) => {
    setChangesHidden(false);
    setPreview(path);
  };
  // Hiding the panel also closes a preview, so showing it again lands on the details.
  const togglePanel = () => {
    if (!changesHidden) setPreview(null);
    setChangesHidden(!changesHidden);
  };
  const showDetails = () => {
    setPreview(null);
    setChangesHidden(false);
  };
  const more = useRef<HTMLButtonElement>(null);
  const status = view.status ?? snap.status;
  const review = snap.mode === "review";
  // Merged or closed on GitHub: nothing more is sent from here (A26). A run that is still going keeps its Stop button.
  const closedPr = snap.pr && snap.pr.state !== "open" ? { number: snap.pr.number, state: snap.pr.state } : null;
  const closed = closedPr !== null && status !== "running" ? closedPr : null;
  const session = { id, title: snap.title, code: snap.mode === "code", baseBranch: snap.baseBranch, pr: snap.pr?.number ?? null, closed: closed !== null, review };

  // Re-read the snapshot (sandboxRunning) and the list after each status change.
  const first = useRef(true);
  useEffect(() => {
    reportStatus(id, status);
    if (first.current) return void (first.current = false);
    reload();
    refreshList();
  }, [status]);
  useEffect(() => () => reportStatus(id, null), [id]);

  // The server refuses a frame once the pull request is merged or closed: the snapshot says so, and so does the list.
  useEffect(() => {
    if (view.refused) reload();
  }, [view.refused]);
  useEffect(() => {
    if (closedPr) refreshList();
  }, [closedPr?.state]);

  // A pull request opened or a review posted here changes the Pull requests list and its count.
  const published = view.items.filter((i) => i.kind === "pr" || i.kind === "review_posted").length;
  useEffect(() => {
    if (published > 0) refreshPulls();
  }, [published]);

  // The sandbox comes up while the run starts: re-read the snapshot whenever a setup step finishes.
  const setups = view.items.reduce((n, i) => n + (i.kind === "steps" ? i.rows.filter((r) => r.name === "sandbox_setup" && r.done).length : 0), 0);
  const seen = useRef(setups);
  useEffect(() => {
    if (seen.current === setups) return;
    seen.current = setups;
    reload();
  }, [setups]);

  // The sandbox stops a little after the run ends: look again until it has.
  useEffect(() => {
    if (!snap.sandboxRunning || status === "running" || status === "awaiting_approval") return;
    let tries = 0;
    const t = setInterval(() => {
      if (++tries > 15) return clearInterval(t);
      reload();
    }, 2000);
    return () => clearInterval(t);
  }, [snap.sandboxRunning, status]);

  // The timeline and the panels (anything in the page) keep their last lines clear of the floating bar, whatever its height (plan card, long summary).
  const bar = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = bar.current;
    const row = el?.closest("main");
    if (!el || !row) return;
    const measure = () => row.style.setProperty("--bar-h", `${el.offsetHeight}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const close = useCallback(() => {
    setConfirming(false);
    setError(null);
    more.current?.focus();
  }, []);

  const confirm = async () => {
    setBusy(true);
    const res = await deleteSession(id);
    setBusy(false);
    if (res === "limited") return setError("Too many requests. Try again in 60 seconds.");
    if (res === "failed") return setError("Could not delete the session.");
    refreshList();
    navigate("/");
  };

  const live = isLive(view);
  // The agent asks to finish: the approval is in the side panel, and a message asks for changes instead.
  const finishing = !review && !closed && view.gate?.tool === "finish" && status === "awaiting_approval";
  const barEl = (
    <div ref={bar} data-slot="floating-bar" className="pointer-events-none absolute bottom-5 left-7 right-5">
      {closed ? (
        <Enter key="closed" live={live} motion="enter-bar">
          <ClosedBar pr={closed} />
        </Enter>
      ) : view.gate && status === "awaiting_approval" && (review || view.gate.tool !== "finish") ? (
        <Enter key={`gate:${view.gate.approvalId}`} live={live} motion="enter-bar">
          {review && view.gate.tool === "finish" ? (
            <PostBar view={view} gate={view.gate} send={send} update={update} />
          ) : (
            <ApprovalBar view={view} gate={view.gate} send={send} update={update} />
          )}
        </Enter>
      ) : !review && view.question && status === "awaiting_input" ? (
        <Enter key={`question:${view.question.id}`} live={live} motion="enter-bar">
          <QuestionCard view={view} question={view.question} send={send} />
        </Enter>
      ) : (
        <Enter key="composer" live={live} motion="enter-bar">
          <Composer view={view} running={status === "running"} waiting={status === "awaiting_input"} finishing={finishing} send={send} update={update} />
        </Enter>
      )}
    </div>
  );

  if (deleted) return <Notice title="This session was deleted" />;

  return (
    <main className="flex min-h-0 min-w-0 grow flex-col">
      {reconnecting && (
        <div role="status" className="flex h-7 shrink-0 items-center justify-center gap-2 bg-fill text-xs text-text-secondary">
          <Spinner />
          Reconnecting
        </div>
      )}
      <SessionHeader
        title={snap.title}
        status={status}
        prState={closedPr?.state}
        header={view.header}
        review={review}
        onDelete={() => setConfirming(true)}
        moreRef={more}
        panel={review ? undefined : { hidden: changesHidden, noun: snap.mode === "task" ? "files" : "changes", count: snap.mode === "task" ? view.changes.filter((c) => isDeliverable(c.path)).length : changeTotals(view.changes).files, onToggle: () => togglePanel() }}
      />
      <div className="relative flex min-h-0 grow">
        {review ? (
          <ReviewBody view={view} status={closed && status === "awaiting_approval" ? "done" : status} session={session} pr={snap.pr?.number ?? null} send={send} bar={barEl} />
        ) : (
          <>
            {/* The composer floats over the conversation only, as in a review: the side panel keeps its full height. */}
            <div className="relative flex min-h-0 min-w-0 grow">
              <Timeline view={view} session={session} after={snap.mode === "task" && status !== "running" && <FileCards changes={view.changes} onOpen={openPreview} />} />
              {barEl}
              {finishing && (changesHidden || preview !== null) && (
                <div className="pointer-events-none absolute top-3 right-5 z-10">
                  {/* The approval waits in the hidden panel, or behind the preview: the way back says so. */}
                  <button type="button" onClick={showDetails} className="press pointer-events-auto cursor-pointer rounded-full bg-accent px-3 py-1 text-xs font-medium text-white">
                    {snap.mode === "task" ? "Approve to finish" : "Open pull request"}
                  </button>
                </div>
              )}
            </div>
            {!changesHidden && (
              <ChangesPanel
                motion={changesReopened ? "side-in" : ""}
                session={session}
                status={status}
                send={send}
                update={update}
                mode={snap.mode}
                view={view}
                sandboxRunning={snap.sandboxRunning}
                sha={snap.sha}
                preview={preview}
                onPreview={setPreview}
              />
            )}
          </>
        )}
      </div>
      {confirming && <DeleteDialog busy={busy} error={error} onCancel={close} onConfirm={() => void confirm()} />}
    </main>
  );
}
