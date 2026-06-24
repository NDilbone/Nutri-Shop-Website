import { describe, it, expect, beforeAll } from "vitest";
import { HAS_SUPABASE_TEST_ENV, makeUser } from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

if (process.env.REQUIRE_SUPABASE_TESTS === "1" && !HAS_SUPABASE_TEST_ENV) {
  throw new Error("REQUIRE_SUPABASE_TESTS=1 but SUPABASE_TEST_* env is missing");
}

const SNAPSHOT = { basis: "100g", nutrients: {} };

let userA: SupabaseClient;
let userB: SupabaseClient;
let userAId: string;
let userBId: string;

describe.skipIf(!HAS_SUPABASE_TEST_ENV)("logged_foods RLS isolation", () => {
  beforeAll(async () => {
    userA = await makeUser("logger-a@example.com", "LoggerA-pw-123!");
    userB = await makeUser("logger-b@example.com", "LoggerB-pw-123!");
    userAId = (await userA.auth.getUser()).data.user!.id;
    userBId = (await userB.auth.getUser()).data.user!.id;
  });

  it("a user can insert and read their OWN entry", async () => {
    const { error: insErr } = await userA.from("logged_foods").insert({
      user_id: userAId, fdc_id: 1, description: "A food", meal: "lunch",
      amount_grams: 100, nutrition: SNAPSHOT, logged_on: "2026-06-24",
    });
    expect(insErr).toBeNull();
    const { data, error } = await userA.from("logged_foods")
      .select("id").eq("user_id", userAId).eq("logged_on", "2026-06-24");
    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0);
  });

  it("a user CANNOT insert an entry owned by another user", async () => {
    const { error } = await userB.from("logged_foods").insert({
      user_id: userAId, fdc_id: 2, description: "spoof", meal: "snack",
      amount_grams: 50, nutrition: SNAPSHOT, logged_on: "2026-06-24",
    });
    expect(error).not.toBeNull(); // with-check rejects user_id != auth.uid()
  });

  it("a user CANNOT read another user's entries", async () => {
    const { data, error } = await userB.from("logged_foods").select("id").eq("user_id", userAId);
    expect(error).toBeNull();          // RLS returns zero rows, not an error
    expect(data).toHaveLength(0);
  });

  it("a user CANNOT update another user's entry", async () => {
    await userB.from("logged_foods").update({ amount_grams: 999 }).eq("user_id", userAId);
    const { data } = await userA.from("logged_foods")
      .select("amount_grams").eq("user_id", userAId).eq("fdc_id", 1).limit(1).single();
    expect(data!.amount_grams).not.toBe(999);
  });

  it("soft-deleted rows are excluded when filtering deleted_at is null", async () => {
    const ins = await userA.from("logged_foods").insert({
      user_id: userAId, fdc_id: 3, description: "to delete", meal: "dinner",
      amount_grams: 10, nutrition: SNAPSHOT, logged_on: "2026-06-25",
    }).select("id").single();
    await userA.from("logged_foods").update({ deleted_at: new Date().toISOString() }).eq("id", ins.data!.id);
    const { data } = await userA.from("logged_foods")
      .select("id").eq("logged_on", "2026-06-25").is("deleted_at", null);
    expect(data ?? []).toHaveLength(0);
  });
});
