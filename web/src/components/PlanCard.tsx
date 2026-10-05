import { useState } from "react";
import type { PlanStep } from "../../../src/core/events";
import { Spinner } from "./Spinner";

const LABEL = { completed: "completed", in_progress: "in progress", pending: "pending" } as const;

/** `active`: the agent is running, so the step in progress is being worked on right now. */
function Marker({ status, active }: { status: PlanStep["status"]; active: boolean }) {
  if (status === "completed") return <span aria-hidden="true" className="w-3 shrink-0 text-center text-done-text">✓</span>;
  if (status === "in_progress" && active) return <span className="flex w-3 shrink-0 justify-center text-accent-text"><Spinner /></span>;
  if (status === "in_progress") return <span aria-hidden="true" className="mt-[3px] size-2.5 shrink-0 rounded-full bg-accent" />;
  return <span aria-hidden="true" className="mt-[3px] size-2.5 shrink-0 rounded-full border border-text-tertiary" />;
}

/** The agent's plan, at the top of the side panel. */
export function PlanCard({ plan, active }: { plan: PlanStep[]; active: boolean }) {
  const [open, setOpen] = useState(true);
  const done = plan.filter((s) => s.status === "completed").length;
  return (
    <section aria-label="Plan" className="mb-5">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={`flex w-full cursor-pointer items-baseline justify-between text-left ${open ? "mb-2" : ""}`}>
        {open ? (
          <>
            <h2 className="text-[13px] font-semibold">Plan</h2>
            <span className="text-xs text-text-secondary">{done} of {plan.length} done</span>
          </>
        ) : (
          <span className="text-[13px] font-semibold">Plan · {done} of {plan.length} done</span>
        )}
      </button>
      {open && (
        <ol className="flex flex-col gap-1.5 rounded-xl bg-sidebar px-3 py-2.5">
          {plan.map((s, i) => (
            <li key={i} data-plan-status={s.status} data-active={s.status === "in_progress" && active} className={`flex items-start gap-2 text-xs ${s.status === "completed" ? "text-text-secondary" : s.status === "in_progress" ? "font-medium" : ""}`}>
              <Marker status={s.status} active={active} />
              <span className="min-w-0 break-words">
                {s.step}
                <span className="sr-only"> ({LABEL[s.status]})</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
