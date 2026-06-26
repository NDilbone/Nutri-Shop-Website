// lib/supabase/admin.ts
import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getServerEnv } from "@/lib/env";

/** Service-role client. Bypasses RLS — use ONLY for sanctioned server-side admin ops,
 *  each behind an is_admin gate: (1) writes to public reference tables (food_cache);
 *  (2) the reversible user ban via the Auth admin API (lib/dal/admin.ts setUserBanned);
 *  (3) admin-assisted MFA reset via the Auth admin API (lib/dal/mfa.ts resetUserMfa).
 *  NEVER expose to the client; never use in the normal authenticated request path. */
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    getServerEnv().SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
