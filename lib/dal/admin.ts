import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { banGuard } from "@/lib/admin/ban-guard";

export type InviteStatus = "pending" | "joined" | "banned";

export interface InviteRow {
  email: string;
  invited_at: string;
  user_id: string | null;
  status: InviteStatus;
}

/** All invites with derived status. Calls the admin-gated SECURITY DEFINER RPC. */
export async function listInvites(): Promise<InviteRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_list_invites");
  if (error) throw new Error("failed to list invites");
  return (data ?? []) as InviteRow[];
}

/** Add an email to the allowlist (idempotent). Caller must be admin. */
export async function addInvite(email: string): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_add_invite", { p_email: email });
  if (error) throw new Error("failed to add invite");
}

/** Remove an email from the allowlist. Caller must be admin. */
export async function revokeInvite(email: string): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_revoke_invite", { p_email: email });
  if (error) throw new Error("failed to revoke invite");
}

const PERMANENT_BAN = "876000h"; // ~100 years; Supabase ban_duration string

/** Reversibly ban/unban a user via the Auth admin API. The ONLY service-role op in
 *  this DAL. The invite row is intentionally LEFT INTACT — re-entry is already blocked
 *  by the existing account (re-signup is a duplicate) plus the ban; deleting the invite
 *  would hide the banned user from the invite-rooted admin list and break re-enable.
 *  Caller MUST be admin (gated in the Server Action); banGuard blocks self / last-admin.
 *  activeAdminCount comes from count_active_admins() so already-banned admins are excluded. */
export async function setUserBanned(args: {
  actorId: string;
  targetUserId: string;
  banned: boolean;
}): Promise<void> {
  const adminClient = createAdminClient();

  // Facts for the guard: is the target an admin, and how many admins are still ACTIVE
  // (count_active_admins excludes banned admins — a plain is_admin count would not).
  const { data: targetProfile } = await adminClient
    .from("profiles")
    .select("is_admin")
    .eq("id", args.targetUserId)
    .single();
  const { data: activeAdmins, error: countErr } = await adminClient.rpc("count_active_admins");
  if (countErr) throw new Error("failed to count active admins");

  const decision = banGuard({
    actorId: args.actorId,
    targetUserId: args.targetUserId,
    banned: args.banned,
    targetIsAdmin: targetProfile?.is_admin === true,
    activeAdminCount: (activeAdmins as number) ?? 0,
  });
  if (!decision.allowed) throw new Error(decision.reason);

  const { error } = await adminClient.auth.admin.updateUserById(args.targetUserId, {
    ban_duration: args.banned ? PERMANENT_BAN : "none",
  });
  if (error) throw new Error("failed to update user ban state");
}
