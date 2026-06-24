import { z } from "zod";

const DATA_TYPES = ["Branded", "Foundation", "SR Legacy"] as const;
export const DEFAULT_DATA_TYPES: (typeof DATA_TYPES)[number][] = [...DATA_TYPES];

// ---- route input ----
export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(100),
  dataType: z.array(z.enum(DATA_TYPES)).nonempty().default([...DATA_TYPES]),
  page: z.coerce.number().int().min(1).default(1),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

export const fdcIdSchema = z.coerce.number().int().positive();

// ---- FDC responses (lenient: the published spec lags the live API) ----
const abridgedNutrient = z
  .object({
    number: z.union([z.number(), z.string()]).optional(),
    name: z.string().optional(),
    amount: z.number().nullish(),
    unitName: z.string().optional(),
  })
  .passthrough();

export const fdcSearchResponseSchema = z
  .object({
    totalHits: z.number().default(0),
    currentPage: z.number().default(1),
    totalPages: z.number().default(1),
    foods: z
      .array(
        z
          .object({
            fdcId: z.number(),
            description: z.string(),
            dataType: z.string().optional(),
            brandOwner: z.string().nullish(),
            gtinUpc: z.string().nullish(),
            foodNutrients: z.array(abridgedNutrient).optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();
export type FdcSearchResponse = z.infer<typeof fdcSearchResponseSchema>;

const fullNutrient = z
  .object({
    amount: z.number().nullish(),
    nutrient: z
      .object({
        id: z.number(),
        number: z.union([z.number(), z.string()]).optional(),
        name: z.string().optional(),
        unitName: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const fdcDetailResponseSchema = z
  .object({
    fdcId: z.number(),
    description: z.string(),
    dataType: z.string().optional(),
    brandOwner: z.string().nullish(),
    gtinUpc: z.string().nullish(),
    servingSize: z.number().nullish(),
    servingSizeUnit: z.string().nullish(),
    householdServingFullText: z.string().nullish(),
    foodNutrients: z.array(fullNutrient).default([]),
  })
  .passthrough();
export type FdcFoodDetail = z.infer<typeof fdcDetailResponseSchema>;
