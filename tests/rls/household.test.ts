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

  it("a member (B) can UPDATE and soft-DELETE items on the shared list (T2 matrix)", async () => {
    const ins = await userB.from("shopping_list_items")
      .insert({ list_id: sharedListId, name: "B editable" }).select("id").single();
    expect(ins.error).toBeNull();
    expect(ins.data).not.toBeNull();
    const itemId = ins.data!.id;

    const upd = await userB.from("shopping_list_items")
      .update({ name: "B edited" }).eq("id", itemId).select();
    expect(upd.error).toBeNull();
    expect(upd.data ?? []).toHaveLength(1);

    const del = await userB.from("shopping_list_items")
      .update({ deleted_at: new Date().toISOString() }).eq("id", itemId).select();
    expect(del.error).toBeNull();
    expect(del.data ?? []).toHaveLength(1);
  });
});

describe.skipIf(!HAS_SUPABASE_TEST_ENV)("household sharing — lifecycle RPCs", () => {
  let uA: SupabaseClient, uB: SupabaseClient, uC: SupabaseClient;
  let bEmail: string, cEmail: string, hhId: string, listId: string;

  beforeAll(async () => {
    bEmail = "life-b@example.com"; cEmail = "life-c@example.com";
    uA = await makeUser("life-a@example.com", "LifeA-pw-1234!");
    uB = await makeUser(bEmail, "LifeB-pw-1234!");
    uC = await makeUser(cEmail, "LifeC-pw-1234!");
  });

  it("create_household creates a household, membership, and exactly one shared list", async () => {
    const { data, error } = await uA.rpc("create_household", { p_name: "Lifecycle home" });
    expect(error).toBeNull();
    hhId = data as string;
    const { data: list } = await uA.from("shopping_lists").select("id, household_id").eq("household_id", hhId);
    expect(list).toHaveLength(1);
    listId = list![0]!.id;
  });

  it("create_household a second time for the same user fails closed", async () => {
    const { error } = await uA.rpc("create_household", { p_name: "Second" });
    expect(error).not.toBeNull();
  });

  it("invite_to_household for an unknown email is a silent no-op (no error, no invite)", async () => {
    const { error } = await uA.rpc("invite_to_household", { p_email: "nobody@example.com" });
    expect(error).toBeNull();
    const { data } = await admin().from("household_invites").select("id").eq("household_id", hhId);
    expect(data).toHaveLength(0);
  });

  it("invite_to_household creates exactly one pending invite for an eligible user; repeat is idempotent", async () => {
    expect((await uA.rpc("invite_to_household", { p_email: bEmail })).error).toBeNull();
    expect((await uA.rpc("invite_to_household", { p_email: bEmail })).error).toBeNull();
    const { data } = await admin().from("household_invites").select("id, status").eq("household_id", hhId);
    expect(data).toHaveLength(1);
    expect(data![0]!.status).toBe("pending");
  });

  it("a non-member cannot invite", async () => {
    const { error } = await uC.rpc("invite_to_household", { p_email: bEmail });
    expect(error).not.toBeNull(); // uC is in no household
  });

  it("invitee B sees the pending invite and accepts; B becomes a member and can use the shared list", async () => {
    const { data: invites } = await uB.from("household_invites").select("id").eq("invitee_user_id",
      (await uB.auth.getUser()).data.user!.id);
    expect(invites!.length).toBe(1);
    const { error } = await uB.rpc("respond_to_invite", { p_invite_id: invites![0]!.id, p_accept: true });
    expect(error).toBeNull();
    const { error: insErr } = await uB.from("shopping_list_items").insert({ list_id: listId, name: "B joined item" });
    expect(insErr).toBeNull();
  });

  it("after B leaves, B can no longer read or write the shared list", async () => {
    expect((await uB.rpc("leave_household")).error).toBeNull();
    expect((await uB.from("shopping_lists").select("id").eq("id", listId)).data).toHaveLength(0);
    const { error } = await uB.from("shopping_list_items").insert({ list_id: listId, name: "after leave" });
    expect(error).not.toBeNull();
  });

  it("when the last member (A) leaves, the household and its shared list are deleted", async () => {
    expect((await uA.rpc("leave_household")).error).toBeNull();
    const { data } = await admin().from("households").select("id").eq("id", hhId);
    expect(data).toHaveLength(0);
    const { data: list } = await admin().from("shopping_lists").select("id").eq("household_id", hhId);
    expect(list).toHaveLength(0);
  });
});

