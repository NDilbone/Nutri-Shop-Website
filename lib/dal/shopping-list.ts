import "server-only";
import { verifySession, requireUser } from "@/lib/dal/session";
import { createClient } from "@/lib/supabase/server";
import type { ShoppingListItem } from "@/lib/shopping/types";
import type { AddItemInput, EditItemInput } from "@/lib/validation/shopping-list";
import { nextCursor } from "@/lib/offline/payload";

async function authedClient() {
  const session = await verifySession();
  if (!session) throw new Error("Unauthenticated");
  const supabase = await createClient();
  return { session, supabase };
}

/** The owner's single default list, created on first use. Idempotent under the
 *  shopping_lists_one_default partial unique index. */
export async function getOrCreateDefaultList(): Promise<{ id: string }> {
  const { session, supabase } = await authedClient();
  const { data: existing, error: selErr } = await supabase
    .from("shopping_lists")
    .select("id")
    .eq("owner_id", session.userId)
    .eq("is_default", true)
    .is("deleted_at", null)
    .maybeSingle();
  if (selErr) throw new Error(`getDefaultList select failed: ${selErr.message}`);
  if (existing) return { id: existing.id as string };

  const { data: created, error: insErr } = await supabase
    .from("shopping_lists")
    .insert({ owner_id: session.userId, is_default: true })
    .select("id")
    .single();
  if (insErr || !created) {
    // Lost a concurrent create race → the unique index rejected us; re-select.
    const { data: again } = await supabase
      .from("shopping_lists")
      .select("id")
      .eq("owner_id", session.userId)
      .eq("is_default", true)
      .is("deleted_at", null)
      .maybeSingle();
    if (!again) throw new Error(`createDefaultList failed: ${insErr?.message ?? "no row returned"}`);
    return { id: again.id as string };
  }
  return { id: created.id as string };
}

type Row = {
  id: string; name: string; quantity: string | null; category: string | null;
  fdc_id: number | null; checked: boolean; created_at: string;
};

/** The default list's non-deleted items, flat. Grouping is applied client-side. */
export async function getItems(): Promise<ShoppingListItem[]> {
  const { id: listId } = await getOrCreateDefaultList();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("shopping_list_items")
    .select("id, name, quantity, category, fdc_id, checked, created_at")
    .eq("list_id", listId)
    .is("deleted_at", null);
  if (error) throw new Error(`getItems failed: ${error.message}`);
  return (data ?? []).map((r: Row) => ({
    id: r.id, name: r.name, quantity: r.quantity,
    category: r.category as ShoppingListItem["category"],
    fdcId: r.fdc_id, checked: r.checked, createdAt: r.created_at,
  }));
}

export async function addItem(input: AddItemInput): Promise<{ id: string }> {
  const { id: listId } = await getOrCreateDefaultList();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("shopping_list_items")
    .insert({
      list_id: listId,
      name: input.name,
      quantity: input.quantity ?? null,
      category: input.category ?? null,
      fdc_id: input.fdcId ?? null,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`addItem failed: ${error?.message ?? "no row returned"}`);
  return { id: data.id as string };
}

export async function toggleItem(id: string, checked: boolean): Promise<void> {
  const { supabase } = await authedClient();
  const { error } = await supabase.from("shopping_list_items").update({ checked }).eq("id", id);
  if (error) throw new Error(`toggleItem failed: ${error.message}`);
}

export async function editItem(input: EditItemInput): Promise<void> {
  const patch: { name?: string; quantity?: string | null; category?: string | null } = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.quantity !== undefined) patch.quantity = input.quantity;
  if (input.category !== undefined) patch.category = input.category;
  if (Object.keys(patch).length === 0) return;
  const { supabase } = await authedClient();
  const { error } = await supabase.from("shopping_list_items").update(patch).eq("id", input.id);
  if (error) throw new Error(`editItem failed: ${error.message}`);
}

export async function softDeleteItem(id: string): Promise<void> {
  const { supabase } = await authedClient();
  const { error } = await supabase
    .from("shopping_list_items")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`softDeleteItem failed: ${error.message}`);
}

export async function clearChecked(): Promise<void> {
  const { id: listId } = await getOrCreateDefaultList();
  const supabase = await createClient();
  const { error } = await supabase
    .from("shopping_list_items")
    .update({ deleted_at: new Date().toISOString() })
    .eq("list_id", listId)
    .eq("checked", true)
    .is("deleted_at", null);
  if (error) throw new Error(`clearChecked failed: ${error.message}`);
}

export type ServerItemRow = {
  id: string;
  list_id: string;
  name: string;
  quantity: string | null;
  category: string | null;
  fdc_id: number | null;
  checked: boolean;
  deleted_at: string | null;
  edited_at: string;
  updated_at: string;
};

/**
 * Returns all shopping_list_items updated after `cursor` (inclusive of
 * tombstones — deleted_at IS NULL filter is intentionally omitted so soft-
 * deleted rows propagate to offline clients during sync).
 * RLS scopes results to lists owned by the calling user.
 */
export async function getChangesSince(
  cursor: string,
): Promise<{ items: ServerItemRow[]; cursor: string }> {
  await requireUser(); // re-verify at the data boundary
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("shopping_list_items")
    .select("id, list_id, name, quantity, category, fdc_id, checked, deleted_at, edited_at, updated_at")
    .gt("updated_at", cursor)
    .order("updated_at", { ascending: true });
  if (error) throw error;
  const items = (data ?? []) as ServerItemRow[];
  return { items, cursor: nextCursor(items.map((r) => r.updated_at), cursor) };
}
