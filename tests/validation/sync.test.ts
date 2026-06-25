import { describe, it, expect } from "vitest";
import { syncInputSchema } from "@/lib/validation/sync";

const validItem = {
  id: "11111111-1111-4111-8111-111111111111",
  list_id: "22222222-2222-4222-8222-222222222222",
  name: "Apples",
  quantity: "3",
  category: "produce",
  fdc_id: null,
  checked: false,
  deleted_at: null,
  edited_at: "2026-06-25T10:00:00.000Z",
};

describe("syncInputSchema", () => {
  it("accepts a valid payload", () => {
    expect(syncInputSchema.parse({ dirtyItems: [validItem], cursor: "1970-01-01T00:00:00.000Z" }).dirtyItems)
      .toHaveLength(1);
  });
  it("rejects a non-UUID id", () => {
    expect(() => syncInputSchema.parse({ dirtyItems: [{ ...validItem, id: "nope" }], cursor: "1970-01-01T00:00:00.000Z" }))
      .toThrow();
  });
  it("rejects an unknown category", () => {
    expect(() => syncInputSchema.parse({ dirtyItems: [{ ...validItem, category: "snacks" }], cursor: "1970-01-01T00:00:00.000Z" }))
      .toThrow();
  });
  it("rejects an over-long name", () => {
    expect(() => syncInputSchema.parse({ dirtyItems: [{ ...validItem, name: "x".repeat(201) }], cursor: "1970-01-01T00:00:00.000Z" }))
      .toThrow();
  });
  it("rejects a non-ISO timestamp", () => {
    expect(() => syncInputSchema.parse({ dirtyItems: [{ ...validItem, edited_at: "not-a-date" }], cursor: "1970-01-01T00:00:00.000Z" }))
      .toThrow();
  });
  it("rejects a non-ISO cursor", () => {
    expect(() => syncInputSchema.parse({ dirtyItems: [], cursor: "yesterday" })).toThrow();
  });
});