describe.skipIf(!HAS_SUPABASE_TEST_ENV)("household sharing — creator leaves while a member remains", () => {
  let uA: SupabaseClient, uB: SupabaseClient;
  let creatorId: string, memberId: string;
  let hhId: string, listId: string, seededItemId: string;

  beforeAll(async () => {
    uA = await makeUser("leave-a@example.com", "LeaveA-pw-1234!");
    uB = await makeUser("leave-b@example.com", "LeaveB-pw-1234!");
    creatorId = (await uA.auth.getUser()).data.user!.id;
    memberId = (await uB.auth.getUser()).data.user!.id;

    // A creates the household → A is the shared list's owner_id and first member.
    const { data: hh, error: hhErr } = await uA.rpc("create_household", { p_name: "Creator-leave home" });
    expect(hhErr).toBeNull();
    hhId = hh as string;

    const { data: lists } = await admin().from("shopping_lists").select("id, owner_id").eq("household_id", hhId);
    expect(lists).toHaveLength(1);
    listId = lists![0]!.id;
    expect(lists![0]!.owner_id).toBe(creatorId);

    // Add B as a second member (service-role seed, mirroring the access-RLS suite).
    const { error: mErr } = await admin().from("household_members").insert({ household_id: hhId, user_id: memberId });
    expect(mErr).toBeNull();

    // B (member) seeds an item so A's post-leave write attempts have a target row.
    const seeded = await uB.from("shopping_list_items").insert({ list_id: listId, name: "B before leave" }).select("id").single();
    expect(seeded.error).toBeNull();
    expect(seeded.data).not.toBeNull();
    seededItemId = seeded.data!.id;

    // A (creator) leaves while B remains → access must be revoked and ownership reassigned.
    expect((await uA.rpc("leave_household")).error).toBeNull();
  });

  it("the departed creator (A) can no longer read the shared list", async () => {
    const { data } = await uA.from("shopping_lists").select("id").eq("id", listId);
    expect(data ?? []).toHaveLength(0);
  });

  it("the departed creator (A) can no longer read the shared items", async () => {
    const { data } = await uA.from("shopping_list_items").select("id").eq("list_id", listId);
    expect(data ?? []).toHaveLength(0);
  });

  it("the departed creator (A) can no longer insert, update, or delete shared items", async () => {
    const ins = await uA.from("shopping_list_items").insert({ list_id: listId, name: "A after leave" });
    expect(ins.error).not.toBeNull();
    const upd = await uA.from("shopping_list_items").update({ name: "A edit" }).eq("id", seededItemId).select();
    expect(upd.data ?? []).toHaveLength(0); // RLS denies silently
    const del = await uA.from("shopping_list_items").delete().eq("id", seededItemId).select();
    expect(del.data ?? []).toHaveLength(0);
  });

  it("the remaining member (B) can still read and write shared items", async () => {
    const { data: read } = await uB.from("shopping_list_items").select("id").eq("list_id", listId).is("deleted_at", null);
    expect((read ?? []).length).toBeGreaterThanOrEqual(1);
    const { error: insErr } = await uB.from("shopping_list_items").insert({ list_id: listId, name: "B still writes" });
    expect(insErr).toBeNull();
  });

  it("ownership of the shared list is reassigned to the remaining member (B)", async () => {
    const { data } = await admin().from("shopping_lists").select("owner_id").eq("id", listId);
    expect(data).toHaveLength(1);
    expect(data![0]!.owner_id).toBe(memberId);
  });
});
