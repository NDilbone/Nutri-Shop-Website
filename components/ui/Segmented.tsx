"use client";

export function Segmented<T extends string | number>({
  options, value, onChange,
}: {
  options: { value: T; label: string; disabled?: boolean }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            disabled={o.disabled}
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={`rounded-md border px-3 py-1.5 text-xs transition disabled:opacity-40 ${
              on ? "border-brand bg-[#16341f] text-protein" : "border-border bg-surface text-muted"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
