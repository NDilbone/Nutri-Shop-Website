import { describe, it, expect, vi, beforeEach } from "vitest";

const logFood = vi.fn();
const editLog = vi.fn();
const softDeleteLog = vi.fn();
vi.mock("@/lib/dal/logged-foods", () => ({
  logFood: (...a: unknown[]) => logFood(...a),
  editLog: (...a: unknown[]) => editLog(...a),
  softDeleteLog: (...a: unknown[]) => softDeleteLog(...a),
}));
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("@/lib/dal/session", () => ({
  requireStepUp: () => Promise.resolve({ userId: "u1" }),
}));

beforeEach(() => { logFood.mockReset(); editLog.mockReset(); softDeleteLog.mockReset(); revalidatePath.mockReset(); });

describe("addFoodAction", () => {
  it("validates, logs, and revalidates", async () => {
    logFood.mockResolvedValue({ id: "r1" });
    const { addFoodAction } = await import("@/app/(app)/today/actions");
    const res = await addFoodAction({ fdcId: 5, amountGrams: 150, meal: "lunch", loggedOn: "2026-06-24" });
    expect(res).toEqual({ ok: true });
    expect(logFood).toHaveBeenCalledWith({ fdcId: 5, amountGrams: 150, meal: "lunch", loggedOn: "2026-06-24" });
    expect(revalidatePath).toHaveBeenCalledWith("/today");
  });
  it("rejects invalid input without calling the DAL", async () => {
    const { addFoodAction } = await import("@/app/(app)/today/actions");
    const res = await addFoodAction({ fdcId: -1, amountGrams: 0, meal: "brunch", loggedOn: "bad" });
    expect("error" in res).toBe(true);
    expect(logFood).not.toHaveBeenCalled();
  });
});

describe("editFoodAction", () => {
  it("validates and edits", async () => {
    editLog.mockResolvedValue(undefined);
    const { editFoodAction } = await import("@/app/(app)/today/actions");
    const id = crypto.randomUUID();
    const res = await editFoodAction({ id, amountGrams: 80 });
    expect(res).toEqual({ ok: true });
    expect(editLog).toHaveBeenCalledWith({ id, amountGrams: 80 });
    expect(revalidatePath).toHaveBeenCalledWith("/today");
  });
});

describe("deleteFoodAction", () => {
  it("validates and soft-deletes", async () => {
    softDeleteLog.mockResolvedValue(undefined);
    const { deleteFoodAction } = await import("@/app/(app)/today/actions");
    const id = crypto.randomUUID();
    const res = await deleteFoodAction({ id });
    expect(res).toEqual({ ok: true });
    expect(softDeleteLog).toHaveBeenCalledWith(id);
    expect(revalidatePath).toHaveBeenCalledWith("/today");
  });
});
