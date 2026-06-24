import "server-only";
import { verifySession } from "@/lib/dal/session";
import { createClient } from "@/lib/supabase/server";
import { getFoodDetailCached } from "@/lib/fdc/cache";
import { buildDayData } from "@/lib/nutrition/compute";
import type { DayData, LoggedEntry, Meal } from "@/lib/nutrition/types";
import type { AddFoodInput, EditFoodInput } from "@/lib/validation/log";
import type { NormalizedNutrition } from "@/lib/fdc/nutrients";

/** Insert a log entry. Nutrition is snapshotted from the authoritative cache,
 *  NOT from client input. user_id comes from the verified session (RLS backstop). */
export async function logFood(input: AddFoodInput): Promise<{ id: string }> {
  const session = await verifySession();
  if (!session) throw new Error("Unauthenticated");

  const { food } = await getFoodDetailCached(input.fdcId); // authoritative snapshot source
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("logged_foods")
    .insert({
      user_id: session.userId,
      fdc_id: input.fdcId,
      description: food.description,
      meal: input.meal,
      amount_grams: input.amountGrams,
      nutrition: food.nutrition,
      logged_on: input.loggedOn,
    })
    .select("id")
    .single();
  if (error) throw new Error(`logFood insert failed: ${error.message}`);
  return { id: data.id as string };
}

/** Edit amount and/or meal of an existing entry. Cannot change nutrition or fdc_id. */
export async function editLog(input: EditFoodInput): Promise<void> {
  const session = await verifySession();
  if (!session) throw new Error("Unauthenticated");
  const patch: { amount_grams?: number; meal?: Meal } = {};
  if (input.amountGrams !== undefined) patch.amount_grams = input.amountGrams;
  if (input.meal !== undefined) patch.meal = input.meal;
  const supabase = await createClient();
  const { error } = await supabase.from("logged_foods").update(patch).eq("id", input.id);
  if (error) throw new Error(`editLog failed: ${error.message}`);
}

/** Soft-delete an entry (sets deleted_at). RLS scopes to the owner. */
export async function softDeleteLog(id: string): Promise<void> {
  const session = await verifySession();
  if (!session) throw new Error("Unauthenticated");
  const supabase = await createClient();
  const { error } = await supabase
    .from("logged_foods")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`softDeleteLog failed: ${error.message}`);
}

type Row = {
  id: string; fdc_id: number; description: string; meal: Meal; amount_grams: number;
  nutrition: NormalizedNutrition; logged_on: string; logged_at: string;
};

/** All of the owner's non-deleted entries for a day, plus computed totals. */
export async function getDay(loggedOn: string): Promise<DayData> {
  const session = await verifySession();
  if (!session) throw new Error("Unauthenticated");
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("logged_foods")
    .select("id, fdc_id, description, meal, amount_grams, nutrition, logged_on, logged_at")
    .eq("user_id", session.userId)   // explicit; RLS also enforces this
    .eq("logged_on", loggedOn)
    .is("deleted_at", null);
  if (error) throw new Error(`getDay failed: ${error.message}`);
  const entries: LoggedEntry[] = (data as Row[]).map((r) => ({
    id: r.id, fdcId: r.fdc_id, description: r.description, meal: r.meal,
    amountGrams: r.amount_grams, nutrition: r.nutrition, loggedOn: r.logged_on, loggedAt: r.logged_at,
  }));
  return buildDayData(loggedOn, entries);
}
