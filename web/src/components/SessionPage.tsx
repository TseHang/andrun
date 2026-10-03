import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionSnapshot } from "../../../src/session/protocol";
import { UUID, deleteSession, getSnapshot } from "../api";
import { useApp } from "../context";
import { useSession } from "../socket";
import { ApprovalBar } from "./ApprovalBar";
import { ChangesPanel } from "./ChangesPanel";
import { Composer } from "./Composer";
import { DeleteDialog } from "./DeleteDialog";
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
  const { navigate, refreshList, reportStatus } = useApp();
  const { view, send, update, reconnecting, deleted } = useSession(id);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const more = useRef<HTMLButtonElement>(null);
  const status = view.status ?? snap.status;
  const session = { id, code: snap.mode === "code", baseBranch: snap.baseBranch };

  // Re-read the snapshot (sandboxRunning) and the list after each status change.
  const first = useRef(true);
  useEffect(() => {
    reportStatus(id, status);
    if (first.current) return void (first.current = false);
    reload();
    refreshList();
  }, [status]);
  useEffect(() => () => reportStatus(id, null), [id]);

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

  if (deleted) return <Notice title="This session was deleted" />;

  return (
    <main className="flex min-h-0 min-w-0 grow flex-col">
      {reconnecting && (
        <div role="status" className="flex h-7 shrink-0 items-center justify-center gap-2 bg-fill text-xs text-text-secondary">
          <Spinner />
          Reconnecting
        </div>
      )}
      <SessionHeader title={snap.title} status={status} header={view.header} onDelete={() => setConfirming(true)} moreRef={more} />
      <div className="relative flex min-h-0 grow">
        <Timeline view={view} session={session} />
        <ChangesPanel view={view} sandboxRunning={snap.sandboxRunning} sha={snap.sha} />
        <div data-slot="floating-bar" className="pointer-events-none absolute bottom-5 left-7 right-5">
          {view.gate && status === "awaiting_approval" ? (
            <ApprovalBar view={view} gate={view.gate} session={session} send={send} update={update} />
          ) : (
            <Composer view={view} running={status === "running"} send={send} update={update} />
          )}
        </div>
      </div>
      {confirming && <DeleteDialog busy={busy} error={error} onCancel={close} onConfirm={() => void confirm()} />}
    </main>
  );
}
