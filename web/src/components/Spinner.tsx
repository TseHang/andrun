export function Spinner({ size = 10 }: { size?: number }) {
  return (
    <span
      data-spinner
      aria-hidden="true"
      className="inline-block shrink-0 rounded-full border-[1.5px] border-current border-t-transparent"
      style={{ width: size, height: size, animation: "spin 0.9s linear infinite" }}
    />
  );
}
