import { describe, it, expect, vi, beforeEach } from "vitest";

const verifySession = vi.fn();
const verifyStepUp = vi.fn();
const enforceRateLimit = vi.fn();
const getFoodDetailCached = vi.fn();

class RateLimitError extends Error { constructor() { super("rate"); this.name = "RateLimitError"; } }
class FdcError extends Error { constructor(readonly kind: string) { super(kind); this.name = "FdcError"; } }

vi.mock("@/lib/dal/session", () => ({
  verifySession: () => verifySession(),
  verifyStepUp: () => verifyStepUp(),
}));
vi.mock("@/lib/dal/rate-limit", () => ({ enforceRateLimit: () => enforceRateLimit(), RateLimitError }));
vi.mock("@/lib/fdc/cache", () => ({ getFoodDetailCached: (id: number) => getFoodDetailCached(id) }));
vi.mock("@/lib/fdc/client", () => ({ FdcError }));

const ctx = (fdcId: string) => ({ params: Promise.resolve({ fdcId }) });
const req = new Request("http://localhost/api/foods/5");

beforeEach(() => {
  verifySession.mockResolvedValue({ userId: "u1" });
  verifyStepUp.mockResolvedValue("ok");
  enforceRateLimit.mockResolvedValue(undefined);
  getFoodDetailCached.mockReset();
});

describe("GET /api/foods/[fdcId] (detail)", () => {
  it("returns the normalized food", async () => {
    getFoodDetailCached.mockResolvedValue({
      food: { fdcId: 5, description: "Egg", dataType: "Branded",
              nutrition: { basis: "100g", nutrients: {} } },
      stale: false,
    });
    const { GET } = await import("@/app/api/foods/[fdcId]/route");
    const res = await GET(req, ctx("5"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fdcId).toBe(5);
    expect(body.stale).toBeUndefined();
  });

  it("flags a stale response", async () => {
    getFoodDetailCached.mockResolvedValue({
      food: { fdcId: 5, description: "Egg", dataType: "Branded",
              nutrition: { basis: "100g", nutrients: {} } },
      stale: true,
    });
    const { GET } = await import("@/app/api/foods/[fdcId]/route");
    const res = await GET(req, ctx("5"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stale).toBe(true);
  });

  it("429s when rate limit is exceeded", async () => {
    enforceRateLimit.mockRejectedValue(new RateLimitError());
    const { GET } = await import("@/app/api/foods/[fdcId]/route");
    expect((await GET(req, ctx("5"))).status).toBe(429);
    enforceRateLimit.mockResolvedValue(undefined);
  });

  it("400s on a non-numeric id", async () => {
    const { GET } = await import("@/app/api/foods/[fdcId]/route");
    expect((await GET(req, ctx("abc"))).status).toBe(400);
  });

  it("401s when unauthenticated", async () => {
    verifySession.mockResolvedValue(null);
    const { GET } = await import("@/app/api/foods/[fdcId]/route");
    expect((await GET(req, ctx("5"))).status).toBe(401);
  });

  it("404s when FDC reports not found", async () => {
    getFoodDetailCached.mockRejectedValue(new FdcError("not_found"));
    const { GET } = await import("@/app/api/foods/[fdcId]/route");
    expect((await GET(req, ctx("5"))).status).toBe(404);
  });
});
