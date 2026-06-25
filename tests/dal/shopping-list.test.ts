import { describe, it, expect, vi, beforeEach } from "vitest";

const verifySession = vi.fn();
vi.mock("@/lib/dal/session", () => ({ verifySession: (...a: unknown[]) => verifySession(...a) }));

const from = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn().mockResolvedValue({ from }) }));

beforeEach(() => { verifySession.mockReset(); from.mockReset(); verifySession.mockResolvedValue({ userId: "u1" }); });

// select("id").eq("owner_id").eq("is_default").is("deleted_at").maybeSingle()
function listSelect(result: { data: unknown; error: unknown }) {
  return { select: () => ({ eq: () => ({ eq: () => ({ is: () => ({ maybeSingle: () => Promise.resolve(result) }) }) }) }) };
}
// insert({...}).select("id").single()
function insertSingle(result: { data: unknown; error: unknown }, capture?: (row: unknown) => void) {
  return { insert: (row: unknown) => { capture?.(row); return { select: () => ({ single: () => Promise.resolve(result) }) }; } };
}

describe("getOrCreateDefaultList", () => {
  it("returns the existing default list without inserting", async () => {
    from.mockReturnValueOnce(listSelect({ data: { id: "L1" }, error: null }));
    const { getOrCreateDefaultList } = await import("@/lib/dal/shopping-list");
    expect(await getOrCreateDefaultList()).toEqual({ id: "L1" });
    expect(from).toHaveBeenCalledTimes(1);
  });

  it("creates a default list when none exists", async () => {
    from.mockReturnValueOnce(listSelect({ data: null, error: null }));
    const captured: unknown[] = [];
    from.mockReturnValueOnce(insertSingle({ data: { id: "L2" }, error: null }, (r) => captured.push(r)));
    const { getOrCreateDefaultList } = await import("@/lib/dal/shopping-list");
    expect(await getOrCreateDefaultList()).toEqual({ id: "L2" });
    expect(captured[0]).toEqual({ owner_id: "u1", is_default: true });
  });

  it("throws when unauthenticated", async () => {
    verifySession.mockResolvedValue(null);
    const { getOrCreateDefaultList } = await import("@/lib/dal/shopping-list");
    await expect(getOrCreateDefaultList()).rejects.toThrow(/Unauthenticated/);
  });
});

describe("addItem", () => {
  it("resolves the default list then inserts the item with nulls for omitted fields", async () => {
    from.mockReturnValueOnce(listSelect({ data: { id: "L1" }, error: null }));
    let row: Record<string, unknown> = {};
    from.mockReturnValueOnce(insertSingle({ data: { id: "i1" }, error: null }, (r) => { row = r as Record<string, unknown>; }));
    const { addItem } = await import("@/lib/dal/shopping-list");
    const res = await addItem({ name: "Milk" });
    expect(res).toEqual({ id: "i1" });
    expect(row).toEqual({ list_id: "L1", name: "Milk", quantity: null, category: null, fdc_id: null });
  });

  it("passes through quantity/category/fdcId when provided", async () => {
    from.mockReturnValueOnce(listSelect({ data: { id: "L1" }, error: null }));
    let row: Record<string, unknown> = {};
    from.mockReturnValueOnce(insertSingle({ data: { id: "i2" }, error: null }, (r) => { row = r as Record<string, unknown>; }));
    const { addItem } = await import("@/lib/dal/shopping-list");
    await addItem({ name: "Chicken", quantity: "2 lbs", category: "meat", fdcId: 171077 });
    expect(row).toEqual({ list_id: "L1", name: "Chicken", quantity: "2 lbs", category: "meat", fdc_id: 171077 });
  });
});

describe("toggleItem", () => {
  it("updates checked scoped by id", async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq });
    from.mockReturnValue({ update });
    const { toggleItem } = await import("@/lib/dal/shopping-list");
    await toggleItem("i1", true);
    expect(update).toHaveBeenCalledWith({ checked: true });
    expect(eq).toHaveBeenCalledWith("id", "i1");
  });
});

describe("editItem", () => {
  it("updates only the provided fields", async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq });
    from.mockReturnValue({ update });
    const { editItem } = await import("@/lib/dal/shopping-list");
    await editItem({ id: "i1", name: "Eggs", category: null });
    expect(update).toHaveBeenCalledWith({ name: "Eggs", category: null });
    expect(eq).toHaveBeenCalledWith("id", "i1");
  });

  it("does not call supabase when the patch is empty", async () => {
    const { editItem } = await import("@/lib/dal/shopping-list");
    await editItem({ id: "00000000-0000-0000-0000-000000000000" });
    expect(from).not.toHaveBeenCalled();
  });
});

describe("softDeleteItem", () => {
  it("sets deleted_at scoped by id", async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq });
    from.mockReturnValue({ update });
    const { softDeleteItem } = await import("@/lib/dal/shopping-list");
    await softDeleteItem("i1");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ deleted_at: expect.any(String) }));
    expect(eq).toHaveBeenCalledWith("id", "i1");
  });
});

describe("clearChecked", () => {
  it("soft-deletes checked rows scoped to the default list", async () => {
    from.mockReturnValueOnce(listSelect({ data: { id: "L1" }, error: null }));
    const is = vi.fn().mockResolvedValue({ error: null });
    const eqChecked = vi.fn().mockReturnValue({ is });
    const eqList = vi.fn().mockReturnValue({ eq: eqChecked });
    const update = vi.fn().mockReturnValue({ eq: eqList });
    from.mockReturnValueOnce({ update });
    const { clearChecked } = await import("@/lib/dal/shopping-list");
    await clearChecked();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ deleted_at: expect.any(String) }));
    expect(eqList).toHaveBeenCalledWith("list_id", "L1");
    expect(eqChecked).toHaveBeenCalledWith("checked", true);
  });
});

describe("getItems", () => {
  it("maps DB rows to ShoppingListItem for the default list", async () => {
    from.mockReturnValueOnce(listSelect({ data: { id: "L1" }, error: null }));
    const rows = [{ id: "i1", name: "Milk", quantity: "1 gal", category: "dairy", fdc_id: null, checked: false, created_at: "2026-06-24T00:00:00Z" }];
    const is = vi.fn().mockResolvedValue({ data: rows, error: null });
    const eq = vi.fn().mockReturnValue({ is });
    const select = vi.fn().mockReturnValue({ eq });
    from.mockReturnValueOnce({ select });
    const { getItems } = await import("@/lib/dal/shopping-list");
    const items = await getItems();
    expect(items).toEqual([{ id: "i1", name: "Milk", quantity: "1 gal", category: "dairy", fdcId: null, checked: false, createdAt: "2026-06-24T00:00:00Z" }]);
    expect(eq).toHaveBeenCalledWith("list_id", "L1");
  });
});
