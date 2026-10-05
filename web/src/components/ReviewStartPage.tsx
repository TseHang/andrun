import { useEffect, useState } from "react";
import { getPull, type PullDetail } from "../api";
import { usePanelHidden } from "../state/hidden";
import { AuthorAvatar, authorName } from "./Author";
import { PullOverview } from "./PullOverview";
import { ReviewCard } from "./ReviewCard";
import { ReviewFilesPanel } from "./ReviewFilesPanel";
import { PanelToggle } from "./SessionHeader";
import { Spinner } from "./Spinner";

type Load = { kind: "loading" } | { kind: "ready"; pull: PullDetail } | { kind: "not_found" } | { kind: "error"; message: string };

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

  if (load.kind === "loading") {
    return (
      <main className="flex min-w-0 grow items-center justify-center">
        <div role="status" className="flex items-center gap-2 text-text-secondary">
          <Spinner />
          Loading pull request
        </div>
      </main>
    );
  }
  if (load.kind === "not_found") {
    return (
      <Centered>
        <div className="text-[15px] font-semibold">Pull request not found.</div>
        <a href="/prs" className="text-accent-text">
          Back to Review PRs
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
  const [hidden, setHidden, reopened] = usePanelHidden("andrun.review.files.hidden");
  return (
    <main className="flex min-h-0 min-w-0 grow flex-col">
      <header className="flex h-[60px] shrink-0 items-center gap-3.5 border-b border-black/8 pl-7 pr-5">
        {/* Who opened it, before what it is called. */}
        <span title={authorName(pull)} className="flex shrink-0">
          <AuthorAvatar pull={pull} />
        </span>
        <h1 className="m-0 min-w-0 grow truncate text-[15px] font-semibold tracking-[-0.01em]">
          <span className="sr-only">{`${authorName(pull)}: `}</span>
          {pull.title} <span className="font-normal text-text-secondary">#{pull.number}</span>
        </h1>
        <a href={pull.url} target="_blank" rel="noreferrer" className="shrink-0 text-accent-text">
          View on GitHub
        </a>
        <PanelToggle hidden={hidden} noun="files" count={pull.files.length} onToggle={() => setHidden(!hidden)} />
      </header>
      <div className="relative flex min-h-0 grow">
        <div className="min-w-0 grow overflow-y-auto">
          <div className="mx-auto flex max-w-[720px] flex-col gap-5 px-6 py-5">
            <PullOverview pull={pull} />
            <ReviewCard pull={pull} />
          </div>
        </div>
        {!hidden && <ReviewFilesPanel motion={reopened ? "side-in" : ""} pull={pull} findings={[]} />}
      </div>
    </main>
  );
}
