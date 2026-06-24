import { describe, it, expect } from "vitest";
import nextConfig from "@/next.config";

describe("security headers", () => {
  it("declares the OWASP header set for all routes", async () => {
    const headers = await nextConfig.headers!();
    const all = headers.find((h) => h.source === "/(.*)");
    const keys = all!.headers.map((h) => h.key.toLowerCase());
    expect(keys).toEqual(
      expect.arrayContaining([
        "strict-transport-security",
        "x-content-type-options",
        "referrer-policy",
        "x-frame-options",
        "permissions-policy",
      ]),
    );
  });
});
