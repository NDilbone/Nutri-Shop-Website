import { describe, it, expect } from "vitest";
import {
  householdNameSchema,
  inviteEmailSchema,
  respondInviteSchema,
} from "@/lib/validation/household";

describe("household validation", () => {
  it("accepts a trimmed household name 1..100 chars", () => {
    expect(householdNameSchema.parse("  Smith family  ")).toBe("Smith family");
  });
  it("rejects an empty or oversized household name", () => {
    expect(householdNameSchema.safeParse("").success).toBe(false);
    expect(householdNameSchema.safeParse("x".repeat(101)).success).toBe(false);
  });
  it("normalizes invite email to trimmed lowercase", () => {
    expect(inviteEmailSchema.parse("  Foo@Example.COM ")).toBe("foo@example.com");
  });
  it("rejects a non-email", () => {
    expect(inviteEmailSchema.safeParse("not-an-email").success).toBe(false);
  });
  it("parses a respond payload with a uuid and boolean", () => {
    const id = "11111111-1111-1111-8111-111111111111";
    expect(respondInviteSchema.parse({ inviteId: id, accept: true })).toEqual({ inviteId: id, accept: true });
    expect(respondInviteSchema.safeParse({ inviteId: "x", accept: true }).success).toBe(false);
  });
});
