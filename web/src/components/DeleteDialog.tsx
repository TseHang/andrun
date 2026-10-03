import { useEffect, useId, useRef } from "react";

interface Props {
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteDialog({ busy, error, onCancel, onConfirm }: Props) {
  const titleId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Tab") {
        // Two buttons: keep focus inside the dialog.
        e.preventDefault();
        (document.activeElement === cancel.current ? confirm : cancel).current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/20">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex w-[340px] flex-col gap-1.5 rounded-[14px] bg-white p-[18px] text-center shadow-[0_0_0_0.5px_rgba(0,0,0,0.14),0_10px_36px_rgba(0,0,0,0.16)]"
      >
        <div id={titleId} className="text-[15px] font-semibold">
          Delete this session?
        </div>
        <div className="text-xs text-[#3a3a3c]">This stops the run and removes the sandbox and history. It cannot be undone.</div>
        {error && (
          <div role="alert" className="mt-1 text-xs text-danger-text">
            {error}
          </div>
        )}
        <div className="mt-3 flex gap-2">
          <button ref={cancel} type="button" onClick={onCancel} className="h-8 grow cursor-pointer rounded-[9px] bg-black/6 font-semibold">
            Cancel
          </button>
          <button ref={confirm} type="button" disabled={busy} onClick={onConfirm} className="h-8 grow cursor-pointer rounded-[9px] bg-danger-bg font-semibold text-danger-text disabled:opacity-50">
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
