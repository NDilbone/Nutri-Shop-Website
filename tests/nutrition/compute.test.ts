import { describe, it, expect } from "vitest";
import {
  scaleNutrients, entryKcal, servingsToGrams, defaultMealForHour, sumTotals, buildDayData,
} from "@/lib/nutrition/compute";
import type { LoggedEntry } from "@/lib/nutrition/types";
import type { NormalizedNutrition } from "@/lib/fdc/nutrients";

function nutrition(part: Partial<Record<string, { amount: number | null; unit: string }>> = {}): NormalizedNutrition {
  const base = {
    energyKcal: { amount: 0, unit: "kcal" }, protein: { amount: 0, unit: "g" },
    totalFat: { amount: 0, unit: "g" }, saturatedFat: { amount: 0, unit: "g" },
    carbs: { amount: 0, unit: "g" }, fiber: { amount: 0, unit: "g" },
    totalSugars: { amount: 0, unit: "g" }, addedSugars: { amount: 0, unit: "g" },
    sodium: { amount: 0, unit: "mg" }, calcium: { amount: 0, unit: "mg" },
    iron: { amount: 0, unit: "mg" }, potassium: { amount: 0, unit: "mg" },
    cholesterol: { amount: 0, unit: "mg" }, vitaminD: { amount: 0, unit: "µg" },
  };
  return { basis: "100g", nutrients: { ...base, ...part } } as NormalizedNutrition;
}

function entry(over: Partial<LoggedEntry>): LoggedEntry {
  return {
    id: "x", fdcId: 1, description: "f", meal: "lunch", amountGrams: 100,
    nutrition: nutrition(), loggedOn: "2026-06-24", loggedAt: "2026-06-24T12:00:00Z", ...over,
  };
}

describe("scaleNutrients", () => {
  it("scales per-100g by grams/100", () => {
    const n = nutrition({ protein: { amount: 20, unit: "g" } });
    expect(scaleNutrients(n, 150).protein).toEqual({ amount: 30, unit: "g" });
  });
  it("keeps null as null (never coerces to 0)", () => {
    const n = nutrition({ sodium: { amount: null, unit: "mg" } });
    expect(scaleNutrients(n, 200).sodium).toEqual({ amount: null, unit: "mg" });
  });
});

describe("entryKcal", () => {
  it("returns scaled calories", () => {
    expect(entryKcal(entry({ nutrition: nutrition({ energyKcal: { amount: 100, unit: "kcal" } }), amountGrams: 250 }))).toBe(250);
  });
  it("returns null when energy is unreported", () => {
    expect(entryKcal(entry({ nutrition: nutrition({ energyKcal: { amount: null, unit: "kcal" } }) }))).toBeNull();
  });
});

describe("servingsToGrams", () => {
  it("multiplies servings by serving size", () => {
    expect(servingsToGrams(2, { amount: 30, unit: "g" })).toBe(60);
  });
  it("returns null when no serving size exists", () => {
    expect(servingsToGrams(2, undefined)).toBeNull();
  });
});

describe("defaultMealForHour", () => {
  it("maps hours to meals", () => {
    expect(defaultMealForHour(8)).toBe("breakfast");
    expect(defaultMealForHour(13)).toBe("lunch");
    expect(defaultMealForHour(19)).toBe("dinner");
    expect(defaultMealForHour(23)).toBe("snack");
  });
});

describe("sumTotals", () => {
  it("sums a nutrient across entries", () => {
    const e1 = entry({ nutrition: nutrition({ protein: { amount: 10, unit: "g" } }), amountGrams: 100 });
    const e2 = entry({ nutrition: nutrition({ protein: { amount: 20, unit: "g" } }), amountGrams: 50 });
    const t = sumTotals([e1, e2]);
    expect(t.protein.amount).toBe(20); // 10 + 10
    expect(t.protein.incomplete).toBe(false);
  });
  it("flags incomplete when any contributor was null", () => {
    const e1 = entry({ nutrition: nutrition({ sodium: { amount: 5, unit: "mg" } }) });
    const e2 = entry({ nutrition: nutrition({ sodium: { amount: null, unit: "mg" } }) });
    const t = sumTotals([e1, e2]);
    expect(t.sodium.amount).toBe(5);       // null contributes 0
    expect(t.sodium.incomplete).toBe(true);
  });
});

describe("buildDayData", () => {
  it("groups entries by meal in canonical order with day totals", () => {
    const d = buildDayData("2026-06-24", [
      entry({ meal: "dinner", nutrition: nutrition({ energyKcal: { amount: 100, unit: "kcal" } }) }),
      entry({ meal: "breakfast", nutrition: nutrition({ energyKcal: { amount: 50, unit: "kcal" } }) }),
    ]);
    expect(d.date).toBe("2026-06-24");
    expect(d.meals.map((m) => m.meal)).toEqual(["breakfast", "lunch", "dinner", "snack"]);
    expect(d.totals.energyKcal.amount).toBe(150);
    const breakfast = d.meals.find((m) => m.meal === "breakfast")!;
    expect(breakfast.entries).toHaveLength(1);
    expect(breakfast.subtotalKcal).toBe(50);
  });
});
