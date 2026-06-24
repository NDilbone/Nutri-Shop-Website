import type { DayTotals, NutrientKey } from "@/lib/nutrition/types";

const ROWS: { key: NutrientKey; label: string }[] = [
  { key: "saturatedFat", label: "Saturated fat" },
  { key: "fiber", label: "Fiber" },
  { key: "totalSugars", label: "Total sugars" },
  { key: "addedSugars", label: "Added sugars" },
  { key: "sodium", label: "Sodium" },
  { key: "calcium", label: "Calcium" },
  { key: "iron", label: "Iron" },
  { key: "potassium", label: "Potassium" },
  { key: "cholesterol", label: "Cholesterol" },
  { key: "vitaminD", label: "Vitamin D" },
];

export function NutritionPanel({ totals }: { totals: DayTotals }) {
  const anyIncomplete = ROWS.some((r) => totals[r.key].incomplete);
  return (
    <details className="mx-4 mt-3 rounded-md border border-border bg-surface px-4 py-2">
      <summary className="cursor-pointer list-none text-xs text-muted">Full nutrition</summary>
      <div className="mt-2">
        {ROWS.map((r) => {
          const t = totals[r.key];
          return (
            <div key={r.key} className="flex justify-between border-t border-border/50 py-1.5 text-sm">
              <span className="text-muted">{r.label}</span>
              <span>{Math.round(t.amount)} {t.unit}{t.incomplete ? "*" : ""}</span>
            </div>
          );
        })}
        {anyIncomplete ? <p className="mt-2 text-[11px] text-muted">* some foods didn&apos;t report this nutrient</p> : null}
      </div>
    </details>
  );
}
