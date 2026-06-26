import { NextResponse } from "next/server";
import { verifySession, verifyStepUp } from "@/lib/dal/session";
import { enforceRateLimit, RateLimitError } from "@/lib/dal/rate-limit";
import { fdcIdSchema } from "@/lib/validation/fdc";
import { getFoodDetailCached } from "@/lib/fdc/cache";
import { jsonError, mapFdcError } from "@/lib/fdc/http";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ fdcId: string }> },
) {
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

  const { fdcId } = await params;
  const parsed = fdcIdSchema.safeParse(fdcId);
  if (!parsed.success) return jsonError("INVALID_REQUEST", "Invalid food id", 400);

  try {
    const { food, stale } = await getFoodDetailCached(parsed.data);
    return NextResponse.json({ ...food, ...(stale ? { stale: true } : {}) });
  } catch (e) {
    return mapFdcError(e);
  }
}
