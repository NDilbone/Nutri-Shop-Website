import { describe, it, expect } from "vitest";
import { HAS_SUPABASE_TEST_ENV, admin } from "../rls/helpers";

// Fail closed in CI: if CI demands these run but env is missing, error loudly.
if (process.env.REQUIRE_SUPABASE_TESTS === "1" && !HAS_SUPABASE_TEST_ENV) {
  throw new Error("REQUIRE_SUPABASE_TESTS=1 but SUPABASE_TEST_* env is missing");
}

// Uses the admin API (auth.admin.createUser). It bypasses Supabase's hosted
// email-format validation and sends no confirmation email, but STILL fires the
// BEFORE INSERT invite-gate trigger on auth.users (that is exactly why the gate
// is a trigger, not an Auth Hook) — so it exercises the gate in isolation.
// (The public signUp path is gated by the same trigger; hosted Supabase rejects
// @example.com there as email validation, which is not what this test verifies.)
describe.skipIf(!HAS_SUPABASE_TEST_ENV)("invite-gate (server-enforced)", () => {
  it("REJECTS user creation for a NON-invited email", async () => {
    const { data, error } = await admin().auth.admin.createUser({
      email: `not-invited-${Date.now()}@example.com`,
      password: "Str0ng-pw-123!",
      email_confirm: true,
    });
    expect(error).not.toBeNull(); // gate trigger raised: "signup not permitted"
    expect(data?.user ?? null).toBeNull();
  });

  it("ALLOWS user creation for an invited email, then cleans up", async () => {
    const email = `invited-${Date.now()}@example.com`;
    const a = admin();
    await a.from("invites").upsert({ email });

    const { data, error } = await a.auth.admin.createUser({
      email,
      password: "Str0ng-pw-123!",
      email_confirm: true,
    });
    expect(error).toBeNull();
    expect(data.user?.id).toBeTruthy();

    // keep the project clean across re-runs
    if (data.user?.id) await a.auth.admin.deleteUser(data.user.id);
    await a.from("invites").delete().eq("email", email);
  });
});
