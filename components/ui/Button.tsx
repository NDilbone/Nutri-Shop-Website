import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "ghost" | "danger";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand text-[#08130b] font-semibold",
  ghost: "bg-surface text-text border border-border",
  danger: "bg-transparent text-danger border border-border",
};

export function Button({
  variant = "primary", className = "", ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={`w-full rounded-md px-4 py-3 text-sm transition active:scale-[.99] disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      {...rest}
    />
  );
}
