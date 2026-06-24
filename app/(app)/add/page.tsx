import type { Meal } from "@/lib/nutrition/types";
import { MEALS } from "@/lib/nutrition/types";
import { AddView } from "./AddView";

export default async function AddPage({ searchParams }: { searchParams: Promise<{ date?: string; meal?: string }> }) {
  const sp = await searchParams;
  const date = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : "";
  const presetMeal: Meal = MEALS.includes(sp.meal as Meal) ? (sp.meal as Meal) : "lunch";
  return <AddView date={date} presetMeal={presetMeal} />;
}
