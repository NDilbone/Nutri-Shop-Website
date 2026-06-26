import { describe, it, expect } from "vitest";
import { banGuard } from "@/lib/admin/ban-guard";

const base = {
  actorId: "admin-1",
  targetUserId: "user-2",
  banned: true,
  targetIsAdmin: false,
  activeAdminCount: 1,
};

describe("banGuard", () => {
  it("allows banning a normal user", () => {
    expect(banGuard(base)).toEqual({ allowed: true });
  });

  it("blocks banning yourself", () => {
    const r = banGuard({ ...base, targetUserId: "admin-1" });
    expect(r.allowed).toBe(false);
  });

  it("blocks banning the last admin", () => {
    const r = banGuard({ ...base, targetIsAdmin: true, activeAdminCount: 1 });
    expect(r.allowed).toBe(false);
  });

  it("allows banning a non-last admin", () => {
    expect(banGuard({ ...base, targetIsAdmin: true, activeAdminCount: 2 })).toEqual({
      allowed: true,
    });
  });

  it("always allows re-enabling (banned=false), even yourself", () => {
    expect(
      banGuard({ ...base, banned: false, targetUserId: "admin-1", targetIsAdmin: true, activeAdminCount: 1 }),
    ).toEqual({ allowed: true });
  });
});
