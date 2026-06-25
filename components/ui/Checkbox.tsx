"use client";

export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border transition ${
        checked ? "border-brand bg-brand text-[#08130b]" : "border-border bg-surface"
      }`}
    >
      {checked ? <span className="text-xs leading-none">✓</span> : null}
    </button>
  );
}
