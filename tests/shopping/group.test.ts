import { describe, it, expect } from "vitest";
import { groupItems } from "@/lib/shopping/group";
import type { ShoppingListItem } from "@/lib/shopping/types";

function item(p: Partial<ShoppingListItem> & { id: string }): ShoppingListItem {
  return { name: p.id, quantity: null, category: null, fdcId: null, checked: false, createdAt: "2026-06-24T00:00:00Z", ...p };
}

describe("groupItems", () => {
  it("orders groups by aisle, not insertion order", () => {
    const { groups } = groupItems([
      item({ id: "a", category: "pantry" }),
      item({ id: "b", category: "produce" }),
      item({ id: "c", category: "dairy" }),
    ]);
    expect(groups.map((g) => g.category)).toEqual(["produce", "dairy", "pantry"]);
  });

  it("puts null-category items in the 'other' bucket", () => {
    const { groups } = groupItems([item({ id: "a", category: null })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.category).toBe("other");
  });

  it("omits empty groups", () => {
    const { groups } = groupItems([item({ id: "a", category: "meat" })]);
    expect(groups.map((g) => g.category)).toEqual(["meat"]);
  });

  it("collects checked items into a flat section, out of the groups", () => {
    const { groups, checked } = groupItems([
      item({ id: "a", category: "produce", checked: false }),
      item({ id: "b", category: "produce", checked: true }),
    ]);
    expect(groups.map((g) => g.category)).toEqual(["produce"]);
    expect(groups[0]!.items.map((i) => i.id)).toEqual(["a"]);
    expect(checked.map((i) => i.id)).toEqual(["b"]);
  });

  it("sub-sorts each group and the checked section by createdAt ascending", () => {
    const { groups, checked } = groupItems([
      item({ id: "late", category: "dairy", createdAt: "2026-06-24T10:00:00Z" }),
      item({ id: "early", category: "dairy", createdAt: "2026-06-24T08:00:00Z" }),
      item({ id: "c-late", checked: true, createdAt: "2026-06-24T11:00:00Z" }),
      item({ id: "c-early", checked: true, createdAt: "2026-06-24T09:00:00Z" }),
    ]);
    expect(groups[0]!.items.map((i) => i.id)).toEqual(["early", "late"]);
    expect(checked.map((i) => i.id)).toEqual(["c-early", "c-late"]);
  });
});
