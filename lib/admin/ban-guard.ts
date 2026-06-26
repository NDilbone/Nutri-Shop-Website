export interface BanGuardInput {
  /** The admin performing the action. */
  actorId: string;
  /** The user being banned/unbanned. */
  targetUserId: string;
  /** true = ban, false = re-enable. */
  banned: boolean;
  /** Whether the target currently has is_admin. */
  targetIsAdmin: boolean;
  /** Count of NON-BANNED admins (from count_active_admins() — already-banned admins are
   *  excluded so the last-admin guard cannot be fooled by a banned co-admin). */
  activeAdminCount: number;
}

export type BanGuardResult = { allowed: true } | { allowed: false; reason: string };

/** Pure authorization decision for the reversible user ban. Re-enabling is always
 *  allowed; banning is blocked for self and for the last remaining admin. */
export function banGuard(input: BanGuardInput): BanGuardResult {
  if (!input.banned) return { allowed: true };
  if (input.targetUserId === input.actorId) {
    return { allowed: false, reason: "You cannot disable your own account." };
  }
  if (input.targetIsAdmin && input.activeAdminCount <= 1) {
    return { allowed: false, reason: "You cannot disable the last admin." };
  }
  return { allowed: true };
}
