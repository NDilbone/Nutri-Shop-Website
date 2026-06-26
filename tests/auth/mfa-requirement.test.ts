import { describe, it, expect } from "vitest";
import { mfaRequirement } from "@/lib/auth/mfa-requirement";

describe("mfaRequirement", () => {
  it("member, no factor, aal1 → ok (optional, allowed)", () => {
    expect(mfaRequirement({ isAdmin: false, hasVerifiedFactor: false, currentAAL: "aal1" })).toBe("ok");
  });
  it("opted-in member, aal1 → challenge", () => {
    expect(mfaRequirement({ isAdmin: false, hasVerifiedFactor: true, currentAAL: "aal1" })).toBe("challenge");
  });
  it("opted-in member, aal2 → ok", () => {
    expect(mfaRequirement({ isAdmin: false, hasVerifiedFactor: true, currentAAL: "aal2" })).toBe("ok");
  });
  it("admin, no factor, aal1 → enroll (forced)", () => {
    expect(mfaRequirement({ isAdmin: true, hasVerifiedFactor: false, currentAAL: "aal1" })).toBe("enroll");
  });
  it("admin, has factor, aal1 → challenge", () => {
    expect(mfaRequirement({ isAdmin: true, hasVerifiedFactor: true, currentAAL: "aal1" })).toBe("challenge");
  });
  it("admin, has factor, aal2 → ok", () => {
    expect(mfaRequirement({ isAdmin: true, hasVerifiedFactor: true, currentAAL: "aal2" })).toBe("ok");
  });
  it("aal2 always resolves ok even without a recorded factor (unreachable, defensive)", () => {
    expect(mfaRequirement({ isAdmin: false, hasVerifiedFactor: false, currentAAL: "aal2" })).toBe("ok");
    expect(mfaRequirement({ isAdmin: true, hasVerifiedFactor: false, currentAAL: "aal2" })).toBe("ok");
  });
});
