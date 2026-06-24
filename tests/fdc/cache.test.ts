// tests/fdc/cache.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// L1 pass-through so the cache wrapper just invokes the underlying fn in tests.
vi.mock("next/cache", () => ({ unstable_cache: (fn: (...a: unknown[]) => unknown) => fn }));

const searchFoods = vi.fn();
const getFoodDetail = vi.fn();
class FakeFdcError extends Error {
  constructor(readonly kind: string, readonly retryAfter?: number) { super(kind); this.name = "FdcError"; }
}
vi.mock("@/lib/fdc/client", () => ({
  searchFoods: (...a: unknown[]) => searchFoods(...a),
  getFoodDetail: (...a: unknown[]) => getFoodDetail(...a),
  FdcError: FakeFdcError,
}));

const from = vi.fn();   // authed client — L2 read
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn().mockResolvedValue({ from }),
}));

// service-role client — L2 write
const adminUpsert = vi.fn().mockResolvedValue({ error: null });
const adminFrom = vi.fn(() => ({ upsert: adminUpsert }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({ from: adminFrom })),
}));

// helper to stub a food_cache SELECT ... maybeSingle() result
function stubSelect(row: unknown) {
  from.mockReturnValue({
    select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) }),
  });
}

beforeEach(() => {
  searchFoods.mockReset();
  getFoodDetail.mockReset();
  from.mockReset();
  adminFrom.mockClear();
  adminUpsert.mockClear();
});

describe("getFoodDetailCached", () => {
  it("returns a fresh L2 row without calling FDC", async () => {
    stubSelect({
      fdc_id: 5, description: "Cached", data_type: "Branded",
      nutrition: { basis: "100g", nutrients: {} },
      fetched_at: new Date().toISOString(),
    });
    const { getFoodDetailCached } = await import("@/lib/fdc/cache");
    const { food, stale } = await getFoodDetailCached(5);
    expect(stale).toBe(false);
    expect(food.description).toBe("Cached");
    expect(getFoodDetail).not.toHaveBeenCalled();
  });

  it("on L2 miss, fetches FDC, normalizes, and upserts", async () => {
    stubSelect(null);
    getFoodDetail.mockResolvedValue({
      fdcId: 9, description: "Fresh", dataType: "Foundation",
      foodNutrients: [{ amount: 100, nutrient: { id: 1008, unitName: "KCAL" } }],
    });
    const { getFoodDetailCached } = await import("@/lib/fdc/cache");
    const { food } = await getFoodDetailCached(9);
    expect(food.nutrition.nutrients.energyKcal).toEqual({ amount: 100, unit: "kcal" });
    expect(adminFrom).toHaveBeenCalledWith("food_cache");
    expect(adminUpsert).toHaveBeenCalledWith(expect.objectContaining({ fdc_id: 9, fetched_at: expect.any(String) }));
  });

  it("serves a stale row when FDC is rate-limited", async () => {
    stubSelect({
      fdc_id: 5, description: "Old", data_type: "Branded",
      nutrition: { basis: "100g", nutrients: {} },
      fetched_at: new Date(Date.now() - 99 * 24 * 3600 * 1000).toISOString(), // stale
    });
    getFoodDetail.mockRejectedValue(new FakeFdcError("rate_limited"));
    const { getFoodDetailCached } = await import("@/lib/fdc/cache");
    const { food, stale } = await getFoodDetailCached(5);
    expect(stale).toBe(true);
    expect(food.description).toBe("Old");
  });
});

describe("searchFoodsCached", () => {
  it("delegates to the FDC client", async () => {
    searchFoods.mockResolvedValue({ totalHits: 1, currentPage: 1, totalPages: 1, foods: [] });
    const { searchFoodsCached } = await import("@/lib/fdc/cache");
    const res = await searchFoodsCached({ query: "egg", dataType: ["Branded"], page: 1 });
    expect(res.totalHits).toBe(1);
    expect(searchFoods).toHaveBeenCalledWith({ query: "egg", dataType: ["Branded"], pageNumber: 1 });
  });
});
