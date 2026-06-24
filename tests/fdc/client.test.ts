// tests/fdc/client.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const okJson = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

describe("FDC client", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("FDC_API_KEY", "test-key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "srv");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("builds the search URL with api_key + dataType and parses the response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({ totalHits: 1, currentPage: 1, totalPages: 1,
               foods: [{ fdcId: 7, description: "Egg" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { searchFoods } = await import("@/lib/fdc/client");

    const res = await searchFoods({ query: "egg", dataType: ["Branded", "Foundation"], pageNumber: 2 });
    expect(res.foods[0].fdcId).toBe(7);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe("/fdc/v1/foods/search");
    expect(url.searchParams.get("api_key")).toBe("test-key");
    expect(url.searchParams.get("dataType")).toBe("Branded,Foundation");
    expect(url.searchParams.get("pageNumber")).toBe("2");
  });

  it("requests detail with format=full", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({ fdcId: 5, description: "B", foodNutrients: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { getFoodDetail } = await import("@/lib/fdc/client");

    await getFoodDetail(5);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe("/fdc/v1/food/5");
    expect(url.searchParams.get("format")).toBe("full");
  });

  it("maps 429 to a rate_limited FdcError with retryAfter", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("{}", { status: 429, headers: { "retry-after": "30" } }),
    ));
    const { getFoodDetail, FdcError } = await import("@/lib/fdc/client");
    await expect(getFoodDetail(5)).rejects.toMatchObject(
      { name: "FdcError", kind: "rate_limited", retryAfter: 30 },
    );
    expect(FdcError).toBeTypeOf("function");
  });

  it("maps 403 to key_rejected and 404 to not_found", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 403 })));
    let mod = await import("@/lib/fdc/client");
    await expect(mod.getFoodDetail(5)).rejects.toMatchObject({ kind: "key_rejected" });

    vi.resetModules();
    vi.stubEnv("FDC_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 404 })));
    mod = await import("@/lib/fdc/client");
    await expect(mod.getFoodDetail(5)).rejects.toMatchObject({ kind: "not_found" });
  });

  it("throws key_missing when FDC_API_KEY is absent", async () => {
    vi.resetModules();
    vi.stubEnv("FDC_API_KEY", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "srv");
    const { searchFoods } = await import("@/lib/fdc/client");
    await expect(
      searchFoods({ query: "x", dataType: ["Branded"], pageNumber: 1 }),
    ).rejects.toMatchObject({ kind: "key_missing" });
  });

  it("maps a malformed body to invalid_response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson({ foods: "nope" })));
    const { searchFoods } = await import("@/lib/fdc/client");
    await expect(
      searchFoods({ query: "x", dataType: ["Branded"], pageNumber: 1 }),
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("does NOT label a non-FDC env error as key_missing", async () => {
    vi.resetModules();
    vi.stubEnv("FDC_API_KEY", "valid-key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", ""); // fails Zod min(1) on SUPABASE key, not FDC
    const { searchFoods } = await import("@/lib/fdc/client");
    await expect(
      searchFoods({ query: "x", dataType: ["Branded"], pageNumber: 1 }),
    ).rejects.toSatisfy((err: unknown) => {
      if (err instanceof Error && "kind" in err) {
        return (err as { kind: string }).kind !== "key_missing";
      }
      return true; // non-FdcError (e.g. ZodError) satisfies the requirement
    });
  });

  it("does not leak the api key in error messages", async () => {
    const stubKey = "super-secret-key-abc123";
    vi.resetModules();
    vi.stubEnv("FDC_API_KEY", stubKey);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "srv");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 403 })));
    const { searchFoods } = await import("@/lib/fdc/client");
    let caughtErr: Error | undefined;
    try {
      await searchFoods({ query: "x", dataType: ["Branded"], pageNumber: 1 });
    } catch (e) {
      caughtErr = e as Error;
    }
    expect(caughtErr).toBeDefined();
    expect(caughtErr!.message).not.toContain(stubKey);
  });
});
