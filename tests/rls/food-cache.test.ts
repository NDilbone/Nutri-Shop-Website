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

  it("upsert_food_cache RPC lets an authed user populate the cache", async () => {
    const { error } = await user.rpc("upsert_food_cache", {
      p_fdc_id: 999003, p_data_type: "Foundation", p_description: "RPC Food",
      p_brand_owner: null, p_gtin_upc: null, p_raw: {},
      p_nutrition: { basis: "100g", nutrients: {} },
    });
    expect(error).toBeNull();
    const { data } = await user.from("food_cache").select("description").eq("fdc_id", 999003).single();
    expect(data!.description).toBe("RPC Food");
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

  it("check_and_increment_rate allows up to the limit, then blocks", async () => {
    const u = await makeUser("rate-block@example.com", "Rate-pw-123!");
    const call = () => u.rpc("check_and_increment_rate", { p_limit: 2, p_window_seconds: 60 });
    expect((await call()).data).toBe(true);
    expect((await call()).data).toBe(true);
    expect((await call()).data).toBe(false);
  });

  it("check_and_increment_rate resets after the window elapses", async () => {
    const u = await makeUser("rate-reset@example.com", "Rate-pw-123!");
    const { data: who } = await u.auth.getUser();
    await u.rpc("check_and_increment_rate", { p_limit: 1, p_window_seconds: 60 });
    expect((await u.rpc("check_and_increment_rate", { p_limit: 1, p_window_seconds: 60 })).data).toBe(false);
    await admin().from("api_rate_limit")
      .update({ window_start: new Date(Date.now() - 120_000).toISOString() })
      .eq("user_id", who.user!.id);
    expect((await u.rpc("check_and_increment_rate", { p_limit: 1, p_window_seconds: 60 })).data).toBe(true);
  });
});
