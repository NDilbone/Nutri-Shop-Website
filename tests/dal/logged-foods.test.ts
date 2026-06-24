import { describe, it, expect, vi, beforeEach } from "vitest";

const verifySession = vi.fn();
vi.mock("@/lib/dal/session", () => ({ verifySession: (...a: unknown[]) => verifySession(...a) }));

const getFoodDetailCached = vi.fn();
vi.mock("@/lib/fdc/cache", () => ({ getFoodDetailCached: (...a: unknown[]) => getFoodDetailCached(...a) }));

const from = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn().mockResolvedValue({ from }) }));

beforeEach(() => {
  verifySession.mockReset();
  getFoodDetailCached.mockReset();
  from.mockReset();
});

const NUTR = { basis: "100g", nutrients: {} };

describe("logFood", () => {
  it("snapshots nutrition from the cache and inserts with the session user_id", async () => {
    verifySession.mockResolvedValue({ userId: "u1" });
    getFoodDetailCached.mockResolvedValue({ food: { fdcId: 5, description: "Egg", dataType: "Foundation", nutrition: NUTR }, stale: false });
    const insertCapture = vi.fn().mockReturnValue({
      select: () => ({ single: () => Promise.resolve({ data: { id: "row1" }, error: null }) }),
    });
    from.mockReturnValue({ insert: insertCapture });

    const { logFood } = await import("@/lib/dal/logged-foods");
    const res = await logFood({ fdcId: 5, amountGrams: 150, meal: "lunch", loggedOn: "2026-06-24" });

    expect(res).toEqual({ id: "row1" });
    expect(insertCapture).toHaveBeenCalledWith(expect.objectContaining({
      user_id: "u1", fdc_id: 5, description: "Egg", meal: "lunch",
      amount_grams: 150, nutrition: NUTR, logged_on: "2026-06-24",
    }));
  });

  it("throws when unauthenticated", async () => {
    verifySession.mockResolvedValue(null);
    const { logFood } = await import("@/lib/dal/logged-foods");
    await expect(logFood({ fdcId: 5, amountGrams: 1, meal: "snack", loggedOn: "2026-06-24" })).rejects.toThrow();
    expect(getFoodDetailCached).not.toHaveBeenCalled();
  });
});

describe("editLog", () => {
  it("updates only the provided fields, scoped by id", async () => {
    verifySession.mockResolvedValue({ userId: "u1" });
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq });
    from.mockReturnValue({ update });
    const { editLog } = await import("@/lib/dal/logged-foods");
    await editLog({ id: "row1", amountGrams: 80 });
    expect(update).toHaveBeenCalledWith({ amount_grams: 80 });
    expect(eq).toHaveBeenCalledWith("id", "row1");
  });
});

describe("softDeleteLog", () => {
  it("sets deleted_at scoped by id", async () => {
    verifySession.mockResolvedValue({ userId: "u1" });
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq });
    from.mockReturnValue({ update });
    const { softDeleteLog } = await import("@/lib/dal/logged-foods");
    await softDeleteLog("row1");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ deleted_at: expect.any(String) }));
    expect(eq).toHaveBeenCalledWith("id", "row1");
  });
});

describe("getDay", () => {
  it("maps rows to a DayData with totals", async () => {
    verifySession.mockResolvedValue({ userId: "u1" });
    const rows = [{
      id: "r1", fdc_id: 5, description: "Egg", meal: "lunch", amount_grams: 100,
      // Full 14-key snapshot — sumTotals iterates every NUTRIENT_KEY and reads v.unit,
      // so a sparse fixture would throw at runtime (production snapshots are always full).
      nutrition: { basis: "100g", nutrients: {
        energyKcal: { amount: 155, unit: "kcal" }, protein: { amount: null, unit: "g" },
        totalFat: { amount: null, unit: "g" }, saturatedFat: { amount: null, unit: "g" },
        carbs: { amount: null, unit: "g" }, fiber: { amount: null, unit: "g" },
        totalSugars: { amount: null, unit: "g" }, addedSugars: { amount: null, unit: "g" },
        sodium: { amount: null, unit: "mg" }, calcium: { amount: null, unit: "mg" },
        iron: { amount: null, unit: "mg" }, potassium: { amount: null, unit: "mg" },
        cholesterol: { amount: null, unit: "mg" }, vitaminD: { amount: null, unit: "µg" },
      } },
      logged_on: "2026-06-24", logged_at: "2026-06-24T12:00:00Z",
    }];
    const is = vi.fn().mockResolvedValue({ data: rows, error: null });
    const eq2 = vi.fn().mockReturnValue({ is });
    const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
    const select = vi.fn().mockReturnValue({ eq: eq1 });
    from.mockReturnValue({ select });
    const { getDay } = await import("@/lib/dal/logged-foods");
    const day = await getDay("2026-06-24");
    expect(day.date).toBe("2026-06-24");
    expect(day.meals.find((m) => m.meal === "lunch")!.entries).toHaveLength(1);
    expect(day.totals.energyKcal.amount).toBe(155);
  });
});
