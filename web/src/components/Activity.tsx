/** What the agent is doing right now: three dots pulsing one after another, then the label. */
export function Activity({ label }: { label: string }) {
  return (
    <div role="status" className="my-3 flex items-center gap-2 text-xs text-text-secondary">
      <span aria-hidden="true" className="flex gap-1">
        {[0, 1, 2].map((n) => (
          <span key={n} aria-hidden="true" data-dot className="size-1.5 rounded-full bg-text-tertiary" style={{ animation: "pulse-dot 1.2s ease-in-out infinite", animationDelay: `${n * 0.2}s` }} />
        ))}
      </span>
      {label}
    </div>
  );
}
