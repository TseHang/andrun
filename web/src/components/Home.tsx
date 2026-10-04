import { useState } from "react";
import type { SessionSummary } from "../../../src/session/protocol";
import { createSession } from "../api";
import { useApp } from "../context";
import { relativeTime } from "../state/format";
import { Spinner } from "./Spinner";
import { ModelMenu } from "./ModelMenu";
import { DOT, STATUS_TEXT } from "./StatusLabel";

export function Home({ sessions }: { sessions: SessionSummary[] }) {
  const { config, navigate, refreshList } = useApp();
  const [task, setTask] = useState("");
  const [model, setModel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canRun = task.trim() !== "" && !busy;

  const run = async () => {
    if (!canRun) return;
    setBusy(true);
    setError(null);
    const res = await createSession(task, model ?? config.defaultModel);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    refreshList();
    navigate(`/s/${res.id}`);
  };

  return (
    <main className="flex min-w-0 grow flex-col items-center gap-14 overflow-y-auto px-12 pb-10 pt-[132px]">
      <div className="flex w-[720px] flex-col gap-5">
        <h1 className="m-0 text-[30px] font-bold leading-[1.15] tracking-[-0.022em]">What do you want to run?</h1>
        <div className="relative z-[2] flex flex-col gap-2.5 rounded-2xl bg-white py-3.5 pl-4 pr-3 pb-3 shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_2px_6px_rgba(0,0,0,0.04),0_12px_32px_rgba(0,0,0,0.07)] transition-shadow focus-within:shadow-[0_0_0_1px_rgba(0,0,0,0.2),0_2px_6px_rgba(0,0,0,0.05),0_12px_32px_rgba(0,0,0,0.1)]">
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
              <a href="/prs" className="flex h-7 items-center rounded-[7px] px-3.5">
                Review
              </a>
              <button type="button" aria-pressed="false" disabled title="Not available yet" className="h-7 rounded-[7px] px-3.5 text-text-tertiary">
                Task
              </button>
            </div>
            <ModelMenu models={config.models} current={model ?? config.defaultModel} onPick={setModel} />
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
        <div className="flex items-center gap-1.5 px-1 text-xs text-text-secondary">
          <span className="font-mono text-[11px]">{config.repo}</span>
          <span>{config.sha ? `at ${config.sha.slice(0, 7)}` : "latest commit on the default branch"}</span>
          <span className="grow" />
          <span>Runs in a sandbox with no network access</span>
        </div>
      </div>

      {sessions.length > 0 && (
        <section aria-label="Recent sessions" className="flex w-[720px] flex-col">
          <div className="px-1 pb-2 text-xs font-semibold text-text-secondary">Recent</div>
          {sessions.map((s) => (
            <a key={s.id} href={`/s/${s.id}`} className="flex h-11 items-center gap-3 border-t border-black/8 px-1">
              {s.status === "running" ? <Spinner size={8} /> : <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${DOT[s.status]}`} />}
              <span className="min-w-0 grow truncate text-sm">{s.title}</span>
              <span className={`text-xs ${s.status === "awaiting_approval" ? "text-accent-text" : s.status === "failed" || s.status === "budget_exceeded" ? "text-failed" : "text-text-secondary"}`}>{STATUS_TEXT[s.status]}</span>
              <span className="w-8 text-right text-xs text-text-tertiary">{relativeTime(s.updated_at, Date.now())}</span>
            </a>
          ))}
        </section>
      )}
    </main>
  );
}
