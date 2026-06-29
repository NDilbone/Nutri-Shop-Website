"use server";

import {
  getChangesSince,
  getMyLists,
  getOrCreateDefaultList,
  type ListMeta,
  type ServerItemRow,
} from "@/lib/dal/shopping-list";
import { requireStepUp } from "@/lib/dal/session";
import { createClient } from "@/lib/supabase/server";
import { syncInputSchema } from "@/lib/validation/sync";
import { remapUnknownListIds } from "@/lib/shopping/list-routing";

export async function syncShoppingList(
  raw: unknown,
): Promise<{ items: ServerItemRow[]; cursor: string; lists: ListMeta[] }> {
  await requireStepUp();
  const input = syncInputSchema.parse(raw);

  // Resolve the caller's real lists. getOrCreateDefaultList guarantees a personal list
  // exists (a brand-new user has none yet); getMyLists then returns personal + (if a
  // member) the household shared list.
  const { id: personalListId } = await getOrCreateDefaultList();
  const lists = await getMyLists();
  const knownIds = new Set(lists.map((l) => l.id));

  if (input.dirtyItems.length > 0) {
    // Only a true bootstrap (brand-new client, empty local lists store) may remap an
    // unknown placeholder to the personal list. Otherwise DROP dirty items whose list is
    // no longer accessible (a just-revoked household list) — remapping would leak them to
    // personal, and pushing them would RLS-abort the whole batch.
    const items = input.bootstrap
      ? remapUnknownListIds(input.dirtyItems, knownIds, personalListId)
      : input.dirtyItems.filter((i) => knownIds.has(i.list_id));
    const supabase = await createClient();
    const { error } = await supabase.rpc("sync_shopping_items", { p_items: items });
    if (error) throw new Error("sync push failed");
  }

  const changes = await getChangesSince(input.cursor);
  return { ...changes, lists };
}
