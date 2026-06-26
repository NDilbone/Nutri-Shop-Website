import "server-only";
import { createClient } from "@/lib/supabase/server";

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
