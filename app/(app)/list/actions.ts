"use server";

import { revalidatePath } from "next/cache";
import { addItem, editItem, toggleItem, softDeleteItem, clearChecked, getChangesSince, type ServerItemRow } from "@/lib/dal/shopping-list";
import { addItemSchema, editItemSchema, toggleItemSchema, deleteItemSchema } from "@/lib/validation/shopping-list";
import { requireUser } from "@/lib/dal/session";
import { createClient } from "@/lib/supabase/server";
import { syncInputSchema } from "@/lib/validation/sync";

export type ActionResult = { ok: true } | { error: string };

export async function addItemAction(input: unknown): Promise<ActionResult> {
  const parsed = addItemSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid item." };
  await addItem(parsed.data);
  revalidatePath("/list");
  return { ok: true };
}

export async function editItemAction(input: unknown): Promise<ActionResult> {
  const parsed = editItemSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid edit." };
  await editItem(parsed.data);
  revalidatePath("/list");
  return { ok: true };
}

export async function toggleItemAction(input: unknown): Promise<ActionResult> {
  const parsed = toggleItemSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid toggle." };
  await toggleItem(parsed.data.id, parsed.data.checked);
  revalidatePath("/list");
  return { ok: true };
}

export async function deleteItemAction(input: unknown): Promise<ActionResult> {
  const parsed = deleteItemSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid delete." };
  await softDeleteItem(parsed.data.id);
  revalidatePath("/list");
  return { ok: true };
}

export async function clearCheckedAction(): Promise<ActionResult> {
  await clearChecked();
  revalidatePath("/list");
  return { ok: true };
}

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
