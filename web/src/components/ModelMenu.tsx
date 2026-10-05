import { useEffect, useRef, useState } from "react";
import type { ModelChoice } from "../api";
import { modelLabel } from "../state/format";

interface Props {
  models: { id: string; efforts: string[] }[];
  autoModel: string;
  current: ModelChoice;
  onPick: (choice: ModelChoice) => void;
}

const CHECK = (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.5 6.5L5 9l4.5-5.5" />
  </svg>
);

const INFO = (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
    <circle cx="7" cy="7" r="5.75" />
    <path d="M7 6.25v3.5M7 4.35v.01" />
  </svg>
);

export function ModelMenu({ models, autoModel, current, onPick }: Props) {
  const auto = current.model === autoModel;
  const efforts = models.find((m) => m.id === current.model)?.efforts ?? [];
  const [open, setOpen] = useState(false);
  // What Auto does, opened from the ⓘ beside it.
  const [about, setAbout] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menu.current?.contains(t) || button.current?.contains(t)) return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={button}
        type="button"
        aria-label="Model"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 cursor-pointer items-center gap-1 rounded-lg px-1.5 pl-2.5 text-text-secondary"
      >
        <span>{auto ? "Auto" : modelLabel(current.model)}</span>
        {current.reasoning !== undefined && <span className="text-text-tertiary">{current.reasoning}</span>}
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 4.5l2-2 2 2M4 7.5l2 2 2-2" />
        </svg>
      </button>
      {open && (
        <div
          ref={menu}
          role="listbox"
          aria-label="Model"
          className="absolute left-0 top-9 z-10 flex w-[248px] flex-col rounded-xl bg-white/85 p-[5px] shadow-[0_0_0_0.5px_rgba(0,0,0,0.14),0_10px_36px_rgba(0,0,0,0.18)] backdrop-blur-[30px]"
        >
          {models.map((m) => (
            <button
              key={m.id}
              type="button"
              role="option"
              aria-selected={m.id === current.model}
              onClick={() => onPick({ model: m.id, reasoning: m.efforts.includes(current.reasoning ?? "") ? current.reasoning! : m.efforts[0]! })}
              className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-left hover:bg-black/6"
            >
              <span className="flex size-3 shrink-0">{m.id === current.model && CHECK}</span>
              <span>{modelLabel(m.id)}</span>
            </button>
          ))}
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              role="option"
              aria-selected={auto}
              title="Picks the model and reasoning for each message"
              onClick={() => {
                onPick({ model: autoModel });
                setOpen(false);
                button.current?.focus();
              }}
              className="flex h-7 min-w-0 grow cursor-pointer items-center gap-1.5 rounded-md px-2 text-left hover:bg-black/6"
            >
              <span className="flex size-3 shrink-0">{auto && CHECK}</span>
              <span className="grow">Auto</span>
              <span className="text-[11px] text-text-tertiary">Picks per message</span>
            </button>
            <button type="button" aria-label="About Auto" aria-expanded={about} onClick={() => setAbout(!about)} className={`flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-black/6 ${about ? "text-text" : "text-text-tertiary"}`}>
              {INFO}
            </button>
          </div>
          {about && (
            <p data-testid="auto-about" className="m-0 mx-2 mb-1.5 rounded-md bg-black/4 px-2.5 py-2 text-[11.5px] leading-[1.45] text-text-secondary">
              &run reads each message and picks the model for it: a fast one for everyday coding, a stronger one with deeper reasoning when the work is complex. You get speed where it is enough and depth where it counts, without choosing each time.
            </p>
          )}
          {efforts.length > 0 && (
            <>
              <div role="separator" className="mx-2 my-[5px] h-px bg-black/10" />
              <div className="px-2 pb-1 text-[11px] text-text-tertiary">Reasoning</div>
              <div role="group" aria-label="Reasoning" className="mx-1.5 mb-1 flex rounded-[7px] bg-black/6 p-0.5">
                {efforts.map((e) => (
                  <button
                    key={e}
                    type="button"
                    aria-pressed={e === current.reasoning}
                    onClick={() => onPick({ model: current.model, reasoning: e })}
                    className={`h-6 grow cursor-pointer rounded-[5px] ${e === current.reasoning ? "bg-white font-semibold shadow-[0_1px_2px_rgba(0,0,0,0.14)]" : "text-text-secondary"}`}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
