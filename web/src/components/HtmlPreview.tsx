import { useEffect, useState, type ReactNode } from "react";
import { BackIcon, CollapseIcon, ExpandIcon, ReloadIcon } from "./Icons";
import { inlinePreviewScripts } from "../state/preview";

/** An HTML file's content, isolated in a sandboxed frame. `load` reads it; a new `version` (or `nonce`) loads it again. */
export function HtmlPreview({ load, loadFile, path, version, nonce = 0, className = "h-[420px]" }: { load: () => Promise<string | null>; loadFile?: (path: string) => Promise<string | null>; path: string; version: string; nonce?: number; className?: string }) {
  const [content, setContent] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let current = true;
    setContent(undefined);
    load().then((c) => c !== null && loadFile ? inlinePreviewScripts(c, path, loadFile) : c).then(
      (c) => current && setContent(c),
      () => current && setContent(null),
    );
    return () => {
      current = false;
    };
  }, [path, version, nonce]);

  if (content === undefined) return <div className="px-3 py-2.5 text-xs text-text-secondary">Loading preview</div>;
  if (content === null) return <div className="px-3 py-2.5 text-xs text-text-secondary">Preview not available for this file</div>;
  return <iframe title={`Preview of ${path}`} sandbox="allow-scripts" srcDoc={content} className={`block w-full border-0 bg-white ${className}`} />;
}

const TOOL = "press flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-text-secondary hover:bg-black/6";

/**
 * A preview with its own toolbar: back (when it took a panel's place), the file, reload, full screen.
 * Full screen only restyles the same box, so the page in the frame keeps its state. Esc leaves it.
 */
export function PreviewPane({ load, loadFile, path, version, onBack, inline = false }: { load: () => Promise<string | null>; loadFile?: (path: string) => Promise<string | null>; path: string; version: string; onBack?: () => void; inline?: boolean }) {
  const [nonce, setNonce] = useState(0);
  const [full, setFull] = useState(false);

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFull(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [full]);

  const button = (label: string, icon: ReactNode, onClick: () => void) => (
    <button type="button" aria-label={label} title={label} onClick={onClick} className={TOOL}>
      {icon}
    </button>
  );

  return (
    <div
      data-preview={path}
      role={full ? "dialog" : undefined}
      aria-label={full ? `Preview of ${path}` : undefined}
      className={full ? "fixed inset-0 z-40 flex flex-col bg-white" : `flex min-h-0 flex-col ${inline ? "" : "h-full overflow-hidden rounded-xl border border-black/10"}`}
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-black/8 bg-sidebar px-1.5">
        {onBack && !full && button("Back to details", <BackIcon />, onBack)}
        <span className="min-w-0 grow truncate px-1.5 font-mono text-xs font-semibold">{path}</span>
        {button("Reload", <ReloadIcon />, () => setNonce((n) => n + 1))}
        {full ? button("Exit full screen", <CollapseIcon />, () => setFull(false)) : button("Full screen", <ExpandIcon />, () => setFull(true))}
      </div>
      <HtmlPreview load={load} loadFile={loadFile} path={path} version={version} nonce={nonce} className={full || !inline ? "min-h-0 grow" : "h-[60vh]"} />
      <p className="shrink-0 border-t border-black/8 px-3 py-2 text-[11px] text-text-secondary">Local scripts load from saved files or the PR. Module imports, other local assets and browser storage are not supported.</p>
    </div>
  );
}
