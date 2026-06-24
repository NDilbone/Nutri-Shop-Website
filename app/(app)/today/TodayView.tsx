"use client";

import type { DayData } from "@/lib/nutrition/types";
import { MEALS } from "@/lib/nutrition/types";
import { StatTile } from "@/components/ui/StatTile";
import { entryKcal } from "@/lib/nutrition/compute";

const MEAL_LABEL: Record<string, string> = {
  breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snack",
};

export function TodayView({ data }: { data: DayData }) {
  const kcal = data.totals.energyKcal;
  return (
    <div>
      <div className="px-4 py-3 text-center">
        <div className="text-3xl font-bold">{Math.round(kcal.amount)}</div>
        <div className="text-[11px] text-muted">kcal eaten{kcal.incomplete ? " (some unreported)" : ""}</div>
      </div>
      <div className="flex gap-2 px-4">
        <StatTile label="Protein" value={`${Math.round(data.totals.protein.amount)}g`} tone="protein" />
        <StatTile label="Carbs" value={`${Math.round(data.totals.carbs.amount)}g`} tone="carbs" />
        <StatTile label="Fat" value={`${Math.round(data.totals.totalFat.amount)}g`} tone="fat" />
      </div>

      <div className="mt-4 space-y-3 px-4">
        {MEALS.map((meal) => {
          const group = data.meals.find((m) => m.meal === meal)!;
          return (
            <section key={meal} className="rounded-lg border border-border bg-surface px-3 py-2">
              <div className="mb-1 flex justify-between text-[11px] uppercase tracking-wide text-muted">
                <span>{MEAL_LABEL[meal]}</span>
                <span>{Math.round(group.subtotalKcal)} kcal</span>
              </div>
              {group.entries.length === 0 ? (
                <p className="py-1 text-xs text-muted">No entries.</p>
              ) : (
                group.entries.map((e) => (
                  <div key={e.id} className="flex justify-between border-t border-border/50 py-1.5 text-sm">
                    <span>{e.description} <span className="text-muted">{Math.round(e.amountGrams)}g</span></span>
                    <span>{entryKcal(e) ?? "—"}</span>
                  </div>
                ))
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
