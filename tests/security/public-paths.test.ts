import { describe, it, expect } from "vitest";
import { isPublicPath } from "@/lib/security/public-paths";

describe("isPublicPath", () => {
  it("treats the offline fallback as public so it precaches/renders without a session", () => {
    expect(isPublicPath("/~offline")).toBe(true);
  });
  it("keeps the existing auth paths public", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/signup")).toBe(true);
    expect(isPublicPath("/auth/confirm")).toBe(true);
  });
  it("gates authenticated app routes", () => {
    expect(isPublicPath("/today")).toBe(false);
    expect(isPublicPath("/list")).toBe(false);
    expect(isPublicPath("/")).toBe(false);
  });
});
