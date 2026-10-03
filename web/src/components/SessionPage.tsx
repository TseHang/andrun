import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionSnapshot } from "../../../src/session/protocol";
import { UUID, deleteSession, getSnapshot } from "../api";
import { useApp } from "../context";
import { useSession } from "../socket";
import { DeleteDialog } from "./DeleteDialog";
import { SessionHeader } from "./SessionHeader";
import { Spinner } from "./Spinner";

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
  const { view, reconnecting, deleted } = useSession(id);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const more = useRef<HTMLButtonElement>(null);
  const status = view.status ?? snap.status;

  // Re-read the snapshot (sandboxRunning) and the list after each status change.
  const first = useRef(true);
  useEffect(() => {
    reportStatus(id, status);
    if (first.current) return void (first.current = false);
    reload();
    refreshList();
  }, [status]);
  useEffect(() => () => reportStatus(id, null), [id]);

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
        <section aria-label="Timeline" className="min-h-0 min-w-0 grow overflow-y-auto" />
        <aside aria-label="Changes" className="min-h-0 shrink-0 overflow-y-auto" />
        <div data-slot="floating-bar" className="pointer-events-none absolute inset-x-0 bottom-0" />
      </div>
      {confirming && <DeleteDialog busy={busy} error={error} onCancel={close} onConfirm={() => void confirm()} />}
    </main>
  );
}
