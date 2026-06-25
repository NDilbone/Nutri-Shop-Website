import { describe, it, expect } from "vitest";
import manifest from "@/app/manifest";

describe("web manifest", () => {
  const m = manifest();
  it("lands an installed user on /today", () => {
    expect(m.start_url).toBe("/today");
    expect(m.scope).toBe("/");
  });
  it("uses the dark-editorial theme/background color", () => {
    expect(m.theme_color).toBe("#0f1411");
    expect(m.background_color).toBe("#0f1411");
  });
  it("declares a standalone display", () => {
    expect(m.display).toBe("standalone");
  });
  it("ships a maskable icon and the 192/512 set", () => {
    const purposes = (m.icons ?? []).map((i) => i.purpose ?? "any");
    expect(purposes).toContain("maskable");
    const sizes = (m.icons ?? []).map((i) => i.sizes);
    expect(sizes).toEqual(expect.arrayContaining(["192x192", "512x512"]));
  });
});
