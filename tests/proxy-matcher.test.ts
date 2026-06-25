import { describe, it, expect } from "vitest";
import { config } from "@/proxy";

describe("proxy matcher", () => {
  it("excludes service-worker, manifest, favicon and static assets from auth gating", () => {
    const source = (config.matcher[0] as { source: string }).source;
    for (const fragment of ["sw.js", "manifest.webmanifest", "favicon.ico", "_next/static", "_next/image", "api"]) {
      expect(source).toContain(fragment);
    }
  });
});
