import { useEffect, useState } from "react";
import { getFile } from "../api";

/** An HTML file's saved content, isolated in a sandboxed frame. `version` is the diff: a new one reloads it. */
export function HtmlPreview({ sessionId, path, version }: { sessionId: string; path: string; version: string }) {
  const [content, setContent] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let current = true;
    getFile(sessionId, path).then(
      (c) => current && setContent(c),
      () => current && setContent(null),
    );
    return () => {
      current = false;
    };
  }, [sessionId, path, version]);

  if (content === undefined) return <div className="px-3 py-2.5 text-xs text-text-secondary">Loading preview</div>;
  if (content === null) return <div className="px-3 py-2.5 text-xs text-text-secondary">Preview not available for this file</div>;
  return <iframe title={`Preview of ${path}`} sandbox="allow-scripts" srcDoc={content} className="block h-[420px] w-full border-0 bg-white" />;
}
