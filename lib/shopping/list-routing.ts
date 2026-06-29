/** Push-time routing: a brand-new user may mint a placeholder list_id offline before
 *  the server list exists (Phase 5). Items already pointing at a real accessible list
 *  (personal OR household) pass through untouched; only an unknown placeholder is
 *  rewritten to the caller's real personal default list. RLS still gates every row. */
export function remapUnknownListIds<T extends { list_id: string }>(
  items: T[],
  knownListIds: Set<string>,
  fallbackListId: string,
): T[] {
  return items.map((i) => (knownListIds.has(i.list_id) ? i : { ...i, list_id: fallbackListId }));
}
