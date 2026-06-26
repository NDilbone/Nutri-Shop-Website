// tests/rls/mfa.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateSync } from "otplib";
import { HAS_SUPABASE_TEST_ENV, makeUser, admin } from "./helpers";
import { MFA_ISSUER } from "@/lib/auth/mfa-issuer";
import type { SupabaseClient } from "@supabase/supabase-js";

let user: SupabaseClient;
let userId: string;

describe.skipIf(!HAS_SUPABASE_TEST_ENV)("MFA enroll/verify/reset round-trip", () => {
  beforeAll(async () => {
    user = await makeUser("mfa-user@example.com", "MfaUser-pw-1234!");
    userId = (await user.auth.getUser()).data.user!.id;
  });

  afterAll(async () => {
    if (userId) await admin().auth.admin.deleteUser(userId);
  });

  it("enrolls TOTP, verifies a generated code, and reaches aal2", async () => {
    const { data: enroll, error: enrollErr } = await user.auth.mfa.enroll({
      factorType: "totp",
      issuer: MFA_ISSUER,
    });
    expect(enrollErr).toBeNull();
    // The otpauth URI carries the issuer the authenticator app displays — must be the brand
    // label, not GoTrue's default (the project Site URL host, e.g. "localhost:3000").
    expect(enroll!.totp.uri).toContain(`issuer=${MFA_ISSUER}`);
    expect(enroll!.totp.uri).toContain(`totp/${MFA_ISSUER}:`);
    const code = generateSync({ secret: enroll!.totp.secret });
    const { error: verifyErr } = await user.auth.mfa.challengeAndVerify({ factorId: enroll!.id, code });
    expect(verifyErr).toBeNull();

    const { data: aal } = await user.auth.mfa.getAuthenticatorAssuranceLevel();
    expect(aal!.currentLevel).toBe("aal2");
    expect(aal!.nextLevel).toBe("aal2");
  });

  it("service-role admin reset removes every factor", async () => {
    const before = await admin().auth.admin.mfa.listFactors({ userId });
    expect(before.data!.factors.length).toBeGreaterThanOrEqual(1);

    await Promise.all(
      before.data!.factors.map((f) => admin().auth.admin.mfa.deleteFactor({ id: f.id, userId })),
    );

    const after = await admin().auth.admin.mfa.listFactors({ userId });
    expect(after.data!.factors.length).toBe(0);
  });
});
