import { z } from "zod";
import { categorySchema } from "./shopping-list";

const iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "invalid ISO timestamp");

export const syncItemSchema = z.object({
  id: z.uuid(),
  list_id: z.uuid(),
  name: z.string().trim().min(1).max(200),
  quantity: z.string().trim().max(50).nullable(),
  category: categorySchema.nullable(),
  fdc_id: z.number().int().positive().nullable(),
  checked: z.boolean(),
  deleted_at: iso.nullable(),
  edited_at: iso,
});

export const syncInputSchema = z.object({
  dirtyItems: z.array(syncItemSchema).max(500),
  cursor: iso,
  bootstrap: z.boolean().default(false),
});

export type SyncInput = z.infer<typeof syncInputSchema>;
