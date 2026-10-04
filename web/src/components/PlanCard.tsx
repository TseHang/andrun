import type { PlanStep } from "../../../src/core/events";
import { Spinner } from "./Spinner";

const LABEL = { completed: "completed", in_progress: "in progress", pending: "pending" } as const;

function Marker({ status }: { status: PlanStep["status"] }) {
  if (status === "completed") return <span aria-hidden="true" className="w-3 shrink-0 text-center text-done-text">✓</span>;
  if (status === "in_progress") return <span className="flex w-3 shrink-0 justify-center text-accent-text"><Spinner /></span>;
  return <span aria-hidden="true" className="mt-[3px] size-2.5 shrink-0 rounded-full border border-text-tertiary" />;
}

export function PlanCard({ plan }: { plan: PlanStep[] }) {
  const done = plan.filter((s) => s.status === "completed").length;
  return (
    <section aria-label="Plan" className="mb-4 rounded-xl bg-sidebar px-3 py-2.5">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-[13px] font-semibold">Plan</h2>
        <span className="text-xs text-text-secondary">{done} of {plan.length} done</span>
      </div>
      <ol className="flex flex-col gap-1.5">
        {plan.map((s, i) => (
          <li key={i} data-plan-status={s.status} className={`flex items-start gap-2 text-xs ${s.status === "completed" ? "text-text-secondary" : s.status === "in_progress" ? "font-medium" : ""}`}>
            <Marker status={s.status} />
            <span className="min-w-0 break-words">
              {s.step}
              <span className="sr-only"> ({LABEL[s.status]})</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
