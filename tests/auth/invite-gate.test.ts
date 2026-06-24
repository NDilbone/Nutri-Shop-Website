import { describe, it, expect } from "vitest";
import { HAS_SUPABASE_TEST_ENV, admin, anonClient } from "../rls/helpers";

// Fail closed in CI: if CI demands these run but env is missing, error loudly.
if (process.env.REQUIRE_SUPABASE_TESTS === "1" && !HAS_SUPABASE_TEST_ENV) {
  throw new Error("REQUIRE_SUPABASE_TESTS=1 but SUPABASE_TEST_* env is missing");
}

describe.skipIf(!HAS_SUPABASE_TEST_ENV)("invite-gate (server-enforced, real signup path)", () => {
  it("REJECTS signup for a NON-invited email", async () => {
    const { error } = await anonClient().auth.signUp({
      email: "stranger@example.com",
      password: "Str0ng-pw-123!",
    });
    expect(error).not.toBeNull(); // gate trigger raised
  });

  it("ALLOWS signup for an invited email", async () => {
    await admin().from("invites").upsert({ email: "invited@example.com" });
    const { error } = await anonClient().auth.signUp({
      email: "invited@example.com",
      password: "Str0ng-pw-123!",
    });
    expect(error).toBeNull();
  });
});
