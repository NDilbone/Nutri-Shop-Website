import { NextResponse } from "next/server";
import { FdcError } from "@/lib/fdc/client";

export function jsonError(code: string, message: string, status: number): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

/** Translate an FdcError into a safe client response. Re-throws non-FDC errors. */
export function mapFdcError(e: unknown): NextResponse {
  if (e instanceof FdcError) {
    if (e.kind === "rate_limited") {
      const res = jsonError("UPSTREAM_RATE_LIMITED", "Food database is busy; try again later", 429);
      if (e.retryAfter) res.headers.set("retry-after", String(e.retryAfter));
      return res;
    }
    if (e.kind === "key_missing" || e.kind === "key_rejected") {
      return jsonError("UPSTREAM_UNAVAILABLE", "Food database is unavailable", 503);
    }
    if (e.kind === "not_found") return jsonError("NOT_FOUND", "Food not found", 404);
    return jsonError("UPSTREAM_ERROR", "Food database error", 502);
  }
  throw e as Error;
}
