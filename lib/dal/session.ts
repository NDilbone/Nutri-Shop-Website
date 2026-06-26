import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/** Network-validated session. Uses getUser (NOT getSession) so a forged
 *  cookie cannot fake a user. Memoized per render pass via React cache. */
export const verifySession = cache(async (): Promise<{ userId: string } | null> => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return { userId: data.user.id };
});

/** Use in any page/Server Action/Route Handler that requires auth. */
export async function requireUser(): Promise<{ userId: string }> {
  const session = await verifySession();
  if (!session) redirect("/login");
  return session;
}

/** Authorization check — call after loading a row to prevent IDOR. */
export function assertOwnership(rowUserId: string, userId: string): void {
  if (rowUserId !== userId) throw new Error("Forbidden");
}

/** True iff the current session belongs to an admin. Memoized per render pass.
 *  Reads the caller's own profile row (allowed by profiles_select_own). */
export const verifyAdmin = cache(async (): Promise<boolean> => {
  const session = await verifySession();
  if (!session) return false;
  const supabase = await createClient();
  const { data } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", session.userId)
    .single();
  return data?.is_admin === true;
});

/** Use in any admin-only page or Server Action. Bounces non-admins; reveals nothing. */
export async function requireAdmin(): Promise<{ userId: string }> {
  const session = await requireUser();
  if (!(await verifyAdmin())) redirect("/today");
  return session;
}
