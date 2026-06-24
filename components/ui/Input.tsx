import type { InputHTMLAttributes } from "react";

export function Input({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full rounded-md bg-surface border border-border px-3 py-2.5 text-sm text-text placeholder:text-muted outline-none focus:border-brand ${className}`}
      {...rest}
    />
  );
}
