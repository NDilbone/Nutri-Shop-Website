import { describe, it, expect, beforeAll } from "vitest";
import { HAS_SUPABASE_TEST_ENV, makeUser } from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

if (process.env.REQUIRE_SUPABASE_TESTS === "1" && !HAS_SUPABASE_TEST_ENV) {
  throw new Error("REQUIRE_SUPABASE_TESTS=1 but SUPABASE_TEST_* env is missing");
}

let userA: SupabaseClient;
let userB: SupabaseClient;
let userAId: string;
let listAId: string;

describe.skipIf(!HAS_SUPABASE_TEST_ENV)("shopping_list RLS isolation", () => {
  beforeAll(async () => {
    userA = await makeUser("shopper-a@example.com", "ShopperA-pw-123!");
    userB = await makeUser("shopper-b@example.com", "ShopperB-pw-123!");
    userAId = (await userA.auth.getUser()).data.user!.id;
    const { data, error } = await userA
      .from("shopping_lists")
      .insert({ owner_id: userAId, is_default: true })
      .select("id")
      .single();
    if (error) throw error;
    listAId = data!.id;
  });

  it("a user can add an item to their own list", async () => {
    const { error } = await userA.from("shopping_list_items").insert({ list_id: listAId, name: "Milk" });
    expect(error).toBeNull();
  });

  it("a user CANNOT read another user's list", async () => {
    const { data, error } = await userB.from("shopping_lists").select("id").eq("id", listAId);
    expect(error).toBeNull(); // RLS returns zero rows, not an error
    expect(data).toHaveLength(0);
  });

  it("a user CANNOT read another user's items", async () => {
    const { data, error } = await userB.from("shopping_list_items").select("id").eq("list_id", listAId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("a user CANNOT insert an item into another user's list", async () => {
    const { error } = await userB.from("shopping_list_items").insert({ list_id: listAId, name: "spoof" });
    expect(error).not.toBeNull(); // with-check EXISTS(owner) rejects it
  });

  it("a user CANNOT update another user's item", async () => {
    const ins = await userA.from("shopping_list_items").insert({ list_id: listAId, name: "Eggs" }).select("id").single();
    const { data: updated, error: updErr } = await userB
      .from("shopping_list_items").update({ name: "hacked" }).eq("id", ins.data!.id).select();
    expect(updErr).toBeNull();      // RLS denies silently: no error
    expect(updated).toHaveLength(0); // 0 rows affected
    const { data } = await userA.from("shopping_list_items").select("name").eq("id", ins.data!.id).single();
    expect(data!.name).not.toBe("hacked");
  });

  it("a user CANNOT delete another user's item", async () => {
    const ins = await userA.from("shopping_list_items").insert({ list_id: listAId, name: "Bread" }).select("id").single();
    const { data: deleted, error: delErr } = await userB
      .from("shopping_list_items").delete().eq("id", ins.data!.id).select(); // RLS USING denies → 0 rows affected
    expect(delErr).toBeNull();
    expect(deleted).toHaveLength(0);
    const { data } = await userA.from("shopping_list_items").select("id").eq("id", ins.data!.id).single();
    expect(data).not.toBeNull(); // still there, read back as the owner
  });

  it("a user CANNOT delete another user's list", async () => {
    const { data: deleted, error: delErr } = await userB.from("shopping_lists").delete().eq("id", listAId).select();
    expect(delErr).toBeNull();
    expect(deleted).toHaveLength(0);
    const { data } = await userA.from("shopping_lists").select("id").eq("id", listAId).single();
    expect(data).not.toBeNull();
  });

  it("soft-deleted items are excluded when filtering deleted_at is null", async () => {
    const ins = await userA.from("shopping_list_items").insert({ list_id: listAId, name: "ToClear", checked: true }).select("id").single();
    await userA.from("shopping_list_items").update({ deleted_at: new Date().toISOString() }).eq("id", ins.data!.id);
    const { data } = await userA.from("shopping_list_items").select("id").eq("id", ins.data!.id).is("deleted_at", null);
    expect(data ?? []).toHaveLength(0);
  });
});
