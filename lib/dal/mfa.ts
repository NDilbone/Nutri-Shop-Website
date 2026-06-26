// lib/dal/mfa.ts
import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export interface EnrollResult {
  factorId: string;
  qrCodeSvg: string;
  secret: string;
}

/** Remove dangling UNVERIFIED factors (friendly_name is unique-per-user and there's a
 *  10-factor cap, so a prior abandoned enroll would otherwise block this), then enroll a
 *  fresh TOTP factor. Unverified factors unenroll at aal1, so this is safe pre-step-up. */
export async function enrollTotp(): Promise<EnrollResult> {
  const supabase = await createClient();
  const { data: factors } = await supabase.auth.mfa.listFactors();
  await Promise.all(
    (factors?.all ?? [])
      .filter((f) => f.status === "unverified")
      .map((f) => supabase.auth.mfa.unenroll({ factorId: f.id })),
  );
  // friendlyName intentionally omitted to avoid the unique-name collision.
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp" });
  if (error || !data) throw new Error("failed to start MFA enrollment");
  return { factorId: data.id, qrCodeSvg: data.totp.qr_code, secret: data.totp.secret };
}

/** Verify a TOTP code (enroll completion or step-up). On success the SSR client persists
 *  the new aal2 session via the cookie adapter. */
export async function verifyTotp(factorId: string, code: string): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
  if (error) throw new Error("invalid code");
}

/** Unenroll a verified factor. Supabase requires the current session to be aal2. */
export async function disableTotp(factorId: string): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  if (error) throw new Error("failed to disable MFA");
}

export interface OwnMfaStatus {
  hasVerifiedFactor: boolean;
  verifiedFactorId: string | null;
}

/** The caller's own verified-factor status (for /account and the /mfa challenge screen).
 *  listFactors().totp contains only VERIFIED TOTP factors. */
export async function getOwnMfaStatus(): Promise<OwnMfaStatus> {
  const supabase = await createClient();
  const { data } = await supabase.auth.mfa.listFactors();
  const verified = data?.totp?.[0];
  return { hasVerifiedFactor: !!verified, verifiedFactorId: verified?.id ?? null };
}

/** Service-role: delete ALL of a target user's factors (admin-assisted reset). After this,
 *  a member drops to aal1-ok; an admin is forced through /mfa enroll on their next request.
 *  No guard needed — reset never permanently locks anyone out. */
export async function resetUserMfa(userId: string): Promise<void> {
  const adminClient = createAdminClient();
  const { data, error } = await adminClient.auth.admin.mfa.listFactors({ userId });
  if (error) throw new Error("failed to list target factors");
  await Promise.all(
    (data?.factors ?? []).map((f) => adminClient.auth.admin.mfa.deleteFactor({ id: f.id, userId })),
  );
}
