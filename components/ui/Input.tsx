import type { InputHTMLAttributes, Ref } from "react";

export function Input({ className = "", ref, ...rest }: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return (
    <input
      ref={ref}
      className={`w-full rounded-md bg-surface border border-border px-3 py-2.5 text-sm text-text placeholder:text-muted outline-none focus:border-brand ${className}`}
      {...rest}
    />
  );
}
