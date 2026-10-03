export function ReviewStartPage({ number }: { number: number }) {
  return (
    <main className="flex min-w-0 grow flex-col items-center overflow-y-auto px-12 pb-10 pt-[132px]">
      <h1 className="m-0 w-[720px] text-[30px] font-bold leading-[1.15] tracking-[-0.022em]">Review pull request #{number}</h1>
    </main>
  );
}
