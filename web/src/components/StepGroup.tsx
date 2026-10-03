import { useState } from "react";
import type { StepRow } from "../state/reducer";
import { rowSummary, rowTone } from "../state/format";
import { Spinner } from "./Spinner";

const TONE = { failed: "text-failed", ok: "text-done-text", muted: "text-text-secondary" };

function Row({ row }: { row: StepRow }) {
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? row.expanded;
  const hasBody = row.output.length > 0 || row.error !== undefined;
  const text = row.output.map((c) => c.text).join("");
  return (
    <div data-step-name={row.name}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setToggled(!open)}
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 px-3 py-1.5 text-left font-mono text-xs"
      >
        <span className="shrink-0">{row.name}</span>
        <span className="min-w-0 grow truncate text-text-secondary">{row.arg}</span>
        {row.done ? (
          <span className={`shrink-0 ${TONE[rowTone(row)]}`}>{rowSummary(row)}</span>
        ) : (
          <span className="shrink-0 text-text-secondary">
            <Spinner />
          </span>
        )}
      </button>
      {open && hasBody && (
        <div className="px-3 pb-2">
          {row.output.length > 0 && (
            <pre className="max-h-80 overflow-auto rounded-lg bg-white p-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-words">
              {row.output.some((c) => c.stream === "stderr")
                ? row.output.map((c, i) => (c.stream === "stderr" ? <span key={i} className="text-failed">{c.text}</span> : c.text))
                : text}
            </pre>
          )}
          {row.error !== undefined && <div className="mt-1.5 font-mono text-xs break-words text-failed">{row.error}</div>}
        </div>
      )}
    </div>
  );
}

export function StepGroup({ rows }: { rows: StepRow[] }) {
  return (
    <div className="my-3 divide-y divide-white rounded-xl bg-sidebar py-0.5">
      {rows.map((r) => (
        <Row key={r.callId} row={r} />
      ))}
    </div>
  );
}
