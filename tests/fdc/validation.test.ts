import { describe, it, expect } from "vitest";
import {
  searchQuerySchema, fdcIdSchema,
  fdcSearchResponseSchema, fdcDetailResponseSchema,
} from "@/lib/validation/fdc";

describe("searchQuerySchema", () => {
  it("requires q and defaults dataType + page", () => {
    const r = searchQuerySchema.parse({ q: "cheddar" });
    expect(r.q).toBe("cheddar");
    expect(r.dataType).toEqual(["Branded", "Foundation", "SR Legacy"]);
    expect(r.page).toBe(1);
  });
  it("rejects an empty query", () => {
    expect(searchQuerySchema.safeParse({ q: "" }).success).toBe(false);
  });
  it("coerces page from a string and rejects < 1", () => {
    expect(searchQuerySchema.parse({ q: "x", page: "3" }).page).toBe(3);
    expect(searchQuerySchema.safeParse({ q: "x", page: "0" }).success).toBe(false);
  });
  it("rejects an unknown dataType", () => {
    expect(searchQuerySchema.safeParse({ q: "x", dataType: ["Nope"] }).success).toBe(false);
  });
});

describe("fdcIdSchema", () => {
  it("coerces a numeric string to a positive int", () => {
    expect(fdcIdSchema.parse("534358")).toBe(534358);
  });
  it("rejects non-numeric / non-positive", () => {
    expect(fdcIdSchema.safeParse("abc").success).toBe(false);
    expect(fdcIdSchema.safeParse("-5").success).toBe(false);
  });
});

describe("FDC response schemas (lenient)", () => {
  it("parses a search response and tolerates extra fields", () => {
    const r = fdcSearchResponseSchema.parse({
      totalHits: 2, currentPage: 1, totalPages: 1,
      foods: [{ fdcId: 1, description: "A", dataType: "Branded",
                brandOwner: "X", gtinUpc: "000", surprise: true }],
    });
    expect(r.foods[0].fdcId).toBe(1);
  });
  it("parses a detail response exposing foodNutrients[].nutrient.id", () => {
    const r = fdcDetailResponseSchema.parse({
      fdcId: 5, description: "B", dataType: "Foundation",
      foodNutrients: [{ amount: 10, nutrient: { id: 1003, number: "203", unitName: "G" } }],
    });
    expect(r.foodNutrients[0].nutrient.id).toBe(1003);
  });
});
