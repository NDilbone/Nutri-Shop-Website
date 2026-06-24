"use client";

import { useState } from "react";
import type { DayData, LoggedEntry, Meal } from "@/lib/nutrition/types";
import { MEALS } from "@/lib/nutrition/types";
import { StatTile } from "@/components/ui/StatTile";
import { entryKcal } from "@/lib/nutrition/compute";
import { QuickAddSheet } from "@/app/(app)/add/QuickAddSheet";
import { editFoodAction, deleteFoodAction } from "@/app/(app)/today/actions";
import type { NormalizedFood } from "@/lib/fdc/cache";

const MEAL_LABEL: Record<Meal, string> = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snack" };

export function TodayView({ data }: { data: DayData }) {
  const [editing, setEditing] = useState<LoggedEntry | null>(null);
  const kcal = data.totals.energyKcal;

  // The logged entry already carries its per-100g snapshot → build a NormalizedFood for the sheet (no fetch).
  const editFood: NormalizedFood | null = editing
    ? { fdcId: editing.fdcId, description: editing.description, dataType: null, nutrition: editing.nutrition }
    : null;

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
              <div className="mb-1 flex items-center justify-between text-[11px] uppercase tracking-wide text-muted">
                <span>{MEAL_LABEL[meal]}</span>
                <span>{Math.round(group.subtotalKcal)} kcal</span>
              </div>
              {group.entries.map((e) => (
                <button key={e.id} type="button" onClick={() => setEditing(e)} className="flex w-full justify-between border-t border-border/50 py-1.5 text-left text-sm">
                  <span>{e.description} <span className="text-muted">{Math.round(e.amountGrams)}g</span></span>
                  <span>{entryKcal(e) === null ? "—" : Math.round(entryKcal(e)!)}</span>
                </button>
              ))}
              <a href={`/add?date=${data.date}&meal=${meal}`} className="mt-1 block py-1 text-xs text-brand">+ Add food</a>
            </section>
          );
        })}
      </div>

      <QuickAddSheet
        open={editing !== null}
        onClose={() => setEditing(null)}
        food={editFood}
        initialMeal={editing?.meal ?? "lunch"}
        initialGrams={editing?.amountGrams ?? 100}
        mode="edit"
        onSubmit={async ({ amountGrams, meal }) => {
          if (editing) await editFoodAction({ id: editing.id, amountGrams, meal });
        }}
        onDelete={async () => {
          if (editing) await deleteFoodAction({ id: editing.id });
        }}
      />
    </div>
  );
}
