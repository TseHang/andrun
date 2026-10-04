import { useState } from "react";
import { createReview, defaultChoice, type ModelChoice, type PullDetail } from "../api";
import { useApp } from "../context";
import { Avatar } from "./Avatar";
import { ModelMenu } from "./ModelMenu";
import { Spinner } from "./Spinner";

export function blockedReason(pull: PullDetail): string | null {
  if (pull.state !== "open") return "This pull request is not open.";
  if (pull.fork) return "Pull requests from forks are not supported.";
  if (pull.changedFiles > pull.files.length) return "Pull requests with more than 100 files are not supported.";
  return null;
}

/** &run's review of this pull request: the brief, the model, and the button that starts it. */
export function ReviewCard({ pull }: { pull: PullDetail }) {
  const { config, navigate, refreshList } = useApp();
  const [brief, setBrief] = useState(config.reviewBrief);
  const [choice, setChoice] = useState<ModelChoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const blocked = blockedReason(pull);
  const canStart = brief.trim() !== "" && !busy && !blocked;

  const start = async () => {
    if (!canStart) return;
    setBusy(true);
    setError(null);
    const res = await createReview(pull.number, brief, choice ?? defaultChoice(config));
    setBusy(false);
    if (!res.ok) return setError(res.error);
    refreshList();
    navigate(`/s/${res.id}`);
  };

  return (
    <section aria-label="&run review" className="flex flex-col gap-3 rounded-2xl p-5 shadow-[0_0_0_1px_rgba(0,0,0,0.08)]">
      <div className="flex items-center gap-2.5">
        <Avatar />
        <h2 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">&run reviews this pull request</h2>
      </div>
      <p className="m-0 text-text-secondary">It reads the diff and the code, runs the tests, and drafts findings for you to edit.</p>
      <label htmlFor="brief" className="sr-only">
        Review brief
      </label>
      <textarea
        id="brief"
        rows={8}
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
        <ModelMenu models={config.models} autoModel={config.autoModel} current={choice ?? defaultChoice(config)} onPick={setChoice} />
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
      <p className="m-0 text-xs text-text-secondary">Nothing runs until you press Start review. The agent cannot change anything. Nothing is posted to GitHub until you choose to post.</p>
    </section>
  );
}
