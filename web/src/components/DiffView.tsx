import { parseDiff } from "../state/diff";

const KIND = {
  add: "bg-diff-add-bg text-diff-add-text",
  del: "bg-diff-del-bg text-diff-del-text",
  context: "",
  hunk: "bg-sidebar text-text-secondary",
};
const SIGN = { add: "+", del: "−", context: " ", hunk: "" };

export function DiffView({ diff }: { diff: string }) {
  const parsed = parseDiff(diff);
  return (
    <div className="overflow-x-auto font-mono text-[11.5px] leading-[1.6]">
      <div className="min-w-max">
        {parsed.lines.map((l, i) => (
          <div key={i} data-diff={l.kind} className={`flex whitespace-pre ${KIND[l.kind]}`}>
            <span className="w-8 shrink-0 pr-1 text-right text-text-tertiary select-none">{l.oldNo ?? ""}</span>
            <span className="w-8 shrink-0 pr-1 text-right text-text-tertiary select-none">{l.newNo ?? ""}</span>
            <span className="w-4 shrink-0 text-center select-none">{SIGN[l.kind]}</span>
            <span>{l.text}</span>
          </div>
        ))}
      </div>
      {parsed.elided && <div className="px-3 py-1.5 text-text-secondary">Diff too large to show in full</div>}
    </div>
  );
}
