import type { NutrientKey, NutrientValue, NormalizedNutrition } from "@/lib/fdc/nutrients";
import { type Meal, MEALS, type LoggedEntry, type DayTotals, type MealGroup, type DayData } from "@/lib/nutrition/types";

const NUTRIENT_KEYS: NutrientKey[] = [
  "energyKcal", "protein", "totalFat", "saturatedFat", "carbs", "fiber", "totalSugars",
  "addedSugars", "sodium", "calcium", "iron", "potassium", "cholesterol", "vitaminD",
];

export function scaleNutrients(nutrition: NormalizedNutrition, grams: number): Record<NutrientKey, NutrientValue> {
  const out = {} as Record<NutrientKey, NutrientValue>;
  for (const key of NUTRIENT_KEYS) {
    const v = nutrition.nutrients[key];
    out[key] = v.amount == null ? { amount: null, unit: v.unit } : { amount: round(v.amount * grams / 100), unit: v.unit };
  }
  return out;
}

export function entryKcal(entry: LoggedEntry): number | null {
  const e = entry.nutrition.nutrients.energyKcal;
  return e.amount == null ? null : round(e.amount * entry.amountGrams / 100);
}

export function servingsToGrams(servings: number, serving?: { amount: number; unit: string }): number | null {
  if (!serving) return null;
  return round(servings * serving.amount);
}

export function defaultMealForHour(hour: number): Meal {
  if (hour < 11) return "breakfast";
  if (hour < 16) return "lunch";
  if (hour < 21) return "dinner";
  return "snack";
}

export function sumTotals(entries: LoggedEntry[]): DayTotals {
  const totals = {} as DayTotals;
  for (const key of NUTRIENT_KEYS) {
    let sum = 0;
    let incomplete = false;
    let unit = "";
    for (const entry of entries) {
      const v = entry.nutrition.nutrients[key];
      unit = unit || v.unit;
      if (v.amount == null) incomplete = true;
      else sum += v.amount * entry.amountGrams / 100;
    }
    totals[key] = { amount: round(sum), unit, incomplete };
  }
  return totals;
}

export function groupByMeal(entries: LoggedEntry[]): MealGroup[] {
  return MEALS.map((meal) => {
    const mealEntries = entries.filter((e) => e.meal === meal);
    const subtotalKcal = mealEntries.reduce((acc, e) => acc + (entryKcal(e) ?? 0), 0);
    return { meal, entries: mealEntries, subtotalKcal: round(subtotalKcal) };
  });
}

export function buildDayData(date: string, entries: LoggedEntry[]): DayData {
  return { date, totals: sumTotals(entries), meals: groupByMeal(entries) };
}

function round(n: number): number {
  return Math.round(n * 10) / 10; // one decimal; display layer rounds further
}
