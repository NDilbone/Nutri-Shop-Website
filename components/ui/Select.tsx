import type { SelectHTMLAttributes } from "react";

export function Select({ className = "", children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`w-full rounded-md bg-surface border border-border px-3 py-2.5 text-sm text-text outline-none focus:border-brand ${className}`}
      {...rest}
    >
      {children}
    </select>
  );
}
