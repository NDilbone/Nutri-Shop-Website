// lib/fdc/cache.ts
import "server-only";
import { unstable_cache } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { searchFoods, getFoodDetail, FdcError } from "@/lib/fdc/client";
import { normalizeNutrition, type NormalizedNutrition, type RawNutrient } from "@/lib/fdc/nutrients";
import type { FdcFoodDetail, FdcSearchResponse } from "@/lib/validation/fdc";

const SEARCH_TTL = 120; // seconds
const DETAIL_TTL = 900; // seconds
const L2_FRESH_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export type NormalizedFood = {
  fdcId: number;
  description: string;
  dataType: string | null;
  nutrition: NormalizedNutrition;
};

export async function searchFoodsCached(args: {
  query: string;
  dataType: string[];
  page: number;
}): Promise<FdcSearchResponse> {
  const run = unstable_cache(
    () => searchFoods({ query: args.query, dataType: args.dataType, pageNumber: args.page }),
    ["foods-search", args.query, args.dataType.join(","), String(args.page)],
    { revalidate: SEARCH_TTL },
  );
  return run();
}

function toNormalized(detail: FdcFoodDetail): NormalizedFood {
  const foodNutrients: RawNutrient[] = detail.foodNutrients.map((fn) => ({
    id: fn.nutrient.id,
    amount: fn.amount ?? null,
    unitName: fn.nutrient.unitName ?? "",
  }));
  const serving =
    detail.servingSize != null
      ? {
          amount: detail.servingSize,
          unit: detail.servingSizeUnit ?? "g",
          household: detail.householdServingFullText ?? null,
        }
      : undefined;
  return {
    fdcId: detail.fdcId,
    description: detail.description,
    dataType: detail.dataType ?? null,
    nutrition: normalizeNutrition({ dataType: detail.dataType ?? "", foodNutrients, serving }),
  };
}

function rowToFood(row: {
  fdc_id: number; description: string; data_type: string | null; nutrition: NormalizedNutrition;
}): NormalizedFood {
  return { fdcId: row.fdc_id, description: row.description, dataType: row.data_type, nutrition: row.nutrition };
}

export async function getFoodDetailCached(
  fdcId: number,
): Promise<{ food: NormalizedFood; stale: boolean }> {
  const supabase = await createClient();

  // L2: durable Postgres cache
  const { data: row } = await supabase
    .from("food_cache")
    .select("fdc_id, description, data_type, nutrition, fetched_at")
    .eq("fdc_id", fdcId)
    .maybeSingle();

  if (row && Date.now() - new Date(row.fetched_at).getTime() < L2_FRESH_MS) {
    return { food: rowToFood(row), stale: false };
  }

  // L2 miss / stale → L1-wrapped fetch → normalize → upsert
  try {
    const run = unstable_cache(
      () => getFoodDetail(fdcId),
      ["foods-detail", String(fdcId)],
      { revalidate: DETAIL_TTL },
    );
    const detail = await run();
    const food = toNormalized(detail);
    // Cache write uses the service-role client (bypasses RLS). There is no
    // authenticated write path, so an invited user cannot poison the shared cache.
    await createAdminClient().from("food_cache").upsert({
      fdc_id: food.fdcId,
      data_type: food.dataType,
      description: food.description,
      brand_owner: detail.brandOwner ?? null,
      gtin_upc: detail.gtinUpc ?? null,
      raw: detail,
      nutrition: food.nutrition,
      fetched_at: new Date().toISOString(),
    });
    return { food, stale: false };
  } catch (e) {
    // FDC over-limit → serve a stale row if we have one, rather than failing.
    if (e instanceof FdcError && e.kind === "rate_limited" && row) {
      return { food: rowToFood(row), stale: true };
    }
    throw e;
  }
}
