import { useState } from "react";
import type { SessionSummary } from "../../../src/session/protocol";
import { createSession, defaultChoice, type ModelChoice } from "../api";
import { useApp } from "../context";
import { relativeTime } from "../state/format";
import { Spinner } from "./Spinner";
import { ModelMenu } from "./ModelMenu";
import { DOT, STATUS_TEXT } from "./StatusLabel";

export function Home({ sessions }: { sessions: SessionSummary[] }) {
  const { config, navigate, refreshList } = useApp();
  const [task, setTask] = useState("");
  const [choice, setChoice] = useState<ModelChoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canRun = task.trim() !== "" && !busy;

  const run = async () => {
    if (!canRun) return;
    setBusy(true);
    setError(null);
    const res = await createSession(task, choice ?? defaultChoice(config));
    setBusy(false);
    if (!res.ok) return setError(res.error);
    refreshList();
    navigate(`/s/${res.id}`);
  };

  return (
    <main className="flex min-w-0 grow flex-col items-center gap-14 overflow-y-auto px-12 pb-10 pt-[132px]">
      <div className="flex w-[720px] flex-col gap-5">
        <h1 className="m-0 text-[30px] font-bold leading-[1.15] tracking-[-0.022em]">What do you want to run in <span className="text-accent">{config.repo.split("/").pop()}</span>?</h1>
        <div className="relative z-[2] flex flex-col gap-2.5 rounded-2xl bg-white py-3.5 pl-4 pr-3 pb-3 shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_2px_6px_rgba(0,0,0,0.04),0_12px_32px_rgba(0,0,0,0.07)] transition-shadow focus-within:shadow-[0_0_0_1px_rgba(0,0,0,0.2),0_2px_6px_rgba(0,0,0,0.05),0_12px_32px_rgba(0,0,0,0.1)]">
          <div className="-ml-4 -mr-3 flex items-center gap-1.5 border-b border-black/8 pb-2.5 pl-4 pr-3 text-[13px]">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="shrink-0 text-text-secondary">
              <path d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 010-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1h-8a1 1 0 00-1 1v6.708A2.486 2.486 0 014.5 9h8V1.5zM5 12.25v3.25a.25.25 0 00.4.2l1.45-1.087a.25.25 0 01.3 0L8.6 15.7a.25.25 0 00.4-.2v-3.25a.25.25 0 00-.25-.25h-3.5a.25.25 0 00-.25.25z" />
            </svg>
            <span className="font-medium">{config.repo}</span>
            <span className="text-text-secondary">{config.sha ? `at ${config.sha.slice(0, 7)}` : "latest commit on the default branch"}</span>
          </div>
          <label htmlFor="task" className="sr-only">
            Task
          </label>
          <textarea
            id="task"
            rows={3}
            maxLength={config.maxTaskChars}
            placeholder="Start your work, ship new feature!"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void run();
              }
            }}
            className="w-full resize-none border-0 bg-transparent p-0 text-base leading-6 outline-none"
          />
          <div className="flex items-center gap-2">
            <div role="group" aria-label="Mode" className="flex rounded-[9px] bg-fill p-0.5">
              <button type="button" aria-pressed="true" className="h-7 cursor-pointer rounded-[7px] bg-white px-3.5 font-semibold shadow-[0_1px_2px_rgba(0,0,0,0.14),0_0_0_0.5px_rgba(0,0,0,0.04)]">
                Code
              </button>
              <button type="button" aria-pressed="false" disabled title="Not available yet" className="h-7 rounded-[7px] px-3.5 text-text-tertiary">
                Task
              </button>
            </div>
            <ModelMenu models={config.models} autoModel={config.autoModel} current={choice ?? defaultChoice(config)} onPick={setChoice} />
            <span className="grow" />
            <button
              type="button"
              disabled={!canRun}
              onClick={() => void run()}
              className="h-8 cursor-pointer rounded-full bg-accent px-[18px] text-sm font-semibold text-white disabled:cursor-default disabled:opacity-40"
            >
              Run
            </button>
          </div>
        </div>
        {error && (
          <div role="alert" className="rounded-lg bg-danger-bg px-3 py-2 text-danger-text">
            {error}
          </div>
        )}
        <div className="px-1 text-xs text-text-secondary">Runs in a sandbox with no network access</div>
      </div>

      {sessions.length > 0 && (
        <section aria-label="Recent sessions" className="flex w-[720px] flex-col">
          <div className="px-1 pb-2 text-xs font-semibold text-text-secondary">Recent</div>
          {sessions.map((s) => (
            <a key={s.id} href={`/s/${s.id}`} className="flex h-11 items-center gap-3 border-t border-black/8 px-1">
              {s.status === "running" ? <Spinner size={8} /> : <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${DOT[s.status]}`} />}
              <span className="min-w-0 grow truncate text-sm">{s.title}</span>
              {s.mode === "review" && <span data-tag="review" className="rounded-full bg-fill px-1.5 text-[11px] text-text-secondary">Review</span>}
              <span className={`text-xs ${s.status === "awaiting_approval" || s.status === "awaiting_input" ? "text-accent-text" : s.status === "failed" || s.status === "budget_exceeded" ? "text-failed" : "text-text-secondary"}`}>{STATUS_TEXT[s.status]}</span>
              <span className="w-8 text-right text-xs text-text-tertiary">{relativeTime(s.updated_at, Date.now())}</span>
            </a>
          ))}
        </section>
      )}
    </main>
  );
}
