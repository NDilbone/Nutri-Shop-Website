/** The label shown for this app in users' authenticator apps — the TOTP `issuer`.
 *
 *  Passed explicitly to `mfa.enroll(...)`. Without it, GoTrue derives the issuer from the
 *  Supabase project's Auth Site URL host (e.g. "localhost:3000"), which is what users would
 *  otherwise see in Google Authenticator / 1Password. Setting it here makes the label the
 *  brand name regardless of any dashboard/Site-URL configuration. */
export const MFA_ISSUER = "Nutri-Shop";
