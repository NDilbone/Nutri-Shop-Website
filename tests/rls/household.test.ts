// tests/rls/household.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { HAS_SUPABASE_TEST_ENV, makeUser, admin } from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

if (process.env.REQUIRE_SUPABASE_TESTS === "1" && !HAS_SUPABASE_TEST_ENV) {
  throw new Error("REQUIRE_SUPABASE_TESTS=1 but SUPABASE_TEST_* env is missing");
}

let userA: SupabaseClient, userB: SupabaseClient, userC: SupabaseClient;
let aId: string, bId: string;
let householdId: string, sharedListId: string;

describe.skipIf(!HAS_SUPABASE_TEST_ENV)("household sharing — access RLS", () => {
  beforeAll(async () => {
    userA = await makeUser("hh-a@example.com", "HhA-pw-1234!");
    userB = await makeUser("hh-b@example.com", "HhB-pw-1234!");
    userC = await makeUser("hh-c@example.com", "HhC-pw-1234!");
    aId = (await userA.auth.getUser()).data.user!.id;
    bId = (await userB.auth.getUser()).data.user!.id;
    await userC.auth.getUser(); // confirm sign-in; cId not needed in assertions

    // Seed a household with A + B as members and a shared list, via service role.
    const svc = admin();
    const { data: hh, error: hhErr } = await svc
      .from("households").insert({ name: "Test household", created_by: aId }).select("id").single();
    if (hhErr) throw hhErr;
    householdId = hh!.id;
    const { error: mErr } = await svc.from("household_members")
      .insert([{ household_id: householdId, user_id: aId }, { household_id: householdId, user_id: bId }]);
    if (mErr) throw mErr;
    const { data: list, error: lErr } = await svc.from("shopping_lists")
      .insert({ owner_id: aId, is_default: false, household_id: householdId, name: "Household list" })
      .select("id").single();
    if (lErr) throw lErr;
    sharedListId = list!.id;
  });

  it("a member (B) can read the shared list row", async () => {
    const { data } = await userB.from("shopping_lists").select("id").eq("id", sharedListId);
    expect(data).toHaveLength(1);
  });

  it("a member (B) can insert an item into the shared list", async () => {
    const { error } = await userB.from("shopping_list_items").insert({ list_id: sharedListId, name: "Shared milk" });
    expect(error).toBeNull();
  });

  it("a member (B) can read items the other member (A) added", async () => {
    await userA.from("shopping_list_items").insert({ list_id: sharedListId, name: "From A" });
    const { data } = await userB.from("shopping_list_items").select("name").eq("list_id", sharedListId);
    expect((data ?? []).map((r) => r.name)).toContain("From A");
  });

  it("a non-member (C) CANNOT read the shared list or its items", async () => {
    const list = await userC.from("shopping_lists").select("id").eq("id", sharedListId);
    expect(list.data).toHaveLength(0);
    const items = await userC.from("shopping_list_items").select("id").eq("list_id", sharedListId);
    expect(items.data).toHaveLength(0);
  });

  it("a non-member (C) CANNOT insert into the shared list", async () => {
    const { error } = await userC.from("shopping_list_items").insert({ list_id: sharedListId, name: "spoof" });
    expect(error).not.toBeNull();
  });

  it("a member (B) CANNOT update or delete the shared LIST row (owner-only)", async () => {
    const upd = await userB.from("shopping_lists").update({ name: "renamed" }).eq("id", sharedListId).select();
    expect(upd.data ?? []).toHaveLength(0); // RLS denies silently
    const del = await userB.from("shopping_lists").delete().eq("id", sharedListId).select();
    expect(del.data ?? []).toHaveLength(0);
  });

  it("a member (B) can read the household and its member roster, a non-member (C) cannot", async () => {
    expect((await userB.from("households").select("id").eq("id", householdId)).data).toHaveLength(1);
    expect((await userB.from("household_members").select("user_id").eq("household_id", householdId)).data?.length).toBe(2);
    expect((await userC.from("households").select("id").eq("id", householdId)).data).toHaveLength(0);
    expect((await userC.from("household_members").select("user_id").eq("household_id", householdId)).data).toHaveLength(0);
  });

  it("personal lists remain isolated (regression): C cannot see A's personal list items", async () => {
    const { data: pl } = await admin().from("shopping_lists")
      .insert({ owner_id: aId, is_default: true }).select("id").single();
    await userA.from("shopping_list_items").insert({ list_id: pl!.id, name: "A personal" });
    const { data } = await userC.from("shopping_list_items").select("id").eq("list_id", pl!.id);
    expect(data).toHaveLength(0);
  });
});
