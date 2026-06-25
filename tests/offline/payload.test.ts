import { describe, it, expect } from "vitest";
import { toServerItem, nextCursor } from "@/lib/offline/payload";

describe("toServerItem", () => {
  it("maps a decrypted row to the snake_case server payload", () => {
    expect(
      toServerItem({
        id: "i1", listId: "l1", name: "Eggs", quantity: "12", category: "dairy",
        fdcId: 999, checked: true, editedAt: "2026-06-25T10:00:00.000Z", deletedAt: null,
      }),
    ).toEqual({
      id: "i1", list_id: "l1", name: "Eggs", quantity: "12", category: "dairy",
      fdc_id: 999, checked: true, deleted_at: null, edited_at: "2026-06-25T10:00:00.000Z",
    });
  });

  it("preserves nulls for optional fields", () => {
    const out = toServerItem({
      id: "i2", listId: "l1", name: "Bread", quantity: null, category: null,
      fdcId: null, checked: false, editedAt: "2026-06-25T10:00:00.000Z", deletedAt: null,
    });
    expect(out.quantity).toBeNull();
    expect(out.category).toBeNull();
    expect(out.fdc_id).toBeNull();
  });
});

describe("nextCursor", () => {
  const C = "2026-06-25T10:00:00.000Z";
  it("returns the max updated_at seen", () => {
    expect(nextCursor(["2026-06-25T10:30:00.000Z", "2026-06-25T11:00:00.000Z"], C))
      .toBe("2026-06-25T11:00:00.000Z");
  });
  it("returns the previous cursor when nothing changed", () => {
    expect(nextCursor([], C)).toBe(C);
  });
  it("never regresses below the previous cursor", () => {
    expect(nextCursor(["2026-06-25T09:00:00.000Z"], C)).toBe(C);
  });
});
