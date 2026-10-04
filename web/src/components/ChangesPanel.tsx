import type { SessionView } from "../state/reducer";
import { parseDiff } from "../state/diff";
import { changeTotals } from "../state/format";
import { DiffView } from "./DiffView";
import { PlanCard } from "./PlanCard";

function Card({ change }: { change: SessionView["changes"][number] }) {
  const isNew = change.diff !== null && parseDiff(change.diff).isNew;
  return (
    <div className="mb-3 overflow-hidden rounded-xl border border-black/10">
      <div className="flex items-center gap-2 bg-sidebar px-3 py-2 font-mono text-xs">
        <span className="min-w-0 grow truncate font-semibold">{change.path}</span>
        <span className="shrink-0 text-text-secondary">{isNew ? `new file · +${change.additions}` : `+${change.additions} −${change.deletions}`}</span>
      </div>
      {change.diff === null ? (
        <div className="px-3 py-2.5 text-xs text-text-secondary">Changed by a command. Diff not available.</div>
      ) : (
        <DiffView diff={change.diff} />
      )}
    </div>
  );
}

function InfoRow({ label, children, testId }: { label: string; children: string; testId?: string }) {
  return (
    <div className="flex justify-between gap-3 px-3 py-2 text-xs">
      <span className="text-text-secondary">{label}</span>
      <span data-testid={testId} className="text-right">{children}</span>
    </div>
  );
}

export function ChangesPanel({ view, sandboxRunning, sha }: { view: SessionView; sandboxRunning: boolean; sha: string }) {
  const totals = changeTotals(view.changes);
  const wide = view.changes.length > 0 || view.gate !== null;
  const last = view.lastCommand;
  return (
    <aside
      aria-label="Changes"
      className={`min-h-0 min-w-0 shrink-0 overflow-y-auto border-l border-black/10 px-5 pt-4 pb-44 ${wide ? "w-[min(520px,45%)]" : "w-[400px]"}`}
    >
      {view.plan && <PlanCard plan={view.plan} />}
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-[15px] font-semibold">Changes</h2>
        <span className="text-xs text-text-secondary">
          {totals.files === 0 ? (
            "None yet"
          ) : (
            <>
              {`${totals.files} ${totals.files === 1 ? "file" : "files"} · `}
              <span className="text-done-text">+{totals.additions}</span> <span className="text-failed">−{totals.deletions}</span>
            </>
          )}
        </span>
      </div>
      {view.testPaths.length > 0 && (
        <div className="mb-3 rounded-xl bg-warning-bg p-3 text-xs text-warning-text">
          <div className="font-semibold">This change edits a test</div>
          <div className="mt-1 font-mono break-words">{view.testPaths.join(", ")}</div>
        </div>
      )}
      {view.changes.length === 0 ? (
        <div className="mb-4 rounded-xl bg-sidebar px-4 py-8 text-center">
          <div className="text-[13px] font-semibold">No changes yet</div>
          <div className="mt-1 text-xs text-text-secondary">Diffs appear here as the agent edits files.</div>
        </div>
      ) : (
        view.changes.map((c) => <Card key={c.path} change={c} />)
      )}
      {last && (
        <div className="mb-4 text-xs break-words text-text-secondary">
          Last command: <code className="font-mono text-text">{last.command}</code> ·{" "}
          <span className={last.exitCode === 0 ? "text-done-text" : "text-failed"}>exit {last.exitCode === null ? "timed out" : last.exitCode}</span>
        </div>
      )}
      <div className="divide-y divide-white rounded-xl bg-sidebar">
        <InfoRow label="Sandbox" testId="sandbox-state">{sandboxRunning ? "Running" : "Stopped · starts again with your next message"}</InfoRow>
        <InfoRow label="Network">Off</InfoRow>
        <InfoRow label="Base commit">{sha.slice(0, 7)}</InfoRow>
      </div>
    </aside>
  );
}
