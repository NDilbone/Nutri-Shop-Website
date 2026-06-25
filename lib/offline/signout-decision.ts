export type SignOutAction = "wipe" | "sync-then-wipe" | "confirm-then-wipe";

export function signOutDecision(dirtyCount: number, online: boolean): SignOutAction {
  if (dirtyCount === 0) return "wipe";
  return online ? "sync-then-wipe" : "confirm-then-wipe";
}
