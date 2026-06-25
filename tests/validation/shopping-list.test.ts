import { describe, it, expect } from "vitest";
import { addItemSchema, editItemSchema, toggleItemSchema, deleteItemSchema } from "@/lib/validation/shopping-list";

describe("addItemSchema", () => {
  it("accepts a minimal free-text item", () => {
    expect(addItemSchema.safeParse({ name: "Milk" }).success).toBe(true);
  });
  it("accepts a fully-specified USDA-linked item", () => {
    const r = addItemSchema.safeParse({ name: "Chicken breast", quantity: "2 lbs", category: "meat", fdcId: 171077 });
    expect(r.success).toBe(true);
  });
  it("rejects an empty or oversized name", () => {
    expect(addItemSchema.safeParse({ name: "" }).success).toBe(false);
    expect(addItemSchema.safeParse({ name: "x".repeat(201) }).success).toBe(false);
  });
  it("rejects an unknown category and a non-positive fdcId", () => {
    expect(addItemSchema.safeParse({ name: "Milk", category: "snacks" }).success).toBe(false);
    expect(addItemSchema.safeParse({ name: "Milk", fdcId: 0 }).success).toBe(false);
  });
});

describe("editItemSchema", () => {
  it("requires a uuid id and allows partial / nullable fields", () => {
    expect(editItemSchema.safeParse({ id: crypto.randomUUID(), name: "Eggs" }).success).toBe(true);
    expect(editItemSchema.safeParse({ id: crypto.randomUUID(), quantity: null, category: null }).success).toBe(true);
    expect(editItemSchema.safeParse({ name: "Eggs" }).success).toBe(false);
  });
});

describe("toggleItemSchema", () => {
  it("requires a uuid id and a boolean", () => {
    expect(toggleItemSchema.safeParse({ id: crypto.randomUUID(), checked: true }).success).toBe(true);
    expect(toggleItemSchema.safeParse({ id: crypto.randomUUID(), checked: "yes" }).success).toBe(false);
  });
});

describe("deleteItemSchema", () => {
  it("requires a uuid id", () => {
    expect(deleteItemSchema.safeParse({ id: crypto.randomUUID() }).success).toBe(true);
    expect(deleteItemSchema.safeParse({ id: "nope" }).success).toBe(false);
  });
});
