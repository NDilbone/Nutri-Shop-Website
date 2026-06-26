"use server";

import {
  getChangesSince,
  getOrCreateDefaultList,
  type ServerItemRow,
} from "@/lib/dal/shopping-list";
import { requireStepUp } from "@/lib/dal/session";
import { createClient } from "@/lib/supabase/server";
import { syncInputSchema } from "@/lib/validation/sync";

export async function syncShoppingList(
  raw: unknown,
): Promise<{ items: ServerItemRow[]; cursor: string }> {
  await requireStepUp();
  const input = syncInputSchema.parse(raw);

  if (input.dirtyItems.length > 0) {
    // The client may have minted a local list_id before the server list existed
    // (a brand-new user has no shopping_lists row). Resolve (idempotently create)
    // the user's real default list and point every pushed item at it — Phase 5 is
    // single-default-list, so this rewrite is exact.
    const { id: listId } = await getOrCreateDefaultList();
    const items = input.dirtyItems.map((i) => ({ ...i, list_id: listId }));

    const supabase = await createClient();
    const { error } = await supabase.rpc("sync_shopping_items", { p_items: items });
    if (error) throw new Error("sync push failed");
  }

  return getChangesSince(input.cursor);
}
