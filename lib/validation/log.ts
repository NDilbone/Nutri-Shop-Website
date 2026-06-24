import { z } from "zod";

const meal = z.enum(["breakfast", "lunch", "dinner", "snack"]);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
const grams = z.number().finite().positive().max(100000);

export const addFoodSchema = z.object({
  fdcId: z.number().int().positive(),
  amountGrams: grams,
  meal,
  loggedOn: dateStr,
});
export type AddFoodInput = z.infer<typeof addFoodSchema>;

export const editFoodSchema = z.object({
  id: z.string().uuid(),
  amountGrams: grams.optional(),
  meal: meal.optional(),
});
export type EditFoodInput = z.infer<typeof editFoodSchema>;

export const deleteFoodSchema = z.object({ id: z.string().uuid() });

export const dateParamSchema = dateStr;
