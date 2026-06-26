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

  // sync_shopping_items RPC — cross-user isolation (security invoker + owner-only RLS)

  it("sync_shopping_items: user B cannot upsert into user A's list", async () => {
    const intruderId = crypto.randomUUID();
    const itemForAsList = {
      id: intruderId,
      list_id: listAId, // A's list
      name: "intruder",
      quantity: null,
      category: null,
      fdc_id: null,
      checked: false,
      deleted_at: null,
      edited_at: new Date().toISOString(),
    };

    const { error } = await userB.rpc("sync_shopping_items", { p_items: [itemForAsList] });
    expect(error).not.toBeNull(); // RLS WITH CHECK rejects

    // And A never sees it.
    const { data } = await userA.from("shopping_list_items").select("id").eq("id", intruderId);
    expect(data ?? []).toHaveLength(0);
  });

  it("sync_shopping_items applies last-edit-wins for the owner", async () => {
    const id = crypto.randomUUID();

    // Insert with a known timestamp.
    await userA.rpc("sync_shopping_items", {
      p_items: [{
        id,
        list_id: listAId,
        name: "Milk",
        quantity: "1",
        category: "dairy",
        fdc_id: null,
        checked: false,
        deleted_at: null,
        edited_at: "2026-06-25T10:00:00.000Z",
      }],
    });

    // Older edit must NOT clobber.
    await userA.rpc("sync_shopping_items", {
      p_items: [{
        id,
        list_id: listAId,
        name: "STALE",
        quantity: "1",
        category: "dairy",
        fdc_id: null,
        checked: false,
        deleted_at: null,
        edited_at: "2026-06-25T09:00:00.000Z",
      }],
    });

    const { data } = await userA.from("shopping_list_items").select("name").eq("id", id).single();
    expect(data?.name).toBe("Milk");
  });

  it("sync_shopping_items: user B cannot UPDATE an existing item in user A's list (ON CONFLICT path)", async () => {
    const id = crypto.randomUUID();

    // A creates the item.
    await userA.rpc("sync_shopping_items", {
      p_items: [{
        id,
        list_id: listAId,
        name: "Milk",
        quantity: "1",
        category: "dairy",
        fdc_id: null,
        checked: false,
        deleted_at: null,
        edited_at: "2026-06-25T10:00:00.000Z",
      }],
    });

    // B tries to hijack it via ON CONFLICT DO UPDATE with a newer edit time.
    const { error } = await userB.rpc("sync_shopping_items", {
      p_items: [{
        id,
        list_id: listAId,
        name: "HIJACK",
        quantity: "1",
        category: "dairy",
        fdc_id: null,
        checked: false,
        deleted_at: null,
        edited_at: "2026-06-25T12:00:00.000Z",
      }],
    });
    expect(error).not.toBeNull(); // UPDATE USING/WITH CHECK rejects — B does not own the list

    const { data } = await userA.from("shopping_list_items").select("name").eq("id", id).single();
    expect(data?.name).toBe("Milk");
  });

  // First-sync contract that FIX 1 (syncShoppingList → getOrCreateDefaultList)
  // relies on: an item pushed for a real owned default list lands; an item whose
  // list_id has no owning shopping_lists row (the brand-new-user client-minted id)
  // is rejected by the FK + owner-only RLS WITH CHECK.

  it("sync_shopping_items: an item pushed for a real owned default list lands and is readable", async () => {
    const id = crypto.randomUUID();
    const { error } = await userA.rpc("sync_shopping_items", {
      p_items: [{
        id,
        list_id: listAId, // userA's real, owned default list
        name: "Eggs",
        quantity: null,
        category: null,
        fdc_id: null,
        checked: false,
        deleted_at: null,
        edited_at: new Date().toISOString(),
      }],
    });
    expect(error).toBeNull();
    const { data } = await userA.from("shopping_list_items").select("name").eq("id", id).single();
    expect(data?.name).toBe("Eggs");
  });

  it("sync_shopping_items: rejects an item whose list_id has no owning list (the brand-new-user fake-id case)", async () => {
    const orphanListId = crypto.randomUUID(); // no shopping_lists row → FK + RLS WITH CHECK reject
    const { error } = await userA.rpc("sync_shopping_items", {
      p_items: [{
        id: crypto.randomUUID(),
        list_id: orphanListId,
        name: "x",
        quantity: null,
        category: null,
        fdc_id: null,
        checked: false,
        deleted_at: null,
        edited_at: new Date().toISOString(),
      }],
    });
    expect(error).not.toBeNull(); // exactly why syncShoppingList must create the list first
  });
});
