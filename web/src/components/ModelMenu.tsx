import { useEffect, useRef, useState } from "react";
import { modelLabel } from "../state/format";

interface Props {
  models: { id: string }[];
  current: string;
  onPick: (id: string) => void;
}

export function ModelMenu({ models, current, onPick }: Props) {
  const [open, setOpen] = useState(false);
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
        <span>{modelLabel(current)}</span>
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
              aria-selected={m.id === current}
              onClick={() => {
                onPick(m.id);
                setOpen(false);
                button.current?.focus();
              }}
              className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-left hover:bg-black/6"
            >
              <span className="flex size-3 shrink-0">
                {m.id === current && (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M2.5 6.5L5 9l4.5-5.5" />
                  </svg>
                )}
              </span>
              <span>{modelLabel(m.id)}</span>
            </button>
          ))}
          <div role="separator" className="mx-2 my-[5px] h-px bg-black/10" />
          <button type="button" role="option" aria-selected="false" disabled className="flex h-7 items-center justify-between rounded-md pl-[26px] pr-2 text-left text-text-tertiary">
            <span>Auto</span>
            <span className="text-[11px]">Not available yet</span>
          </button>
        </div>
      )}
    </div>
  );
}
