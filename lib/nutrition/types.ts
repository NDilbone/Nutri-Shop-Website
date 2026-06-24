import type { NutrientKey, NutrientValue, NormalizedNutrition } from "@/lib/fdc/nutrients";

export type Meal = "breakfast" | "lunch" | "dinner" | "snack";
export const MEALS: readonly Meal[] = ["breakfast", "lunch", "dinner", "snack"];

export type LoggedEntry = {
  id: string;
  fdcId: number;
  description: string;
  meal: Meal;
  amountGrams: number;
  nutrition: NormalizedNutrition; // per-100g snapshot
  loggedOn: string;              // YYYY-MM-DD
  loggedAt: string;              // ISO timestamp
};

export type NutrientTotal = { amount: number; unit: string; incomplete: boolean };
export type DayTotals = Record<NutrientKey, NutrientTotal>;

export type MealGroup = { meal: Meal; entries: LoggedEntry[]; subtotalKcal: number };

export type DayData = { date: string; totals: DayTotals; meals: MealGroup[] };

export type { NutrientKey, NutrientValue };
