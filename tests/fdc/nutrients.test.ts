// tests/fdc/nutrients.test.ts
import { describe, it, expect } from "vitest";
import { normalizeNutrition } from "@/lib/fdc/nutrients";

describe("normalizeNutrition", () => {
  it("maps macros by FDC nutrient id (per-100g)", () => {
    const out = normalizeNutrition({
      dataType: "Branded",
      foodNutrients: [
        { id: 1008, amount: 140, unitName: "KCAL" },
        { id: 1003, amount: 5, unitName: "G" },
        { id: 1004, amount: 9, unitName: "G" },
        { id: 1005, amount: 12, unitName: "G" },
        { id: 1093, amount: 200, unitName: "MG" },
      ],
    });
    expect(out.basis).toBe("100g");
    expect(out.nutrients.energyKcal).toEqual({ amount: 140, unit: "kcal" });
    expect(out.nutrients.protein).toEqual({ amount: 5, unit: "g" });
    expect(out.nutrients.sodium).toEqual({ amount: 200, unit: "mg" });
  });

  it("represents a missing nutrient as null, never 0", () => {
    const out = normalizeNutrition({ dataType: "SR Legacy", foodNutrients: [] });
    expect(out.nutrients.addedSugars).toEqual({ amount: null, unit: "g" });
    expect(out.nutrients.vitaminD).toEqual({ amount: null, unit: "µg" });
  });

  it("falls back to Atwater energy (2047, then 2048) for Foundation foods", () => {
    const out = normalizeNutrition({
      dataType: "Foundation",
      foodNutrients: [{ id: 2047, amount: 52, unitName: "KCAL" }],
    });
    expect(out.nutrients.energyKcal).toEqual({ amount: 52, unit: "kcal" });
  });

  it("prefers vitamin D µg (1114); falls back to 1110 as IU", () => {
    const ug = normalizeNutrition({ dataType: "Foundation",
      foodNutrients: [{ id: 1114, amount: 2, unitName: "UG" }] });
    expect(ug.nutrients.vitaminD).toEqual({ amount: 2, unit: "µg" });

    const iu = normalizeNutrition({ dataType: "SR Legacy",
      foodNutrients: [{ id: 1110, amount: 80, unitName: "IU" }] });
    expect(iu.nutrients.vitaminD).toEqual({ amount: 80, unit: "IU" });
  });

  it("passes a serving through when provided (Branded)", () => {
    const out = normalizeNutrition({
      dataType: "Branded",
      foodNutrients: [],
      serving: { amount: 28, unit: "g", household: "1 ONZ" },
    });
    expect(out.serving).toEqual({ amount: 28, unit: "g", household: "1 ONZ" });
  });
});
