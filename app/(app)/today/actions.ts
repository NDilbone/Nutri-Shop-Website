"use server";

import { revalidatePath } from "next/cache";
import { logFood, editLog, softDeleteLog } from "@/lib/dal/logged-foods";
import { addFoodSchema, editFoodSchema, deleteFoodSchema } from "@/lib/validation/log";

export type ActionResult = { ok: true } | { error: string };

export async function addFoodAction(input: unknown): Promise<ActionResult> {
  const parsed = addFoodSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid food entry." };
  await logFood(parsed.data);
  revalidatePath("/today");
  return { ok: true };
}

export async function editFoodAction(input: unknown): Promise<ActionResult> {
  const parsed = editFoodSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid edit." };
  await editLog(parsed.data);
  revalidatePath("/today");
  return { ok: true };
}

export async function deleteFoodAction(input: unknown): Promise<ActionResult> {
  const parsed = deleteFoodSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid delete." };
  await softDeleteLog(parsed.data.id);
  revalidatePath("/today");
  return { ok: true };
}
