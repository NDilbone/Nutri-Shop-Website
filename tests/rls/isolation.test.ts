import { describe, it, expect, beforeAll } from "vitest";
import { HAS_SUPABASE_TEST_ENV, makeUser } from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

// Fail closed in CI: if CI demands these run but env is missing, error loudly.
if (process.env.REQUIRE_SUPABASE_TESTS === "1" && !HAS_SUPABASE_TEST_ENV) {
  throw new Error("REQUIRE_SUPABASE_TESTS=1 but SUPABASE_TEST_* env is missing");
}

let userA: SupabaseClient;
let userB: SupabaseClient;
let userAId: string;

describe.skipIf(!HAS_SUPABASE_TEST_ENV)("RLS per-user isolation", () => {
  beforeAll(async () => {
    userA = await makeUser("alice@example.com", "Alice-pw-123!");
    userB = await makeUser("bob@example.com", "Bob-pw-123!");
    const { data } = await userA.auth.getUser();
    userAId = data.user!.id;
  });

  it("a user can read their OWN profile", async () => {
    const { data, error } = await userA.from("profiles").select("id").eq("id", userAId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("a user CANNOT read another user's profile", async () => {
    const { data, error } = await userB.from("profiles").select("id").eq("id", userAId);
    expect(error).toBeNull(); // RLS returns zero rows, not an error
    expect(data).toHaveLength(0);
  });

  it("a user CANNOT change another user's profile (verified by reading back as the owner)", async () => {
    await userB.from("profiles").update({ display_name: "hacked" }).eq("id", userAId);
    const { data } = await userA.from("profiles").select("display_name").eq("id", userAId).single();
    expect(data?.display_name ?? null).not.toBe("hacked");
  });

  it("a user CANNOT insert a row owned by another user", async () => {
    const { error } = await userB.from("profiles").insert({ id: userAId });
    expect(error).not.toBeNull(); // RLS insert (no policy) and/or PK conflict reject
  });

  it("a non-owner CANNOT read the invites allowlist", async () => {
    const { data } = await userB.from("invites").select("email");
    expect(data ?? []).toHaveLength(0); // invites is default-deny
  });
});
