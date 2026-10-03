import { useEffect, useState } from "react";
import { createReview, getPull, type PullDetail } from "../api";
import { useApp } from "../context";
import { Spinner } from "./Spinner";
import { FileDiff } from "./PatchView";
import { ModelMenu } from "./ModelMenu";

type Load = { kind: "loading" } | { kind: "ready"; pull: PullDetail } | { kind: "not_found" } | { kind: "error"; message: string };

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

function blockedReason(pull: PullDetail): string | null {
  if (pull.state !== "open") return "This pull request is not open.";
  if (pull.fork) return "Pull requests from forks are not supported.";
  if (pull.changedFiles > pull.files.length) return "Pull requests with more than 100 files are not supported.";
  return null;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <main className="flex min-w-0 grow flex-col items-center justify-center gap-3">{children}</main>;
}

export function ReviewStartPage({ number }: { number: number }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!Number.isSafeInteger(number) || number < 1) return setLoad({ kind: "not_found" });
    let current = true;
    setLoad({ kind: "loading" });
    getPull(number).then(
      (r) => current && setLoad(r === "not_found" ? { kind: "not_found" } : { kind: "ready", pull: r }),
      (e: Error) => current && setLoad({ kind: "error", message: e.message }),
    );
    return () => {
      current = false;
    };
  }, [number, attempt]);

  if (load.kind === "loading") return <main className="grow" />;
  if (load.kind === "not_found") {
    return (
      <Centered>
        <div className="text-[15px] font-semibold">Pull request not found.</div>
        <a href="/prs" className="text-accent-text">
          Back to Pull requests
        </a>
      </Centered>
    );
  }
  if (load.kind === "error") {
    return (
      <Centered>
        <div className="text-[15px] font-semibold">{load.message}</div>
        <button type="button" onClick={() => setAttempt((a) => a + 1)} className="h-8 cursor-pointer rounded-full bg-fill px-[18px] text-sm font-semibold">
          Retry
        </button>
      </Centered>
    );
  }
  return <Start key={load.pull.number} pull={load.pull} />;
}

function Start({ pull }: { pull: PullDetail }) {
  const { config, navigate, refreshList } = useApp();
  const [brief, setBrief] = useState(config.reviewBrief);
  const [model, setModel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const blocked = blockedReason(pull);
  const canStart = brief.trim() !== "" && !busy && !blocked;

  const start = async () => {
    if (!canStart) return;
    setBusy(true);
    setError(null);
    const res = await createReview(pull.number, brief, model ?? config.defaultModel);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    refreshList();
    navigate(`/s/${res.id}`);
  };

  const size = `${plural(pull.changedFiles, "file")}, ${pull.additions} added${pull.deletions > 0 ? `, ${pull.deletions} removed` : ""}`;
  return (
    <main className="flex min-h-0 min-w-0 grow flex-col">
      <header className="flex h-[60px] shrink-0 items-center gap-3.5 border-b border-black/8 pl-7 pr-5">
        <div className="flex min-w-0 grow flex-col gap-px">
          <h1 className="m-0 truncate text-[15px] font-semibold tracking-[-0.01em]">
            {pull.title} <span className="font-normal text-text-secondary">#{pull.number}</span>
          </h1>
          <span className="truncate text-xs text-text-secondary">{`${pull.author} wants to merge ${pull.headRef} into ${pull.baseRef} · ${size} · head ${pull.headSha.slice(0, 7)}`}</span>
        </div>
        <a href={pull.url} target="_blank" rel="noreferrer" className="shrink-0 text-accent-text">
          View on GitHub
        </a>
      </header>
      <div className="flex min-h-0 grow">
        <section aria-label="Files changed" className="flex min-w-0 grow flex-col gap-3.5 overflow-y-auto py-4 pl-7 pr-5">
          {pull.files.map((f) => (
            <FileDiff key={f.path} file={f} />
          ))}
        </section>
        <aside className="flex w-[360px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-black/8 p-5">
          <h2 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">What should the review focus on?</h2>
          <p className="m-0 text-text-secondary">Edit this brief or leave it as it is. You can read the diff on the left first.</p>
          <label htmlFor="brief" className="sr-only">
            Review brief
          </label>
          <textarea
            id="brief"
            rows={10}
            maxLength={config.maxTaskChars}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            className="w-full resize-y rounded-xl bg-black/5 p-3 text-[13px] leading-5 transition-[background-color,box-shadow] focus:bg-white focus:shadow-[0_0_0_1px_rgba(0,0,0,0.2)]"
          />
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setBrief(config.reviewBrief)} className="h-8 cursor-pointer rounded-lg px-2.5 text-text-secondary">
              Reset to default
            </button>
            <span className="grow" />
            <ModelMenu models={config.models} current={model ?? config.defaultModel} onPick={setModel} />
          </div>
          {blocked && <div className="text-text-secondary">{blocked}</div>}
          {error && (
            <div role="alert" className="rounded-lg bg-danger-bg px-3 py-2 text-danger-text">
              {error}
            </div>
          )}
          <button type="button" disabled={!canStart} onClick={() => void start()} className="flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-full bg-accent text-sm font-semibold text-white disabled:cursor-default disabled:opacity-40">
            {busy ? (
              <>
                <Spinner />
                Starting
              </>
            ) : (
              "Start review"
            )}
          </button>
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs text-text-secondary">
            <li>Nothing runs until you press Start review.</li>
            <li>The agent reads the code and runs the tests. It cannot change anything.</li>
            <li>Nothing is posted to GitHub until you choose to post.</li>
          </ul>
        </aside>
      </div>
    </main>
  );
}
