/** The fold arrow of a card header: points down when open. */
export function Chevron({ open }: { open: boolean }) {
  return (
    <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" className={`shrink-0 text-text-secondary transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}>
      <path d="M3.5 1.5 7 5l-3.5 3.5" />
    </svg>
  );
}
