import { describe, it, expect, vi, beforeEach } from "vitest";

const verifySession = vi.fn();
const enforceRateLimit = vi.fn();
const searchFoodsCached = vi.fn();

class RateLimitError extends Error { constructor() { super("rate"); this.name = "RateLimitError"; } }
class FdcError extends Error { constructor(readonly kind: string, readonly retryAfter?: number) { super(kind); this.name = "FdcError"; } }

vi.mock("@/lib/dal/session", () => ({ verifySession: () => verifySession() }));
vi.mock("@/lib/dal/rate-limit", () => ({
  enforceRateLimit: () => enforceRateLimit(),
  RateLimitError,
}));
vi.mock("@/lib/fdc/cache", () => ({ searchFoodsCached: (a: unknown) => searchFoodsCached(a) }));
vi.mock("@/lib/fdc/client", () => ({ FdcError }));

const req = (qs: string) => new Request(`http://localhost/api/foods${qs}`);

beforeEach(() => {
  verifySession.mockResolvedValue({ userId: "u1" });
  enforceRateLimit.mockResolvedValue(undefined);
  searchFoodsCached.mockReset();
});

describe("GET /api/foods (search)", () => {
  it("returns slim results for an authenticated request", async () => {
    searchFoodsCached.mockResolvedValue({
      totalHits: 1, currentPage: 1, totalPages: 1,
      foods: [{ fdcId: 7, description: "Egg", dataType: "Branded", brandOwner: "X", gtinUpc: "0" }],
    });
    const { GET } = await import("@/app/api/foods/route");
    const res = await GET(req("?q=egg"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0]).toEqual({
      fdcId: 7, description: "Egg", dataType: "Branded", brandOwner: "X", gtinUpc: "0",
    });
  });

  it("401s when unauthenticated", async () => {
    verifySession.mockResolvedValue(null);
    const { GET } = await import("@/app/api/foods/route");
    expect((await GET(req("?q=egg"))).status).toBe(401);
  });

  it("429s when throttled", async () => {
    enforceRateLimit.mockRejectedValue(new RateLimitError());
    const { GET } = await import("@/app/api/foods/route");
    expect((await GET(req("?q=egg"))).status).toBe(429);
  });

  it("400s on a missing query", async () => {
    const { GET } = await import("@/app/api/foods/route");
    expect((await GET(req(""))).status).toBe(400);
  });

  it("maps an FDC rate-limit to 429", async () => {
    searchFoodsCached.mockRejectedValue(new FdcError("rate_limited", 30));
    const { GET } = await import("@/app/api/foods/route");
    const res = await GET(req("?q=egg"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
  });

  it("preserves a zero Retry-After header", async () => {
    searchFoodsCached.mockRejectedValue(new FdcError("rate_limited", 0));
    const { GET } = await import("@/app/api/foods/route");
    const res = await GET(req("?q=egg"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("0");
  });
});
