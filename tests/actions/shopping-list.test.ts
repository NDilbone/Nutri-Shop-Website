import { describe, it, expect, vi, beforeEach } from "vitest";

const addItem = vi.fn();
const editItem = vi.fn();
const toggleItem = vi.fn();
const softDeleteItem = vi.fn();
const clearChecked = vi.fn();
vi.mock("@/lib/dal/shopping-list", () => ({
  addItem: (...a: unknown[]) => addItem(...a),
  editItem: (...a: unknown[]) => editItem(...a),
  toggleItem: (...a: unknown[]) => toggleItem(...a),
  softDeleteItem: (...a: unknown[]) => softDeleteItem(...a),
  clearChecked: (...a: unknown[]) => clearChecked(...a),
}));
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));

beforeEach(() => { [addItem, editItem, toggleItem, softDeleteItem, clearChecked, revalidatePath].forEach((m) => m.mockReset()); });

describe("addItemAction", () => {
  it("validates, adds, and revalidates", async () => {
    addItem.mockResolvedValue({ id: "i1" });
    const { addItemAction } = await import("@/app/(app)/list/actions");
    const res = await addItemAction({ name: "Milk", category: "dairy" });
    expect(res).toEqual({ ok: true });
    expect(addItem).toHaveBeenCalledWith({ name: "Milk", category: "dairy" });
    expect(revalidatePath).toHaveBeenCalledWith("/list");
  });
  it("rejects invalid input without calling the DAL", async () => {
    const { addItemAction } = await import("@/app/(app)/list/actions");
    const res = await addItemAction({ name: "", category: "snacks" });
    expect("error" in res).toBe(true);
    expect(addItem).not.toHaveBeenCalled();
  });
});

describe("toggleItemAction", () => {
  it("validates and toggles", async () => {
    toggleItem.mockResolvedValue(undefined);
    const { toggleItemAction } = await import("@/app/(app)/list/actions");
    const id = crypto.randomUUID();
    const res = await toggleItemAction({ id, checked: true });
    expect(res).toEqual({ ok: true });
    expect(toggleItem).toHaveBeenCalledWith(id, true);
    expect(revalidatePath).toHaveBeenCalledWith("/list");
  });
});

describe("editItemAction", () => {
  it("validates and edits", async () => {
    editItem.mockResolvedValue(undefined);
    const { editItemAction } = await import("@/app/(app)/list/actions");
    const id = crypto.randomUUID();
    const res = await editItemAction({ id, name: "Eggs" });
    expect(res).toEqual({ ok: true });
    expect(editItem).toHaveBeenCalledWith({ id, name: "Eggs" });
  });
});

describe("deleteItemAction", () => {
  it("validates and soft-deletes", async () => {
    softDeleteItem.mockResolvedValue(undefined);
    const { deleteItemAction } = await import("@/app/(app)/list/actions");
    const id = crypto.randomUUID();
    const res = await deleteItemAction({ id });
    expect(res).toEqual({ ok: true });
    expect(softDeleteItem).toHaveBeenCalledWith(id);
  });
});

describe("clearCheckedAction", () => {
  it("clears checked and revalidates", async () => {
    clearChecked.mockResolvedValue(undefined);
    const { clearCheckedAction } = await import("@/app/(app)/list/actions");
    const res = await clearCheckedAction();
    expect(res).toEqual({ ok: true });
    expect(clearChecked).toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith("/list");
  });
});
