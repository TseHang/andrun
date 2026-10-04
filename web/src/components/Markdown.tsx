import { createElement } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/** An element with these classes; react-markdown's `node` prop is not a DOM attribute. */
function styled(tag: string, className: string, extra: Record<string, string> = {}) {
  return ({ node, ...props }: { node?: unknown }) => {
    void node;
    return createElement(tag, { className, ...extra, ...props });
  };
}

// No rehype-raw: raw HTML in a reply is shown as text. react-markdown's default URL sanitising stays: a javascript: link gets no href.
const COMPONENTS: Components = {
  h1: styled("h1", "mt-4 mb-2 text-[18px] font-semibold first:mt-0"),
  h2: styled("h2", "mt-4 mb-2 text-[17px] font-semibold first:mt-0"),
  h3: styled("h3", "mt-3 mb-1.5 text-[16px] font-semibold first:mt-0"),
  h4: styled("h4", "mt-3 mb-1.5 text-[15px] font-semibold first:mt-0"),
  h5: styled("h5", "mt-3 mb-1.5 text-[15px] font-semibold first:mt-0"),
  h6: styled("h6", "mt-3 mb-1.5 text-[15px] font-semibold first:mt-0"),
  p: styled("p", "my-2 first:mt-0 last:mb-0"),
  ul: styled("ul", "my-2 list-disc pl-6"),
  ol: styled("ol", "my-2 list-decimal pl-6"),
  li: styled("li", "my-0.5"),
  a: styled("a", "text-accent-text", { target: "_blank", rel: "noreferrer" }),
  code: styled("code", "rounded bg-fill px-1 py-0.5 font-mono text-[13px]"),
  pre: styled("pre", "my-2 overflow-x-auto rounded-lg bg-sidebar p-3 font-mono text-[13px] whitespace-pre [&_code]:bg-transparent [&_code]:p-0"),
  blockquote: styled("blockquote", "my-2 border-l-2 border-black/10 pl-3 text-text-secondary"),
  hr: styled("hr", "my-3 border-black/10"),
  table: ({ node, ...props }) => {
    void node;
    return (
      <div className="my-2 overflow-x-auto">
        <table className="border-collapse text-[14px]" {...props} />
      </div>
    );
  },
  th: styled("th", "border border-black/10 px-2.5 py-1 text-left font-semibold"),
  td: styled("td", "border border-black/10 px-2.5 py-1"),
};

export function Markdown({ text }: { text: string }) {
  return (
    <div className="text-[15px] leading-relaxed break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
