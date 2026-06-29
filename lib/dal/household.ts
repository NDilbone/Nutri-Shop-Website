import "server-only";
import { verifySession } from "@/lib/dal/session";
import { createClient } from "@/lib/supabase/server";

export type Household = { id: string; name: string };
export type Member = { userId: string; displayName: string | null };
export type PendingInvite = { id: string; householdName: string };

async function authed() {
  const session = await verifySession();
  if (!session) throw new Error("Unauthenticated");
  return { session, supabase: await createClient() };
}

/** The caller's household (RLS returns only their own), or null. */
export async function getMyHousehold(): Promise<Household | null> {
  const { supabase } = await authed();
  const { data, error } = await supabase.from("households").select("id, name").maybeSingle();
  if (error) throw new Error(`getMyHousehold failed: ${error.message}`);
  return data ? { id: data.id, name: data.name } : null;
}

/**
 * Member roster of the caller's household (RLS scopes to the same household).
 * Uses two queries because there is no direct FK from household_members to profiles
 * (the chain is household_members.user_id → auth.users ← profiles.id), so PostgREST
 * cannot resolve an embedded select across that join.
 */
export async function getMembers(householdId: string): Promise<Member[]> {
  const { supabase } = await authed();

  // Query 1: get user_ids for this household (RLS-scoped).
  const { data: memberRows, error: membersError } = await supabase
    .from("household_members")
    .select("user_id")
    .eq("household_id", householdId);
  if (membersError) throw new Error(`getMembers failed: ${membersError.message}`);

  const userIds = (memberRows ?? []).map((r: { user_id: string }) => r.user_id);
  if (userIds.length === 0) return [];

  // Query 2: fetch display names from profiles.
  const { data: profileRows, error: profilesError } = await supabase
    .from("profiles")
    .select("id, display_name")
    .in("id", userIds);
  if (profilesError) throw new Error(`getMembers (profiles) failed: ${profilesError.message}`);

  const profileMap = new Map<string, string | null>(
    (profileRows ?? []).map((p: { id: string; display_name: string | null }) => [p.id, p.display_name]),
  );

  return userIds.map((userId) => ({
    userId,
    displayName: profileMap.get(userId) ?? null,
  }));
}

type InviteRow = { id: string; households: { name: string } | null };

/** Pending invites addressed to the caller, with the inviting household's name. */
export async function getPendingInvites(): Promise<PendingInvite[]> {
  const { session, supabase } = await authed();
  const { data, error } = await supabase
    .from("household_invites")
    .select("id, households(name)")
    .eq("invitee_user_id", session.userId)
    .eq("status", "pending");
  if (error) throw new Error(`getPendingInvites failed: ${error.message}`);
  return ((data ?? []) as unknown as InviteRow[]).map((r) => ({
    id: r.id,
    householdName: r.households?.name ?? "a household",
  }));
}

export async function createHousehold(name: string): Promise<void> {
  const { supabase } = await authed();
  const { error } = await supabase.rpc("create_household", { p_name: name });
  if (error) throw new Error("could not create household");
}

export async function inviteToHousehold(email: string): Promise<void> {
  const { supabase } = await authed();
  const { error } = await supabase.rpc("invite_to_household", { p_email: email });
  if (error) throw new Error("could not send invite");
}

export async function respondToInvite(inviteId: string, accept: boolean): Promise<void> {
  const { supabase } = await authed();
  const { error } = await supabase.rpc("respond_to_invite", { p_invite_id: inviteId, p_accept: accept });
  if (error) throw new Error("could not respond to invite");
}

export async function leaveHousehold(): Promise<void> {
  const { supabase } = await authed();
  const { error } = await supabase.rpc("leave_household");
  if (error) throw new Error("could not leave household");
}
