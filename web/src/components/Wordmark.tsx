// One place for the logo: switch to <img src="/logo.svg" alt="&run"> when the outlined SVG exists.
export function Wordmark() {
  return (
    <span className="text-[20px] font-bold tracking-[-0.02em]" style={{ fontFamily: "'DM Sans', sans-serif" }}>
      <span className="text-accent">&amp;</span>run
    </span>
  );
}
