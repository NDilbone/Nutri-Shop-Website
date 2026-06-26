export type AAL = "aal1" | "aal2";
export type MfaRequirement = "ok" | "challenge" | "enroll";

/** Pure MFA policy. Inputs derive from getAuthenticatorAssuranceLevel() + verifyAdmin().
 *  - "ok": requirement met (or none) — proceed.
 *  - "challenge": user has a verified factor but the session is still aal1 — enter a code.
 *  - "enroll": admin with no factor — must set up TOTP. */
export function mfaRequirement(input: {
  isAdmin: boolean;
  hasVerifiedFactor: boolean;
  currentAAL: AAL;
}): MfaRequirement {
  if (input.currentAAL === "aal2") return "ok";
  if (input.hasVerifiedFactor) return "challenge";
  if (input.isAdmin) return "enroll";
  return "ok";
}
