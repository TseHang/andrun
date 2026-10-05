import { useLayoutEffect, useRef, type ComponentProps, type Ref } from "react";

/** Lines the field grows to before it scrolls. */
const MAX_HEIGHT = 160;

/**
 * A message field inside a form: Enter submits the form, Shift+Enter starts a new line, and it grows with its text.
 * Enter that confirms an input-method candidate (Chinese, Japanese) never submits.
 */
export function ChatInput({ ref, className = "", value, onKeyDown, ...rest }: ComponentProps<"textarea"> & { ref?: Ref<HTMLTextAreaElement> }) {
  const own = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = own.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  return (
    <textarea
      {...rest}
      ref={(el) => {
        own.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) ref.current = el;
      }}
      rows={1}
      value={value}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.defaultPrevented || e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        e.currentTarget.form?.requestSubmit();
      }}
      className={`block max-h-40 min-h-9 resize-none rounded-[10px] bg-black/5 px-3 py-2 text-[14px] leading-5 transition-[background-color,box-shadow] focus:bg-white focus:shadow-[0_0_0_1px_rgba(0,0,0,0.2)] ${className}`}
    />
  );
}
