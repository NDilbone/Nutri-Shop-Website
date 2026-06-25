import { describe, it, expect } from "vitest";
import { reconcile } from "@/lib/offline/reconcile";

const T0 = "2026-06-25T10:00:00.000Z";
const T1 = "2026-06-25T11:00:00.000Z";

describe("reconcile (last-edit-wins)", () => {
  it("inserts when the row is unknown locally", () => {
    expect(reconcile(null, { id: "a", editedAt: T1, deletedAt: null })).toBe("insert");
  });

  it("overwrites a clean local row with the server row", () => {
    expect(
      reconcile({ id: "a", editedAt: T0, deletedAt: null, dirty: false }, { id: "a", editedAt: T0, deletedAt: null }),
    ).toBe("overwrite");
  });

  it("server wins over a dirty local row when strictly newer", () => {
    expect(
      reconcile({ id: "a", editedAt: T0, deletedAt: null, dirty: true }, { id: "a", editedAt: T1, deletedAt: null }),
    ).toBe("overwrite");
  });

  it("local wins over the server row when the dirty local edit is newer", () => {
    expect(
      reconcile({ id: "a", editedAt: T1, deletedAt: null, dirty: true }, { id: "a", editedAt: T0, deletedAt: null }),
    ).toBe("keep-local");
  });

  it("on an exact tie a dirty local row is kept (strict >)", () => {
    expect(
      reconcile({ id: "a", editedAt: T1, deletedAt: null, dirty: true }, { id: "a", editedAt: T1, deletedAt: null }),
    ).toBe("keep-local");
  });

  it("a server tombstone overwrites a clean local row", () => {
    expect(
      reconcile({ id: "a", editedAt: T0, deletedAt: null, dirty: false }, { id: "a", editedAt: T1, deletedAt: T1 }),
    ).toBe("overwrite");
  });
});
