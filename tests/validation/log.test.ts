import { describe, it, expect } from "vitest";
import { addFoodSchema, editFoodSchema, deleteFoodSchema, dateParamSchema } from "@/lib/validation/log";

describe("addFoodSchema", () => {
  it("accepts a valid entry", () => {
    const r = addFoodSchema.safeParse({ fdcId: 5, amountGrams: 150, meal: "lunch", loggedOn: "2026-06-24" });
    expect(r.success).toBe(true);
  });
  it("rejects non-positive or huge grams", () => {
    expect(addFoodSchema.safeParse({ fdcId: 5, amountGrams: 0, meal: "lunch", loggedOn: "2026-06-24" }).success).toBe(false);
    expect(addFoodSchema.safeParse({ fdcId: 5, amountGrams: 999999, meal: "lunch", loggedOn: "2026-06-24" }).success).toBe(false);
  });
  it("rejects a bad meal or date", () => {
    expect(addFoodSchema.safeParse({ fdcId: 5, amountGrams: 10, meal: "brunch", loggedOn: "2026-06-24" }).success).toBe(false);
    expect(addFoodSchema.safeParse({ fdcId: 5, amountGrams: 10, meal: "lunch", loggedOn: "06/24/2026" }).success).toBe(false);
  });
});

describe("editFoodSchema", () => {
  it("requires an id and allows partial fields", () => {
    expect(editFoodSchema.safeParse({ id: crypto.randomUUID(), amountGrams: 80 }).success).toBe(true);
    expect(editFoodSchema.safeParse({ amountGrams: 80 }).success).toBe(false);
  });
});

describe("deleteFoodSchema", () => {
  it("requires a uuid id", () => {
    expect(deleteFoodSchema.safeParse({ id: crypto.randomUUID() }).success).toBe(true);
    expect(deleteFoodSchema.safeParse({ id: "nope" }).success).toBe(false);
  });
});

describe("dateParamSchema", () => {
  it("accepts YYYY-MM-DD only", () => {
    expect(dateParamSchema.safeParse("2026-06-24").success).toBe(true);
    expect(dateParamSchema.safeParse("2026-6-4").success).toBe(false);
  });
});
