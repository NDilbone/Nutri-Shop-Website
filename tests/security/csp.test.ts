import { describe, it, expect } from "vitest";
import { buildCsp } from "@/lib/security/csp";

const SUPA = "https://abc.supabase.co";

describe("buildCsp", () => {
  it("declares worker-src and manifest-src as 'self' (required for the PWA service worker + manifest)", () => {
    const csp = buildCsp("n0nce", { dev: false }, SUPA);
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("manifest-src 'self'");
  });

  it("uses a nonce'd style-src in production and keeps strict-dynamic scripts", () => {
    const csp = buildCsp("n0nce", { dev: false }, SUPA);
    expect(csp).toContain("style-src 'self' 'nonce-n0nce'");
    expect(csp).toContain("script-src 'self' 'nonce-n0nce' 'strict-dynamic'");
  });

  it("relaxes style-src and allows unsafe-eval in dev", () => {
    const csp = buildCsp("n0nce", { dev: true }, SUPA);
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("'unsafe-eval'");
  });

  it("allows Supabase in connect-src including the websocket origin", () => {
    const csp = buildCsp("n0nce", { dev: false }, SUPA);
    expect(csp).toContain(`connect-src 'self' ${SUPA} wss://abc.supabase.co`);
  });
});
