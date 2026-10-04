import { useEffect, useState } from "react";

/** An HTML file's content, isolated in a sandboxed frame. `load` reads it; a new `version` loads it again. */
export function HtmlPreview({ load, path, version }: { load: () => Promise<string | null>; path: string; version: string }) {
  const [content, setContent] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let current = true;
    load().then(
      (c) => current && setContent(c),
      () => current && setContent(null),
    );
    return () => {
      current = false;
    };
  }, [path, version]);

  if (content === undefined) return <div className="px-3 py-2.5 text-xs text-text-secondary">Loading preview</div>;
  if (content === null) return <div className="px-3 py-2.5 text-xs text-text-secondary">Preview not available for this file</div>;
  return <iframe title={`Preview of ${path}`} sandbox="allow-scripts" srcDoc={content} className="block h-[420px] w-full border-0 bg-white" />;
}
