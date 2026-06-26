import { z } from "zod";
import { CATEGORIES } from "@/lib/shopping/types";

const name = z.string().trim().min(1).max(200);
const quantity = z.string().trim().max(50);
export const categorySchema = z.enum(CATEGORIES);
const category = categorySchema;

export const addItemSchema = z.object({
  name,
  quantity: quantity.optional(),
  category: category.optional(),
  fdcId: z.number().int().positive().optional(),
});
export type AddItemInput = z.infer<typeof addItemSchema>;

export const editItemSchema = z.object({
  id: z.string().uuid(),
  name: name.optional(),
  quantity: quantity.nullable().optional(),
  category: category.nullable().optional(),
});
export type EditItemInput = z.infer<typeof editItemSchema>;

export const toggleItemSchema = z.object({ id: z.string().uuid(), checked: z.boolean() });
export type ToggleItemInput = z.infer<typeof toggleItemSchema>;

export const deleteItemSchema = z.object({ id: z.string().uuid() });
