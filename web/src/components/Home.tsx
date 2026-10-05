import { useEffect, useState } from "react";
import { createSession, defaultChoice, getRepoBranch, type ModelChoice } from "../api";
import { useApp } from "../context";
import { TASK_FORMAT_NOTE } from "../state/format";
import { BranchIcon } from "./Icons";
import { Spinner } from "./Spinner";
import { ModelMenu } from "./ModelMenu";

/** Run's shortcut as this platform writes it: the handler takes ⌘ or Ctrl. */
const RUN_SHORTCUT = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘↵" : "Ctrl ↵";

/** Home: one question and the composer, nothing else; recent sessions live in the sidebar. */
export function Home() {
  const { config, navigate, refreshList } = useApp();
  // The branch a Code run starts from: the pinned commit, or the default branch's name once GitHub says it.
  const [branch, setBranch] = useState<string | null>(null);
  useEffect(() => {
    if (config.sha) return;
    let current = true;
    void getRepoBranch().then((b) => current && setBranch(b));
    return () => {
      current = false;
    };
  }, [config.sha]);
  const [mode, setMode] = useState<"code" | "task">("code");
  const [task, setTask] = useState("");
  const [choice, setChoice] = useState<ModelChoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Labels that change with the mode come into focus only after a switch, never on load.
  const [switched, setSwitched] = useState(false);
  const swap = switched ? "swap" : "";
  const pick = (m: "code" | "task") => {
    if (m === mode) return;
    setMode(m);
    setSwitched(true);
  };
  const canRun = task.trim() !== "" && !busy;

  const run = async () => {
    if (!canRun) return;
    setBusy(true);
    setError(null);
    const res = await createSession(task, choice ?? defaultChoice(config), mode);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    refreshList();
    navigate(`/s/${res.id}`);
  };

  return (
    <main className="flex min-w-0 grow flex-col items-center justify-center overflow-y-auto px-12 pt-10 pb-[14vh]">
      <div className="flex w-[720px] flex-col gap-5">
        <h1 key={`title:${mode}`} className={`m-0 text-[30px] font-bold leading-[1.15] tracking-[-0.022em] ${swap}`}>{mode === "task" ? "What do you want to run?" : <>What do you want to run in <span className="text-accent">{config.repo.split("/").pop()}</span>?</>}</h1>
        <div className="relative z-[2] flex flex-col gap-2.5 rounded-2xl bg-white py-3.5 pl-4 pr-3 pb-3 shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_2px_6px_rgba(0,0,0,0.04),0_12px_32px_rgba(0,0,0,0.07)] transition-shadow duration-200 ease-out hover:shadow-[0_0_0_1px_rgba(0,0,0,0.2),0_2px_6px_rgba(0,0,0,0.05),0_12px_32px_rgba(0,0,0,0.09)] focus-within:shadow-[0_0_0_1px_rgba(0,0,0,0.2),0_2px_6px_rgba(0,0,0,0.05),0_12px_32px_rgba(0,0,0,0.09)] motion-reduce:transition-none">
          {/* The row stays in both modes, so the box keeps its height when the mode changes. */}
          <div key={mode} className={`-ml-4 -mr-3 flex items-center gap-1.5 border-b border-black/8 pb-2.5 pl-4 pr-3 text-[13px] ${swap}`}>
            {mode === "code" ? (
              <>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="shrink-0 text-text-secondary">
                  <path d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 010-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1h-8a1 1 0 00-1 1v6.708A2.486 2.486 0 014.5 9h8V1.5zM5 12.25v3.25a.25.25 0 00.4.2l1.45-1.087a.25.25 0 01.3 0L8.6 15.7a.25.25 0 00.4-.2v-3.25a.25.25 0 00-.25-.25h-3.5a.25.25 0 00-.25.25z" />
                </svg>
                <a href={`https://github.com/${config.repo}`} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                  {config.repo}
                </a>
                {config.sha ? (
                  <span className="text-text-secondary">{`at ${config.sha.slice(0, 7)}`}</span>
                ) : (
                  branch && (
                    <span data-branch className="ml-1.5 flex items-center gap-1 text-text-secondary">
                      <BranchIcon />
                      <span className="font-mono text-xs">{branch}</span>
                    </span>
                  )
                )}
              </>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true" className="shrink-0 text-text-secondary">
                  <circle cx="8" cy="8" r="6.25" />
                  <path d="M1.75 8h12.5M8 1.75c1.7 1.8 2.5 3.9 2.5 6.25S9.7 12.45 8 14.25C6.3 12.45 5.5 10.35 5.5 8S6.3 3.55 8 1.75z" />
                </svg>
                <span className="font-medium">Empty sandbox</span>
                <span className="text-text-secondary">no repository, reads the web</span>
              </>
            )}
          </div>
          <label htmlFor="task" className="sr-only">
            Task
          </label>
          <textarea
            id="task"
            rows={3}
            autoFocus
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
            <div role="group" aria-label="Mode" className="relative grid grid-cols-2 rounded-[9px] bg-fill p-0.5">
              {/* One white pill that slides to the picked mode. */}
              <span
                aria-hidden="true"
                className={`absolute inset-y-0.5 left-0.5 w-[calc(50%-2px)] rounded-[7px] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.14),0_0_0_0.5px_rgba(0,0,0,0.04)] transition-transform duration-200 ease-out motion-reduce:transition-none ${mode === "task" ? "translate-x-full" : ""}`}
              />
              {(["code", "task"] as const).map((m) => (
                <button key={m} type="button" aria-pressed={mode === m} onClick={() => pick(m)} className={`relative h-7 cursor-pointer rounded-[7px] px-3.5 transition-colors duration-200 ${mode === m ? "font-semibold" : "text-text-secondary"}`}>
                  {m === "code" ? "Code" : "Task"}
                </button>
              ))}
            </div>
            <ModelMenu models={config.models} autoModel={config.autoModel} current={choice ?? defaultChoice(config)} onPick={setChoice} />
            <span className="grow" />
            <button
              type="button"
              disabled={!canRun}
              onClick={() => void run()}
              className={`press flex h-8 cursor-pointer items-center gap-1.5 rounded-full bg-accent px-[18px] text-sm font-semibold text-white disabled:cursor-default ${busy ? "" : "disabled:opacity-40"}`}
            >
              {busy && <Spinner />}
              Run
              {!busy && (
                <span aria-hidden="true" className="text-xs font-medium text-white/75">
                  {RUN_SHORTCUT}
                </span>
              )}
            </button>
          </div>
        </div>
        {error && (
          <div role="alert" className="rounded-lg bg-danger-bg px-3 py-2 text-danger-text">
            {error}
          </div>
        )}
        {mode === "task" ? (
          <div key="note:task" className={`space-y-1 px-1 text-xs text-text-secondary ${swap}`}>
            <div>Runs in an empty sandbox that can read the web (GET only)</div>
            <div>{TASK_FORMAT_NOTE}</div>
          </div>
        ) : <div key="note:code" className={`px-1 text-xs text-text-secondary ${swap}`}>Runs in a sandbox with no network access</div>}
      </div>

    </main>
  );
}
