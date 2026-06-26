import { NextResponse, type NextRequest } from "next/server";
import { verifySession, verifyStepUp } from "@/lib/dal/session";
import { enforceRateLimit, RateLimitError } from "@/lib/dal/rate-limit";
import { searchQuerySchema } from "@/lib/validation/fdc";
import { searchFoodsCached } from "@/lib/fdc/cache";
import { jsonError, mapFdcError } from "@/lib/fdc/http";

// proxy.ts does NOT gate /api routes — this handler authenticates itself.
export async function GET(request: NextRequest | Request) {
  const session = await verifySession();
  if (!session) return jsonError("UNAUTHENTICATED", "Sign in required", 401);
  if ((await verifyStepUp()) !== "ok")
    return jsonError("MFA_REQUIRED", "Multi-factor step-up required", 403);

  try {
    await enforceRateLimit();
  } catch (e) {
    if (e instanceof RateLimitError) return jsonError("RATE_LIMITED", "Too many requests", 429);
    throw e;
  }

  const sp = new URL(request.url).searchParams;
  const parsed = searchQuerySchema.safeParse({
    q: sp.get("q") ?? undefined,
    dataType: sp.get("dataType")?.split(",").filter(Boolean) ?? undefined,
    page: sp.get("page") ?? undefined,
  });
  if (!parsed.success) return jsonError("INVALID_REQUEST", "Invalid search parameters", 400);

  try {
    const result = await searchFoodsCached({
      query: parsed.data.q,
      dataType: parsed.data.dataType,
      page: parsed.data.page,
    });
    return NextResponse.json({
      query: parsed.data.q,
      page: parsed.data.page,
      totalHits: result.totalHits,
      results: result.foods.map((f) => ({
        fdcId: f.fdcId,
        description: f.description,
        dataType: f.dataType ?? null,
        brandOwner: f.brandOwner ?? null,
        gtinUpc: f.gtinUpc ?? null,
      })),
    });
  } catch (e) {
    return mapFdcError(e);
  }
}
