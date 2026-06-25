export type SyncMeta = { id: string; editedAt: string; deletedAt: string | null };
export type LocalMeta = SyncMeta & { dirty: boolean };
export type ReconcileAction = "insert" | "overwrite" | "keep-local";

export function reconcile(local: LocalMeta | null, server: SyncMeta): ReconcileAction {
  if (local === null) return "insert";
  if (!local.dirty) return "overwrite";
  return Date.parse(server.editedAt) > Date.parse(local.editedAt) ? "overwrite" : "keep-local";
}
