import { describe, it, expect } from "vitest";
import { assertOwnership } from "@/lib/dal/session";

describe("assertOwnership", () => {
  it("passes when ids match", () => {
    expect(() => assertOwnership("u1", "u1")).not.toThrow();
  });
  it("throws Forbidden when ids differ", () => {
    expect(() => assertOwnership("u1", "u2")).toThrow("Forbidden");
  });
});
