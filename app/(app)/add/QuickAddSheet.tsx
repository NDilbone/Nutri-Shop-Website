"use client";

import { useState, useEffect } from "react";
import type { NormalizedFood } from "@/lib/fdc/cache";
import type { Meal } from "@/lib/nutrition/types";
import { MEALS } from "@/lib/nutrition/types";
import { scaleNutrients, servingsToGrams } from "@/lib/nutrition/compute";
import { formatGrams } from "@/lib/nutrition/display";
import { Sheet } from "@/components/ui/Sheet";
import { Segmented } from "@/components/ui/Segmented";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

const MEAL_OPTS = MEALS.map((m) => ({ value: m, label: m[0]!.toUpperCase() + m.slice(1) }));

export function QuickAddSheet({
  open, onClose, food, initialMeal, initialGrams, mode = "add", onSubmit, onDelete,
}: {
  open: boolean;
  onClose: () => void;
  food: NormalizedFood | null;
  initialMeal: Meal;
  initialGrams: number;
  mode?: "add" | "edit";
  onSubmit: (args: { amountGrams: number; meal: Meal }) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [meal, setMeal] = useState<Meal>(initialMeal);
  const [unit, setUnit] = useState<"g" | "serving">("g");
  const [value, setValue] = useState<string>(String(initialGrams));
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMeal(initialMeal);
    setUnit("g");
    setValue(String(initialGrams));
  }, [open, food, initialMeal, initialGrams]);

  const serving = food?.nutrition.serving;
  const grams = unit === "g"
    ? Number(value) || 0
    : servingsToGrams(Number(value) || 0, serving) ?? 0;

  const scaled = food ? scaleNutrients(food.nutrition, grams) : null;
  const kcal = scaled?.energyKcal.amount;

  async function submit() {
    if (grams <= 0) return;
    setPending(true);
    try { await onSubmit({ amountGrams: grams, meal }); onClose(); }
    finally { setPending(false); }
  }

  return (
    <Sheet open={open} onClose={onClose} title={food?.description ?? "Add food"}>
      {food ? (
        <div className="grid gap-3">
          <div>
            <div className="font-medium">{food.description}</div>
            <div className="text-xs text-muted">{kcal == null ? "—" : Math.round(kcal)} kcal · for {formatGrams(grams)} g</div>
          </div>

          <div className="flex gap-2">
            <div className="flex-1 rounded-md bg-surface border border-border px-2 py-2 text-center">
              <div className="text-base font-bold text-protein">{scaled ? fmt(scaled.protein.amount) : "—"}g</div>
              <div className="text-[9px] uppercase tracking-wide text-muted">Protein</div>
            </div>
            <div className="flex-1 rounded-md bg-surface border border-border px-2 py-2 text-center">
              <div className="text-base font-bold text-carbs">{scaled ? fmt(scaled.carbs.amount) : "—"}g</div>
              <div className="text-[9px] uppercase tracking-wide text-muted">Carbs</div>
            </div>
            <div className="flex-1 rounded-md bg-surface border border-border px-2 py-2 text-center">
              <div className="text-base font-bold text-fat">{scaled ? fmt(scaled.totalFat.amount) : "—"}g</div>
              <div className="text-[9px] uppercase tracking-wide text-muted">Fat</div>
            </div>
          </div>

          <Field label="Amount">
            <div className="flex gap-2">
              <Input
                type="number" inputMode="decimal" min="0" value={value}
                onChange={(e) => setValue(e.target.value)} className="flex-1"
              />
              <Segmented
                options={[
                  { value: "g", label: "g" },
                  { value: "serving", label: serving ? `serving (${formatGrams(serving.amount)}g)` : "serving", disabled: !serving },
                ]}
                value={unit}
                onChange={(u) => setUnit(u)}
              />
            </div>
          </Field>

          <Field label="Meal">
            <Segmented options={MEAL_OPTS} value={meal} onChange={(m) => setMeal(m)} />
          </Field>

          <Button onClick={submit} disabled={pending || grams <= 0}>
            {pending ? "…" : mode === "edit" ? "Save" : `Add to ${meal}`}
          </Button>
          {mode === "edit" && onDelete ? (
            <Button variant="danger" onClick={async () => { setPending(true); try { await onDelete(); onClose(); } finally { setPending(false); } }}>
              Delete entry
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="py-6 text-center text-muted">Loading…</p>
      )}
    </Sheet>
  );
}

function fmt(n: number | null): string {
  return n == null ? "0" : String(Math.round(n));
}
