// tests/rls/food-cache.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { HAS_SUPABASE_TEST_ENV, makeUser, admin } from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

if (process.env.REQUIRE_SUPABASE_TESTS === "1" && !HAS_SUPABASE_TEST_ENV) {
  throw new Error("REQUIRE_SUPABASE_TESTS=1 but SUPABASE_TEST_* env is missing");
}

describe.skipIf(!HAS_SUPABASE_TEST_ENV)("food_cache + api_rate_limit RLS", () => {
  let user: SupabaseClient;

  beforeAll(async () => {
    user = await makeUser("foodcache@example.com", "Food-pw-123!");
    // Seed via service-role (bypasses RLS) — this is the ONLY sanctioned write path.
    await admin().from("food_cache").upsert({
      fdc_id: 999001, data_type: "Branded", description: "Seed Food",
      raw: {}, nutrition: { basis: "100g", nutrients: {} },
    });
  });

  it("an authenticated user CAN read food_cache (public reference data)", async () => {
    const { data, error } = await user.from("food_cache").select("fdc_id").eq("fdc_id", 999001);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("an authenticated user CANNOT write food_cache directly (no insert policy)", async () => {
    const { error } = await user.from("food_cache").insert({
      fdc_id: 999002, data_type: "x", description: "y", raw: {}, nutrition: {},
    });
    expect(error).not.toBeNull();
  });

  it("the cache-poisoning RPC is gone — authed user cannot write food_cache via upsert_food_cache", async () => {
    // upsert_food_cache was removed; calling it must fail (function does not exist / not granted),
    // and no row may be created. This pins the closure of the cache-poisoning vector.
    const { error } = await user.rpc("upsert_food_cache", {
      p_fdc_id: 999003, p_data_type: "Foundation", p_description: "junk",
      p_brand_owner: null, p_gtin_upc: null, p_raw: {},
      p_nutrition: { basis: "100g", nutrients: {} },
    });
    expect(error).not.toBeNull();
    const { data } = await admin().from("food_cache").select("fdc_id").eq("fdc_id", 999003);
    expect(data ?? []).toHaveLength(0);
  });

  it("api_rate_limit is default-deny for an authenticated user", async () => {
    const { data: who } = await user.auth.getUser();
    // Seed a row via service-role (bypasses RLS) so there IS data to be blocked.
    await admin().from("api_rate_limit").upsert({
      user_id: who.user!.id,
      window_start: new Date().toISOString(),
      request_count: 1,
    });
    const { data, error } = await user.from("api_rate_limit").select("user_id");
    expect(error).toBeNull();            // Supabase RLS denies silently (no error)
    expect(data ?? []).toHaveLength(0);  // user cannot see even their own seeded row
  });

  it("check_and_increment_rate cannot be called with client-controlled limit/window", async () => {
    // The function takes NO arguments; an attempt to pass a forged limit/window must fail,
    // proving the throttle config is not client-tunable.
    const u = await makeUser("rate-args@example.com", "Rate-pw-123!");
    const { error } = await u.rpc("check_and_increment_rate", { p_limit: 999999, p_window_seconds: 0 });
    expect(error).not.toBeNull(); // no overload with these parameters exists
  });

  it("check_and_increment_rate (hard-coded 60/60s) returns true up to the limit, then false", async () => {
    const u = await makeUser("rate-block@example.com", "Rate-pw-123!");
    const { data: who } = await u.auth.getUser();
    // Seed the counter to one below the hard-coded limit (60), window fresh.
    await admin().from("api_rate_limit").upsert({
      user_id: who.user!.id,
      window_start: new Date().toISOString(),
      request_count: 59,
    });
    expect((await u.rpc("check_and_increment_rate")).data).toBe(true);  // 60 <= 60
    expect((await u.rpc("check_and_increment_rate")).data).toBe(false); // 61 > 60
  });

  it("check_and_increment_rate resets the count after the window elapses", async () => {
    const u = await makeUser("rate-reset@example.com", "Rate-pw-123!");
    const { data: who } = await u.auth.getUser();
    // Seed an exhausted counter whose window started > 60s ago.
    await admin().from("api_rate_limit").upsert({
      user_id: who.user!.id,
      window_start: new Date(Date.now() - 120_000).toISOString(),
      request_count: 60,
    });
    expect((await u.rpc("check_and_increment_rate")).data).toBe(true); // window expired → reset to 1
  });
});
