import { describe, it, expect } from "vitest";
import { credentialsSchema } from "@/lib/validation/auth";

describe("credentialsSchema", () => {
  it("accepts a valid email + strong password", () => {
    const r = credentialsSchema.safeParse({ email: "a@b.com", password: "Sup3rSecret!" });
    expect(r.success).toBe(true);
  });
  it("rejects a bad email", () => {
    const r = credentialsSchema.safeParse({ email: "nope", password: "Sup3rSecret!" });
    expect(r.success).toBe(false);
  });
  it("rejects a short password", () => {
    const r = credentialsSchema.safeParse({ email: "a@b.com", password: "short" });
    expect(r.success).toBe(false);
  });
});
