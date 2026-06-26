import { describe, it, expect } from "vitest";
import { inviteEmailSchema } from "@/lib/validation/admin";

describe("inviteEmailSchema", () => {
  it("trims and lowercases a valid email", () => {
    expect(inviteEmailSchema.parse("  Foo@Bar.COM ")).toBe("foo@bar.com");
  });

  it("accepts an already-normalized email", () => {
    expect(inviteEmailSchema.parse("a@b.io")).toBe("a@b.io");
  });

  it("rejects a non-email string", () => {
    expect(() => inviteEmailSchema.parse("not-an-email")).toThrow();
  });

  it("rejects an empty string", () => {
    expect(() => inviteEmailSchema.parse("")).toThrow();
  });

  it("rejects null (a missing form field — formData.get returns null)", () => {
    expect(() => inviteEmailSchema.parse(null)).toThrow();
  });
});
