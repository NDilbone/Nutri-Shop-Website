import { describe, it, expect } from "vitest";
import { signOutDecision } from "@/lib/offline/signout-decision";

describe("signOutDecision", () => {
  it("wipes immediately when nothing is dirty", () => {
    expect(signOutDecision(0, true)).toBe("wipe");
    expect(signOutDecision(0, false)).toBe("wipe");
  });
  it("syncs first when dirty and online", () => {
    expect(signOutDecision(3, true)).toBe("sync-then-wipe");
  });
  it("asks for confirmation when dirty and offline", () => {
    expect(signOutDecision(3, false)).toBe("confirm-then-wipe");
  });
});
