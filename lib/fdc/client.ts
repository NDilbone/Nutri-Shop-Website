// lib/fdc/client.ts
import "server-only";
import { getServerEnv } from "@/lib/env";
import {
  fdcSearchResponseSchema,
  fdcDetailResponseSchema,
  type FdcSearchResponse,
  type FdcFoodDetail,
} from "@/lib/validation/fdc";

const BASE = "https://api.nal.usda.gov/fdc/v1";

export type FdcErrorKind =
  | "key_missing" | "key_rejected" | "rate_limited"
  | "not_found" | "upstream" | "invalid_response";

export class FdcError extends Error {
  constructor(
    readonly kind: FdcErrorKind,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "FdcError";
  }
}

function apiKey(): string {
  let key: string | undefined;
  try {
    key = getServerEnv().FDC_API_KEY;
  } catch {
    throw new FdcError("key_missing", "FDC_API_KEY is not configured");
  }
  if (!key) throw new FdcError("key_missing", "FDC_API_KEY is not configured");
  return key;
}

async function fdcFetch(path: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set("api_key", apiKey());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch (e) {
    throw new FdcError("upstream", `FDC request failed: ${(e as Error).message}`);
  }

  if (res.status === 429) {
    const ra = res.headers.get("retry-after");
    throw new FdcError("rate_limited", "FDC rate limit exceeded", ra ? Number(ra) : undefined);
  }
  if (res.status === 403) throw new FdcError("key_rejected", "FDC rejected the API key");
  if (res.status === 404) throw new FdcError("not_found", "FDC food not found");
  if (!res.ok) throw new FdcError("upstream", `FDC returned ${res.status}`);

  try {
    return await res.json();
  } catch {
    throw new FdcError("invalid_response", "FDC returned a non-JSON body");
  }
}

export async function searchFoods(args: {
  query: string;
  dataType: string[];
  pageNumber: number;
  pageSize?: number;
}): Promise<FdcSearchResponse> {
  const raw = await fdcFetch("/foods/search", {
    query: args.query,
    dataType: args.dataType.join(","),
    pageNumber: String(args.pageNumber),
    pageSize: String(args.pageSize ?? 25),
  });
  const parsed = fdcSearchResponseSchema.safeParse(raw);
  if (!parsed.success) throw new FdcError("invalid_response", "Unexpected FDC search shape");
  return parsed.data;
}

export async function getFoodDetail(fdcId: number): Promise<FdcFoodDetail> {
  const raw = await fdcFetch(`/food/${fdcId}`, { format: "full" });
  const parsed = fdcDetailResponseSchema.safeParse(raw);
  if (!parsed.success) throw new FdcError("invalid_response", "Unexpected FDC detail shape");
  return parsed.data;
}
