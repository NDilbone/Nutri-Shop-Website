// lib/fdc/nutrients.ts
export type NutrientKey =
  | "energyKcal" | "protein" | "totalFat" | "saturatedFat" | "carbs"
  | "fiber" | "totalSugars" | "addedSugars" | "sodium" | "calcium"
  | "iron" | "potassium" | "cholesterol" | "vitaminD";

export type NutrientValue = { amount: number | null; unit: string };

export type RawNutrient = { id: number; amount: number | null; unitName: string };

export type NormalizeInput = {
  dataType: string;
  foodNutrients: RawNutrient[];
  serving?: { amount: number; unit: string; household: string | null };
};

export type NormalizedNutrition = {
  basis: "100g";
  serving?: { amount: number; unit: string; household: string | null };
  nutrients: Record<NutrientKey, NutrientValue>;
};

// Each key maps to an ordered list of FDC nutrient ids (first match wins) and a
// canonical unit. Energy falls back 1008 → 2047 (Atwater general) → 2048
// (Atwater specific); Foundation foods omit 1008 since Oct 2020. Vitamin D
// prefers 1114 (µg, the modern label unit); 1110 is the legacy IU form.
const NUTRIENT_DEFS: Record<NutrientKey, { ids: number[]; unit: string }> = {
  energyKcal:   { ids: [1008, 2047, 2048], unit: "kcal" },
  protein:      { ids: [1003], unit: "g" },
  totalFat:     { ids: [1004], unit: "g" },
  saturatedFat: { ids: [1258], unit: "g" },
  carbs:        { ids: [1005], unit: "g" },
  fiber:        { ids: [1079], unit: "g" },
  totalSugars:  { ids: [2000], unit: "g" },
  addedSugars:  { ids: [1235], unit: "g" },
  sodium:       { ids: [1093], unit: "mg" },
  calcium:      { ids: [1087], unit: "mg" },
  iron:         { ids: [1089], unit: "mg" },
  potassium:    { ids: [1092], unit: "mg" },
  cholesterol:  { ids: [1253], unit: "mg" },
  vitaminD:     { ids: [1114, 1110], unit: "µg" },
};

export function normalizeNutrition(input: NormalizeInput): NormalizedNutrition {
  const byId = new Map<number, RawNutrient>();
  for (const n of input.foodNutrients) {
    if (!byId.has(n.id)) byId.set(n.id, n);
  }

  const nutrients = {} as Record<NutrientKey, NutrientValue>;
  for (const key of Object.keys(NUTRIENT_DEFS) as NutrientKey[]) {
    const def = NUTRIENT_DEFS[key];
    let value: NutrientValue = { amount: null, unit: def.unit };
    for (const id of def.ids) {
      const hit = byId.get(id);
      if (hit && hit.amount != null) {
        // Vitamin D's IU fallback keeps the IU unit so callers don't mistake it for µg.
        const unit = key === "vitaminD" && id === 1110 ? "IU" : def.unit;
        value = { amount: hit.amount, unit };
        break;
      }
    }
    nutrients[key] = value;
  }

  return {
    basis: "100g",
    ...(input.serving ? { serving: input.serving } : {}),
    nutrients,
  };
}
