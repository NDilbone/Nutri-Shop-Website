import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn().mockResolvedValue({ rpc }),
}));

beforeEach(() => rpc.mockReset());

describe("enforceRateLimit", () => {
  it("resolves when under the limit", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    const { enforceRateLimit } = await import("@/lib/dal/rate-limit");
    await expect(enforceRateLimit()).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledWith("check_and_increment_rate");
  });

  it("throws RateLimitError when over the limit", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    const { enforceRateLimit, RateLimitError } = await import("@/lib/dal/rate-limit");
    await expect(enforceRateLimit()).rejects.toBeInstanceOf(RateLimitError);
  });

  it("throws on an rpc error", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    const { enforceRateLimit } = await import("@/lib/dal/rate-limit");
    await expect(enforceRateLimit()).rejects.toThrow(/boom/);
  });
});
