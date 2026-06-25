"use server";

import { getChangesSince, type ServerItemRow } from "@/lib/dal/shopping-list";
import { requireUser } from "@/lib/dal/session";
import { createClient } from "@/lib/supabase/server";
import { syncInputSchema } from "@/lib/validation/sync";

export async function syncShoppingList(
  raw: unknown,
): Promise<{ items: ServerItemRow[]; cursor: string }> {
  await requireUser();
  const input = syncInputSchema.parse(raw);

  if (input.dirtyItems.length > 0) {
    const supabase = await createClient();
    const { error } = await supabase.rpc("sync_shopping_items", { p_items: input.dirtyItems });
    if (error) throw new Error("sync push failed");
  }

  return getChangesSince(input.cursor);
}
