// tests/rls/admin.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { HAS_SUPABASE_TEST_ENV, makeUser, admin } from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

if (process.env.REQUIRE_SUPABASE_TESTS === "1" && !HAS_SUPABASE_TEST_ENV) {
  throw new Error("REQUIRE_SUPABASE_TESTS=1 but SUPABASE_TEST_* env is missing");
}

let adminUser: SupabaseClient; // promoted to is_admin
let plainUser: SupabaseClient; // never an admin
let adminUserId: string;
let plainUserId: string;

describe.skipIf(!HAS_SUPABASE_TEST_ENV)("invite-admin RLS + RPCs", () => {
  beforeAll(async () => {
    adminUser = await makeUser("admin-a@example.com", "AdminA-pw-1234!");
    plainUser = await makeUser("plain-b@example.com", "PlainB-pw-1234!");
    adminUserId = (await adminUser.auth.getUser()).data.user!.id;
    plainUserId = (await plainUser.auth.getUser()).data.user!.id;
    // promote adminUser via service role (bypasses the column lockdown)
    const { error } = await admin().from("profiles").update({ is_admin: true }).eq("id", adminUserId);
    if (error) throw error;
  });

  it("is_admin defaults to false on a fresh profile", async () => {
    const { data } = await admin().from("profiles").select("is_admin").eq("id", plainUserId).single();
    expect(data!.is_admin).toBe(false);
  });

  it("ESCALATION: a user CANNOT set is_admin on their own profile", async () => {
    const { error } = await plainUser.from("profiles").update({ is_admin: true }).eq("id", plainUserId);
    expect(error).not.toBeNull(); // column-level grant denies the UPDATE (42501)
    const { data } = await admin().from("profiles").select("is_admin").eq("id", plainUserId).single();
    expect(data!.is_admin).toBe(false); // and it really did not change
  });

  it("a non-admin CANNOT call admin_add_invite", async () => {
    const { error } = await plainUser.rpc("admin_add_invite", { p_email: "x@example.com" });
    expect(error).not.toBeNull();
  });

  it("a non-admin CANNOT call admin_list_invites", async () => {
    const { error } = await plainUser.rpc("admin_list_invites");
    expect(error).not.toBeNull();
  });

  it("an admin CAN add, list, and revoke an invite", async () => {
    const email = "invitee-c@example.com";
    const add = await adminUser.rpc("admin_add_invite", { p_email: "  Invitee-C@Example.com " });
    expect(add.error).toBeNull(); // also proves trim+lowercase

    const list = await adminUser.rpc("admin_list_invites");
    expect(list.error).toBeNull();
    const row = (list.data as Array<{ email: string; status: string }>).find((r) => r.email === email);
    expect(row).toBeDefined();
    expect(row!.status).toBe("pending"); // no account for that email yet

    const revoke = await adminUser.rpc("admin_revoke_invite", { p_email: email });
    expect(revoke.error).toBeNull();
    const after = await adminUser.rpc("admin_list_invites");
    expect((after.data as Array<{ email: string }>).some((r) => r.email === email)).toBe(false);
  });

  it("admin_list_invites reports 'joined' for an email that has an account", async () => {
    // admin-a@example.com has both an invite (makeUser upserts it) and an account.
    const list = await adminUser.rpc("admin_list_invites");
    const row = (list.data as Array<{ email: string; status: string }>).find(
      (r) => r.email === "admin-a@example.com",
    );
    expect(row!.status).toBe("joined");
  });

  it("count_active_admins excludes banned admins (last-admin guard fix)", async () => {
    // Promote plainUser to admin as well, count, then ban them: the active count
    // must drop by exactly one, proving banned admins are not counted as "active".
    await admin().from("profiles").update({ is_admin: true }).eq("id", plainUserId);
    const before = (await admin().rpc("count_active_admins")).data as number;
    expect(before).toBeGreaterThanOrEqual(2);

    await admin().auth.admin.updateUserById(plainUserId, { ban_duration: "876000h" });
    const after = (await admin().rpc("count_active_admins")).data as number;
    expect(after).toBe(before - 1);

    // cleanup so test residue / ordering does not affect other runs
    await admin().auth.admin.updateUserById(plainUserId, { ban_duration: "none" });
    await admin().from("profiles").update({ is_admin: false }).eq("id", plainUserId);
  });
});
