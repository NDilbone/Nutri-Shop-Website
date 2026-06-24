# USDA Food Search + Nutrient Detail — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the stubbed `/api/foods` proxy to the real USDA FoodData Central (FDC) API with a two-layer cache, a stable normalized nutrient model, and per-user rate limiting — backend only, no UI.

**Architecture:** Pure normalizer (`lib/fdc/nutrients.ts`) ← Zod boundary schemas (`lib/validation/fdc.ts`) ← server-only HTTP client (`lib/fdc/client.ts`) ← cache layer (`lib/fdc/cache.ts`: L1 `unstable_cache` + L2 Postgres `food_cache`). Two authenticated route handlers orchestrate `verifySession → enforceRateLimit → validate → cache → respond`. Privileged DB writes go through `SECURITY DEFINER` functions granted to `authenticated` — **no service-role key on the request path**.

**Tech Stack:** Next.js 16 App Router (route handlers, `unstable_cache`), React 19, TypeScript 6 (strict), Zod 4, Supabase (Postgres + RLS, `@supabase/ssr`), vitest 4.

**Spec:** [`docs/superpowers/specs/2026-06-24-nutri-shop-usda-food-search-design.md`](../specs/2026-06-24-nutri-shop-usda-food-search-design.md)

## Global Constraints

- **Pinned versions (do not bump):** `next@16.2.9`, `react@19.2.7`, `zod@4.4.3`, `typescript@6.0.3`, pnpm `11.9.0`, Node `>=24`. Any new dependency must be the current latest stable.
- **No AI attribution** anywhere durable (commits, comments, docs). Author is RegEdits.
- **Secrets server-only:** `FDC_API_KEY` is read **only** in `lib/fdc/client.ts` via `getServerEnv()`, behind `import "server-only"`. Never `NEXT_PUBLIC_`, never in a response body, log, or the client bundle.
- **No service-role under `app/`.** No `SERVICE_ROLE` reference may appear under `app/` (CI greps for it). The service-role client lives only in `lib/supabase/admin.ts`, used solely for the public `food_cache` write (shared reference data, no per-user rows → no IDOR). `food_cache` has **no** authenticated write path. The per-user throttle is a `SECURITY DEFINER` function with a **hard-coded** limit/window (no client-tunable params). *(Both points are security-review findings — see the spec §3/§10.)*
- **RLS default-deny.** New tables enable RLS; grant the minimum; mirror `0001_init.sql` conventions (`(select auth.uid())`, explicit grants, `security definer set search_path = ''`).
- **Missing nutrient ⇒ `null`, never `0`.**
- **TDD, DRY, YAGNI, frequent commits.** Per-push CI runs `pnpm lint && pnpm typecheck && pnpm build && pnpm test`; RLS integration tests run in `.github/workflows/rls.yml` against a real local Supabase stack and self-skip without `SUPABASE_TEST_*` env.

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/fdc/nutrients.ts` | **Create.** Pure: canonical nutrient-id map + `normalizeNutrition(input)`. No I/O. |
| `lib/validation/fdc.ts` | **Create.** Zod: route input (`searchQuerySchema`, `fdcIdSchema`) + lenient FDC response schemas + inferred types. |
| `lib/fdc/client.ts` | **Create.** server-only HTTP client (`searchFoods`, `getFoodDetail`) + `FdcError`. Sole reader of `FDC_API_KEY`. |
| `lib/fdc/http.ts` | **Create.** Route helpers `jsonError()` + `mapFdcError()` (DRY across both routes). |
| `lib/fdc/cache.ts` | **Create.** `searchFoodsCached()` (L1) + `getFoodDetailCached()` (L2 authed-read → L1 → normalize → service-role write, stale-on-429). |
| `lib/supabase/admin.ts` | **Create.** Server-only service-role client; used only for the `food_cache` write. Never imported from `app/`. |
| `lib/dal/rate-limit.ts` | **Create.** `enforceRateLimit()` → `check_and_increment_rate()` RPC (no args). |
| `app/api/foods/route.ts` | **Replace** the 501 stub: GET search. |
| `app/api/foods/[fdcId]/route.ts` | **Create.** GET detail. |
| `supabase/migrations/0002_food_cache.sql` | **Create.** `food_cache` + `api_rate_limit` tables, `check_and_increment_rate()` function (hard-coded limit/window), RLS + grants. No authenticated write fn. |
| `tests/fdc/nutrients.test.ts` | **Create.** Normalizer unit tests. |
| `tests/fdc/client.test.ts` | **Create.** Client unit tests (mock `fetch`). |
| `tests/fdc/cache.test.ts` | **Create.** Cache unit tests (mock client + supabase + `next/cache`). |
| `tests/dal/rate-limit.test.ts` | **Create.** DAL unit test (mock supabase rpc). |
| `tests/api/foods.test.ts` | **Replace** the 501 test: search route tests. |
| `tests/api/foods-detail.test.ts` | **Create.** Detail route tests. |
| `tests/rls/food-cache.test.ts` | **Create.** RLS integration (gated): cache read/deny + rate-limit fn. |
| `.env.example` | **Modify.** Refresh the `FDC_API_KEY` comment (now in use). |
| `README.md` | **Modify.** Document the two endpoints + FDC attribution. |

---

## Task 1: Nutrient normalization (`lib/fdc/nutrients.ts`)

**Files:**
- Create: `lib/fdc/nutrients.ts`
- Test: `tests/fdc/nutrients.test.ts`

**Interfaces:**
- Produces:
  - `type NutrientKey` (14 keys), `type NutrientValue = { amount: number | null; unit: string }`
  - `type RawNutrient = { id: number; amount: number | null; unitName: string }`
  - `type NormalizeInput = { dataType: string; foodNutrients: RawNutrient[]; serving?: { amount: number; unit: string; household: string | null } }`
  - `type NormalizedNutrition = { basis: "100g"; serving?: {...}; nutrients: Record<NutrientKey, NutrientValue> }`
  - `function normalizeNutrition(input: NormalizeInput): NormalizedNutrition`

- [ ] **Step 1: Write the failing test**

```ts
// tests/fdc/nutrients.test.ts
import { describe, it, expect } from "vitest";
import { normalizeNutrition } from "@/lib/fdc/nutrients";

describe("normalizeNutrition", () => {
  it("maps macros by FDC nutrient id (per-100g)", () => {
    const out = normalizeNutrition({
      dataType: "Branded",
      foodNutrients: [
        { id: 1008, amount: 140, unitName: "KCAL" },
        { id: 1003, amount: 5, unitName: "G" },
        { id: 1004, amount: 9, unitName: "G" },
        { id: 1005, amount: 12, unitName: "G" },
        { id: 1093, amount: 200, unitName: "MG" },
      ],
    });
    expect(out.basis).toBe("100g");
    expect(out.nutrients.energyKcal).toEqual({ amount: 140, unit: "kcal" });
    expect(out.nutrients.protein).toEqual({ amount: 5, unit: "g" });
    expect(out.nutrients.sodium).toEqual({ amount: 200, unit: "mg" });
  });

  it("represents a missing nutrient as null, never 0", () => {
    const out = normalizeNutrition({ dataType: "SR Legacy", foodNutrients: [] });
    expect(out.nutrients.addedSugars).toEqual({ amount: null, unit: "g" });
    expect(out.nutrients.vitaminD).toEqual({ amount: null, unit: "µg" });
  });

  it("falls back to Atwater energy (2047, then 2048) for Foundation foods", () => {
    const out = normalizeNutrition({
      dataType: "Foundation",
      foodNutrients: [{ id: 2047, amount: 52, unitName: "KCAL" }],
    });
    expect(out.nutrients.energyKcal).toEqual({ amount: 52, unit: "kcal" });
  });

  it("prefers vitamin D µg (1114); falls back to 1110 as IU", () => {
    const ug = normalizeNutrition({ dataType: "Foundation",
      foodNutrients: [{ id: 1114, amount: 2, unitName: "UG" }] });
    expect(ug.nutrients.vitaminD).toEqual({ amount: 2, unit: "µg" });

    const iu = normalizeNutrition({ dataType: "SR Legacy",
      foodNutrients: [{ id: 1110, amount: 80, unitName: "IU" }] });
    expect(iu.nutrients.vitaminD).toEqual({ amount: 80, unit: "IU" });
  });

  it("passes a serving through when provided (Branded)", () => {
    const out = normalizeNutrition({
      dataType: "Branded",
      foodNutrients: [],
      serving: { amount: 28, unit: "g", household: "1 ONZ" },
    });
    expect(out.serving).toEqual({ amount: 28, unit: "g", household: "1 ONZ" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/fdc/nutrients.test.ts`
Expected: FAIL — `Cannot find module '@/lib/fdc/nutrients'`.

- [ ] **Step 3: Write the implementation**

```ts
// lib/fdc/nutrients.ts
export type NutrientKey =
  | "energyKcal" | "protein" | "totalFat" | "saturatedFat" | "carbs"
  | "fiber" | "totalSugars" | "addedSugars" | "sodium" | "calcium"
  | "iron" | "potassium" | "cholesterol" | "vitaminD";

export type NutrientValue = { amount: number | null; unit: string };

export type RawNutrient = { id: number; amount: number | null; unitName: string };

export type NormalizeInput = {
  dataType: string;
  foodNutrients: RawNutrient[];
  serving?: { amount: number; unit: string; household: string | null };
};

export type NormalizedNutrition = {
  basis: "100g";
  serving?: { amount: number; unit: string; household: string | null };
  nutrients: Record<NutrientKey, NutrientValue>;
};

// Each key maps to an ordered list of FDC nutrient ids (first match wins) and a
// canonical unit. Energy falls back 1008 → 2047 (Atwater general) → 2048
// (Atwater specific); Foundation foods omit 1008 since Oct 2020. Vitamin D
// prefers 1114 (µg, the modern label unit); 1110 is the legacy IU form.
const NUTRIENT_DEFS: Record<NutrientKey, { ids: number[]; unit: string }> = {
  energyKcal:   { ids: [1008, 2047, 2048], unit: "kcal" },
  protein:      { ids: [1003], unit: "g" },
  totalFat:     { ids: [1004], unit: "g" },
  saturatedFat: { ids: [1258], unit: "g" },
  carbs:        { ids: [1005], unit: "g" },
  fiber:        { ids: [1079], unit: "g" },
  totalSugars:  { ids: [2000], unit: "g" },
  addedSugars:  { ids: [1235], unit: "g" },
  sodium:       { ids: [1093], unit: "mg" },
  calcium:      { ids: [1087], unit: "mg" },
  iron:         { ids: [1089], unit: "mg" },
  potassium:    { ids: [1092], unit: "mg" },
  cholesterol:  { ids: [1253], unit: "mg" },
  vitaminD:     { ids: [1114, 1110], unit: "µg" },
};

export function normalizeNutrition(input: NormalizeInput): NormalizedNutrition {
  const byId = new Map<number, RawNutrient>();
  for (const n of input.foodNutrients) {
    if (!byId.has(n.id)) byId.set(n.id, n);
  }

  const nutrients = {} as Record<NutrientKey, NutrientValue>;
  for (const key of Object.keys(NUTRIENT_DEFS) as NutrientKey[]) {
    const def = NUTRIENT_DEFS[key];
    let value: NutrientValue = { amount: null, unit: def.unit };
    for (const id of def.ids) {
      const hit = byId.get(id);
      if (hit && hit.amount != null) {
        // Vitamin D's IU fallback keeps the IU unit so callers don't mistake it for µg.
        const unit = key === "vitaminD" && id === 1110 ? "IU" : def.unit;
        value = { amount: hit.amount, unit };
        break;
      }
    }
    nutrients[key] = value;
  }

  return {
    basis: "100g",
    ...(input.serving ? { serving: input.serving } : {}),
    nutrients,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/fdc/nutrients.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/fdc/nutrients.ts tests/fdc/nutrients.test.ts
git commit -m "feat: add FDC nutrient normalization model"
```

---

## Task 2: FDC validation schemas (`lib/validation/fdc.ts`)

**Files:**
- Create: `lib/validation/fdc.ts`
- Test: `tests/fdc/validation.test.ts`

**Interfaces:**
- Produces:
  - `searchQuerySchema` → `type SearchQuery = { q: string; dataType: ("Branded"|"Foundation"|"SR Legacy")[]; page: number }`
  - `fdcIdSchema` (coerces to positive int)
  - `fdcSearchResponseSchema` → `type FdcSearchResponse`
  - `fdcDetailResponseSchema` → `type FdcFoodDetail` (with `foodNutrients[].nutrient.id`, optional `brandOwner`/`gtinUpc`/`servingSize`/`servingSizeUnit`/`householdServingFullText`)
  - `const DEFAULT_DATA_TYPES: ("Branded"|"Foundation"|"SR Legacy")[]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/fdc/validation.test.ts
import { describe, it, expect } from "vitest";
import {
  searchQuerySchema, fdcIdSchema,
  fdcSearchResponseSchema, fdcDetailResponseSchema,
} from "@/lib/validation/fdc";

describe("searchQuerySchema", () => {
  it("requires q and defaults dataType + page", () => {
    const r = searchQuerySchema.parse({ q: "cheddar" });
    expect(r.q).toBe("cheddar");
    expect(r.dataType).toEqual(["Branded", "Foundation", "SR Legacy"]);
    expect(r.page).toBe(1);
  });
  it("rejects an empty query", () => {
    expect(searchQuerySchema.safeParse({ q: "" }).success).toBe(false);
  });
  it("coerces page from a string and rejects < 1", () => {
    expect(searchQuerySchema.parse({ q: "x", page: "3" }).page).toBe(3);
    expect(searchQuerySchema.safeParse({ q: "x", page: "0" }).success).toBe(false);
  });
  it("rejects an unknown dataType", () => {
    expect(searchQuerySchema.safeParse({ q: "x", dataType: ["Nope"] }).success).toBe(false);
  });
});

describe("fdcIdSchema", () => {
  it("coerces a numeric string to a positive int", () => {
    expect(fdcIdSchema.parse("534358")).toBe(534358);
  });
  it("rejects non-numeric / non-positive", () => {
    expect(fdcIdSchema.safeParse("abc").success).toBe(false);
    expect(fdcIdSchema.safeParse("-5").success).toBe(false);
  });
});

describe("FDC response schemas (lenient)", () => {
  it("parses a search response and tolerates extra fields", () => {
    const r = fdcSearchResponseSchema.parse({
      totalHits: 2, currentPage: 1, totalPages: 1,
      foods: [{ fdcId: 1, description: "A", dataType: "Branded",
                brandOwner: "X", gtinUpc: "000", surprise: true }],
    });
    expect(r.foods[0].fdcId).toBe(1);
  });
  it("parses a detail response exposing foodNutrients[].nutrient.id", () => {
    const r = fdcDetailResponseSchema.parse({
      fdcId: 5, description: "B", dataType: "Foundation",
      foodNutrients: [{ amount: 10, nutrient: { id: 1003, number: "203", unitName: "G" } }],
    });
    expect(r.foodNutrients[0].nutrient.id).toBe(1003);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/fdc/validation.test.ts`
Expected: FAIL — `Cannot find module '@/lib/validation/fdc'`.

- [ ] **Step 3: Write the implementation**

```ts
// lib/validation/fdc.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/fdc/validation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/validation/fdc.ts tests/fdc/validation.test.ts
git commit -m "feat: add Zod schemas for FDC requests and responses"
```

---

## Task 3: FDC HTTP client (`lib/fdc/client.ts`)

**Files:**
- Create: `lib/fdc/client.ts`
- Test: `tests/fdc/client.test.ts`

**Interfaces:**
- Consumes: `fdcSearchResponseSchema`, `fdcDetailResponseSchema`, `FdcSearchResponse`, `FdcFoodDetail` (Task 2); `getServerEnv` (`lib/env.ts`).
- Produces:
  - `class FdcError extends Error { kind: FdcErrorKind; retryAfter?: number }`
  - `type FdcErrorKind = "key_missing" | "key_rejected" | "rate_limited" | "not_found" | "upstream" | "invalid_response"`
  - `function searchFoods(args: { query: string; dataType: string[]; pageNumber: number; pageSize?: number }): Promise<FdcSearchResponse>`
  - `function getFoodDetail(fdcId: number): Promise<FdcFoodDetail>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/fdc/client.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const okJson = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

describe("FDC client", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("FDC_API_KEY", "test-key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "srv");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("builds the search URL with api_key + dataType and parses the response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({ totalHits: 1, currentPage: 1, totalPages: 1,
               foods: [{ fdcId: 7, description: "Egg" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { searchFoods } = await import("@/lib/fdc/client");

    const res = await searchFoods({ query: "egg", dataType: ["Branded", "Foundation"], pageNumber: 2 });
    expect(res.foods[0].fdcId).toBe(7);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe("/fdc/v1/foods/search");
    expect(url.searchParams.get("api_key")).toBe("test-key");
    expect(url.searchParams.get("dataType")).toBe("Branded,Foundation");
    expect(url.searchParams.get("pageNumber")).toBe("2");
  });

  it("requests detail with format=full", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({ fdcId: 5, description: "B", foodNutrients: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { getFoodDetail } = await import("@/lib/fdc/client");

    await getFoodDetail(5);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe("/fdc/v1/food/5");
    expect(url.searchParams.get("format")).toBe("full");
  });

  it("maps 429 to a rate_limited FdcError with retryAfter", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("{}", { status: 429, headers: { "retry-after": "30" } }),
    ));
    const { getFoodDetail, FdcError } = await import("@/lib/fdc/client");
    await expect(getFoodDetail(5)).rejects.toMatchObject(
      { name: "FdcError", kind: "rate_limited", retryAfter: 30 },
    );
    expect(FdcError).toBeTypeOf("function");
  });

  it("maps 403 to key_rejected and 404 to not_found", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 403 })));
    let mod = await import("@/lib/fdc/client");
    await expect(mod.getFoodDetail(5)).rejects.toMatchObject({ kind: "key_rejected" });

    vi.resetModules();
    vi.stubEnv("FDC_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 404 })));
    mod = await import("@/lib/fdc/client");
    await expect(mod.getFoodDetail(5)).rejects.toMatchObject({ kind: "not_found" });
  });

  it("throws key_missing when FDC_API_KEY is absent", async () => {
    vi.resetModules();
    vi.stubEnv("FDC_API_KEY", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "srv");
    const { searchFoods } = await import("@/lib/fdc/client");
    await expect(
      searchFoods({ query: "x", dataType: ["Branded"], pageNumber: 1 }),
    ).rejects.toMatchObject({ kind: "key_missing" });
  });

  it("maps a malformed body to invalid_response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson({ foods: "nope" })));
    const { searchFoods } = await import("@/lib/fdc/client");
    await expect(
      searchFoods({ query: "x", dataType: ["Branded"], pageNumber: 1 }),
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });
});
```

> Note: `vi.stubEnv("FDC_API_KEY", "")` makes the optional key absent; `getServerEnv()` treats empty as missing because `lib/fdc/client.ts` checks for a falsy value. `vi.resetModules()` clears the module-level memoization in `lib/env.ts` so each case re-reads env.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/fdc/client.test.ts`
Expected: FAIL — `Cannot find module '@/lib/fdc/client'`.

- [ ] **Step 3: Write the implementation**

```ts
// lib/fdc/client.ts
import "server-only";
import { getServerEnv } from "@/lib/env";
import {
  fdcSearchResponseSchema,
  fdcDetailResponseSchema,
  type FdcSearchResponse,
  type FdcFoodDetail,
} from "@/lib/validation/fdc";

const BASE = "https://api.nal.usda.gov/fdc/v1";

export type FdcErrorKind =
  | "key_missing" | "key_rejected" | "rate_limited"
  | "not_found" | "upstream" | "invalid_response";

export class FdcError extends Error {
  constructor(
    readonly kind: FdcErrorKind,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "FdcError";
  }
}

function apiKey(): string {
  const key = getServerEnv().FDC_API_KEY;
  if (!key) throw new FdcError("key_missing", "FDC_API_KEY is not configured");
  return key;
}

async function fdcFetch(path: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set("api_key", apiKey());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch (e) {
    throw new FdcError("upstream", `FDC request failed: ${(e as Error).message}`);
  }

  if (res.status === 429) {
    const ra = res.headers.get("retry-after");
    throw new FdcError("rate_limited", "FDC rate limit exceeded", ra ? Number(ra) : undefined);
  }
  if (res.status === 403) throw new FdcError("key_rejected", "FDC rejected the API key");
  if (res.status === 404) throw new FdcError("not_found", "FDC food not found");
  if (!res.ok) throw new FdcError("upstream", `FDC returned ${res.status}`);

  try {
    return await res.json();
  } catch {
    throw new FdcError("invalid_response", "FDC returned a non-JSON body");
  }
}

export async function searchFoods(args: {
  query: string;
  dataType: string[];
  pageNumber: number;
  pageSize?: number;
}): Promise<FdcSearchResponse> {
  const raw = await fdcFetch("/foods/search", {
    query: args.query,
    dataType: args.dataType.join(","),
    pageNumber: String(args.pageNumber),
    pageSize: String(args.pageSize ?? 25),
  });
  const parsed = fdcSearchResponseSchema.safeParse(raw);
  if (!parsed.success) throw new FdcError("invalid_response", "Unexpected FDC search shape");
  return parsed.data;
}

export async function getFoodDetail(fdcId: number): Promise<FdcFoodDetail> {
  const raw = await fdcFetch(`/food/${fdcId}`, { format: "full" });
  const parsed = fdcDetailResponseSchema.safeParse(raw);
  if (!parsed.success) throw new FdcError("invalid_response", "Unexpected FDC detail shape");
  return parsed.data;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/fdc/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/fdc/client.ts tests/fdc/client.test.ts
git commit -m "feat: add server-only FDC HTTP client with typed errors"
```

---

## Task 4: DB migration + RLS (`supabase/migrations/0002_food_cache.sql`)

**Files:**
- Create: `supabase/migrations/0002_food_cache.sql`
- Test: `tests/rls/food-cache.test.ts`

**Interfaces:**
- Produces:
  - `check_and_increment_rate() returns boolean` — SECURITY DEFINER; limit + window hard-coded at 60/60s (NOT client args); granted to `authenticated`.
  - Table `public.food_cache(fdc_id, data_type, description, brand_owner, gtin_upc, raw, nutrition, fetched_at)` — authenticated SELECT only; **no authenticated write path** (the server writes via the service-role client in Task 6).
  - Table `public.api_rate_limit(user_id, window_start, request_count)` — default-deny.
  - (There is deliberately NO `upsert_food_cache` RPC — a security review found a DEFINER upsert granted to `authenticated` allowed cache poisoning; writes are service-role-only.)

- [ ] **Step 1: Write the failing test**

```ts
// tests/rls/food-cache.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { HAS_SUPABASE_TEST_ENV, makeUser, admin } from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

if (process.env.REQUIRE_SUPABASE_TESTS === "1" && !HAS_SUPABASE_TEST_ENV) {
  throw new Error("REQUIRE_SUPABASE_TESTS=1 but SUPABASE_TEST_* env is missing");
}

describe.skipIf(!HAS_SUPABASE_TEST_ENV)("food_cache + api_rate_limit RLS", () => {
  let user: SupabaseClient;

  beforeAll(async () => {
    user = await makeUser("foodcache@example.com", "Food-pw-123!");
    await admin().from("food_cache").upsert({
      fdc_id: 999001, data_type: "Branded", description: "Seed Food",
      raw: {}, nutrition: { basis: "100g", nutrients: {} },
    });
  });

  it("an authenticated user CAN read food_cache (public reference data)", async () => {
    const { data, error } = await user.from("food_cache").select("fdc_id").eq("fdc_id", 999001);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("an authenticated user CANNOT write food_cache directly (no insert policy)", async () => {
    const { error } = await user.from("food_cache").insert({
      fdc_id: 999002, data_type: "x", description: "y", raw: {}, nutrition: {},
    });
    expect(error).not.toBeNull();
  });

  it("the cache-poisoning RPC is gone — authed user cannot write food_cache via upsert_food_cache", async () => {
    const { error } = await user.rpc("upsert_food_cache", {
      p_fdc_id: 999003, p_data_type: "Foundation", p_description: "junk",
      p_brand_owner: null, p_gtin_upc: null, p_raw: {},
      p_nutrition: { basis: "100g", nutrients: {} },
    });
    expect(error).not.toBeNull();
    const { data } = await admin().from("food_cache").select("fdc_id").eq("fdc_id", 999003);
    expect(data ?? []).toHaveLength(0);
  });

  it("api_rate_limit is default-deny for an authenticated user", async () => {
    const { data: who } = await user.auth.getUser();
    await admin().from("api_rate_limit").upsert({
      user_id: who.user!.id, window_start: new Date().toISOString(), request_count: 1,
    });
    const { data, error } = await user.from("api_rate_limit").select("user_id");
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("check_and_increment_rate cannot be called with client-controlled limit/window", async () => {
    const u = await makeUser("rate-args@example.com", "Rate-pw-123!");
    const { error } = await u.rpc("check_and_increment_rate", { p_limit: 999999, p_window_seconds: 0 });
    expect(error).not.toBeNull(); // no overload accepting these parameters exists
  });

  it("check_and_increment_rate (hard-coded 60/60s) returns true up to the limit, then false", async () => {
    const u = await makeUser("rate-block@example.com", "Rate-pw-123!");
    const { data: who } = await u.auth.getUser();
    await admin().from("api_rate_limit").upsert({
      user_id: who.user!.id, window_start: new Date().toISOString(), request_count: 59,
    });
    expect((await u.rpc("check_and_increment_rate")).data).toBe(true);  // 60 <= 60
    expect((await u.rpc("check_and_increment_rate")).data).toBe(false); // 61 > 60
  });

  it("check_and_increment_rate resets the count after the window elapses", async () => {
    const u = await makeUser("rate-reset@example.com", "Rate-pw-123!");
    const { data: who } = await u.auth.getUser();
    await admin().from("api_rate_limit").upsert({
      user_id: who.user!.id,
      window_start: new Date(Date.now() - 120_000).toISOString(), request_count: 60,
    });
    expect((await u.rpc("check_and_increment_rate")).data).toBe(true); // window expired → reset to 1
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (requires a local Supabase stack — see README step 4):
```bash
supabase start
supabase db reset --no-seed
supabase status -o env > /tmp/supa.env   # then export SUPABASE_TEST_URL / _ANON_KEY / _SERVICE_ROLE_KEY
pnpm exec vitest run tests/rls/food-cache.test.ts --no-file-parallelism
```
Expected: FAIL — `food_cache`/`api_rate_limit` relations and `check_and_increment_rate` do not exist yet.

> Without a local stack the suite **self-skips** (`describe.skipIf`). That is acceptable for inner-loop work; the migration is validated by `.github/workflows/rls.yml`. Run it locally at least once before opening the PR.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/0002_food_cache.sql — Phase 1: FDC food cache + per-user rate limit

-- ============ food_cache (public CC0 reference data; authed-read, service-role write) ============
create table public.food_cache (
  fdc_id      bigint primary key,
  data_type   text not null,
  description text not null,
  brand_owner text,
  gtin_upc    text,
  raw         jsonb not null,   -- full FDC payload (CC0 — legal to store)
  nutrition   jsonb not null,   -- NormalizedNutrition
  fetched_at  timestamptz not null default now()
);
alter table public.food_cache enable row level security;

create policy "food_cache_select_authenticated"
  on public.food_cache for select
  to authenticated
  using ( true );
-- No insert/update/delete policy => default-deny for authenticated. The server writes the
-- cache with the service-role client (which bypasses RLS) ONLY after fetching the row from
-- FDC. There is deliberately NO authenticated-callable write path: an earlier design exposed
-- a SECURITY DEFINER upsert function to `authenticated`, which let any invited user write
-- arbitrary rows and poison shared nutrition data. Writes are server-only now.

-- ============ api_rate_limit (per-user fixed window; default-deny) ============
create table public.api_rate_limit (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  window_start  timestamptz not null default now(),
  request_count int not null default 0
);
alter table public.api_rate_limit enable row level security;
-- No policies => default-deny. Touched only via check_and_increment_rate (SECURITY DEFINER).

-- ============ check_and_increment_rate: atomic fixed-window counter ============
-- Identity comes from auth.uid() INSIDE the function. The limit and window are CONSTANTS
-- here, NOT client arguments: an earlier design accepted them as parameters, which let an
-- authenticated caller invoke the RPC directly with p_window_seconds => 0 to reset their own
-- counter (or a huge p_limit) and defeat the throttle. Baking them in closes that bypass
-- while still allowing the function to be granted to `authenticated`.
create or replace function public.check_and_increment_rate()
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_limit          constant int := 60;   -- requests allowed per window
  v_window_seconds constant int := 60;   -- window length in seconds
  uid uuid := (select auth.uid());
  allowed boolean;
begin
  if uid is null then return false; end if;

  insert into public.api_rate_limit (user_id, window_start, request_count)
    values (uid, now(), 1)
  on conflict (user_id) do update set
    window_start = case
      when public.api_rate_limit.window_start < now() - make_interval(secs => v_window_seconds)
      then now() else public.api_rate_limit.window_start end,
    request_count = case
      when public.api_rate_limit.window_start < now() - make_interval(secs => v_window_seconds)
      then 1 else public.api_rate_limit.request_count + 1 end
  returning (request_count <= v_limit) into allowed;

  return allowed;
end; $$;

-- ============ grants ============
grant select on public.food_cache to authenticated;
grant all    on public.food_cache to service_role;
grant all    on public.api_rate_limit to service_role;
grant execute on function public.check_and_increment_rate() to authenticated;
```

- [ ] **Step 4: Apply the migration and run the test to verify it passes**

```bash
supabase db reset --no-seed
pnpm exec vitest run tests/rls/food-cache.test.ts --no-file-parallelism
```
Expected: PASS (8 tests). (If no local stack, the suite skips — see Step 2 note.)

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0002_food_cache.sql tests/rls/food-cache.test.ts
git commit -m "feat: add food_cache + api_rate_limit schema, functions, and RLS"
```

---

## Task 5: Rate-limit DAL (`lib/dal/rate-limit.ts`)

**Files:**
- Create: `lib/dal/rate-limit.ts`
- Test: `tests/dal/rate-limit.test.ts`

**Interfaces:**
- Consumes: `createClient` (`lib/supabase/server.ts`); `check_and_increment_rate()` RPC — **no args** (Task 4; limit/window are SQL constants).
- Produces:
  - `class RateLimitError extends Error`
  - `function enforceRateLimit(): Promise<void>` (throws `RateLimitError` when over the limit)

- [ ] **Step 1: Write the failing test**

```ts
// tests/dal/rate-limit.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn().mockResolvedValue({ rpc }),
}));

beforeEach(() => rpc.mockReset());

describe("enforceRateLimit", () => {
  it("resolves when under the limit", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    const { enforceRateLimit } = await import("@/lib/dal/rate-limit");
    await expect(enforceRateLimit()).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledWith("check_and_increment_rate");
  });

  it("throws RateLimitError when over the limit", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    const { enforceRateLimit, RateLimitError } = await import("@/lib/dal/rate-limit");
    await expect(enforceRateLimit()).rejects.toBeInstanceOf(RateLimitError);
  });

  it("throws on an rpc error", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    const { enforceRateLimit } = await import("@/lib/dal/rate-limit");
    await expect(enforceRateLimit()).rejects.toThrow(/boom/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/dal/rate-limit.test.ts`
Expected: FAIL — `Cannot find module '@/lib/dal/rate-limit'`.

- [ ] **Step 3: Write the implementation**

```ts
// lib/dal/rate-limit.ts
import "server-only";
import { createClient } from "@/lib/supabase/server";

export class RateLimitError extends Error {
  constructor() {
    super("Rate limit exceeded");
    this.name = "RateLimitError";
  }
}

/** Per-user fixed-window throttle. Identity is taken from the session inside the
 *  SECURITY DEFINER DB function; the limit + window are SQL constants (not passed
 *  here) so a client cannot tune them. No service-role client is needed. */
export async function enforceRateLimit(): Promise<void> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("check_and_increment_rate");
  if (error) throw new Error(`rate limit check failed: ${error.message}`);
  if (data !== true) throw new RateLimitError();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/dal/rate-limit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/dal/rate-limit.ts tests/dal/rate-limit.test.ts
git commit -m "feat: add per-user rate-limit DAL"
```

---

## Task 6: Cache layer (`lib/fdc/cache.ts`)

**Files:**
- Create: `lib/supabase/admin.ts` (server-only service-role client)
- Create: `lib/fdc/cache.ts`
- Test: `tests/fdc/cache.test.ts`

**Interfaces:**
- Consumes: `searchFoods`, `getFoodDetail`, `FdcError` (Task 3); `normalizeNutrition`, `RawNutrient`, `NormalizedNutrition` (Task 1); `FdcFoodDetail`, `FdcSearchResponse` (Task 2); `createClient` (`lib/supabase/server.ts`, authed L2 read); `createAdminClient` (`lib/supabase/admin.ts`, service-role L2 write); `unstable_cache` (`next/cache`).
- Produces also: `createAdminClient()` in `lib/supabase/admin.ts` (server-only service-role Supabase client).
- Produces:
  - `type NormalizedFood = { fdcId: number; description: string; dataType: string | null; nutrition: NormalizedNutrition }`
  - `function searchFoodsCached(args: { query: string; dataType: string[]; page: number }): Promise<FdcSearchResponse>`
  - `function getFoodDetailCached(fdcId: number): Promise<{ food: NormalizedFood; stale: boolean }>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/fdc/cache.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// L1 pass-through so the cache wrapper just invokes the underlying fn in tests.
vi.mock("next/cache", () => ({ unstable_cache: (fn: (...a: unknown[]) => unknown) => fn }));

const searchFoods = vi.fn();
const getFoodDetail = vi.fn();
class FakeFdcError extends Error {
  constructor(readonly kind: string, readonly retryAfter?: number) { super(kind); this.name = "FdcError"; }
}
vi.mock("@/lib/fdc/client", () => ({
  searchFoods: (...a: unknown[]) => searchFoods(...a),
  getFoodDetail: (...a: unknown[]) => getFoodDetail(...a),
  FdcError: FakeFdcError,
}));

const from = vi.fn();   // authed client — L2 read
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn().mockResolvedValue({ from }),
}));

// service-role client — L2 write
const adminUpsert = vi.fn().mockResolvedValue({ error: null });
const adminFrom = vi.fn(() => ({ upsert: adminUpsert }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({ from: adminFrom })),
}));

// helper to stub a food_cache SELECT ... maybeSingle() result
function stubSelect(row: unknown) {
  from.mockReturnValue({
    select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) }),
  });
}

beforeEach(() => {
  searchFoods.mockReset();
  getFoodDetail.mockReset();
  from.mockReset();
  adminFrom.mockClear();
  adminUpsert.mockClear();
});

describe("getFoodDetailCached", () => {
  it("returns a fresh L2 row without calling FDC", async () => {
    stubSelect({
      fdc_id: 5, description: "Cached", data_type: "Branded",
      nutrition: { basis: "100g", nutrients: {} },
      fetched_at: new Date().toISOString(),
    });
    const { getFoodDetailCached } = await import("@/lib/fdc/cache");
    const { food, stale } = await getFoodDetailCached(5);
    expect(stale).toBe(false);
    expect(food.description).toBe("Cached");
    expect(getFoodDetail).not.toHaveBeenCalled();
  });

  it("on L2 miss, fetches FDC, normalizes, and upserts", async () => {
    stubSelect(null);
    getFoodDetail.mockResolvedValue({
      fdcId: 9, description: "Fresh", dataType: "Foundation",
      foodNutrients: [{ amount: 100, nutrient: { id: 1008, unitName: "KCAL" } }],
    });
    const { getFoodDetailCached } = await import("@/lib/fdc/cache");
    const { food } = await getFoodDetailCached(9);
    expect(food.nutrition.nutrients.energyKcal).toEqual({ amount: 100, unit: "kcal" });
    expect(adminFrom).toHaveBeenCalledWith("food_cache");
    expect(adminUpsert).toHaveBeenCalledWith(expect.objectContaining({ fdc_id: 9 }));
  });

  it("serves a stale row when FDC is rate-limited", async () => {
    stubSelect({
      fdc_id: 5, description: "Old", data_type: "Branded",
      nutrition: { basis: "100g", nutrients: {} },
      fetched_at: new Date(Date.now() - 99 * 24 * 3600 * 1000).toISOString(), // stale
    });
    getFoodDetail.mockRejectedValue(new FakeFdcError("rate_limited"));
    const { getFoodDetailCached } = await import("@/lib/fdc/cache");
    const { food, stale } = await getFoodDetailCached(5);
    expect(stale).toBe(true);
    expect(food.description).toBe("Old");
  });
});

describe("searchFoodsCached", () => {
  it("delegates to the FDC client", async () => {
    searchFoods.mockResolvedValue({ totalHits: 1, currentPage: 1, totalPages: 1, foods: [] });
    const { searchFoodsCached } = await import("@/lib/fdc/cache");
    const res = await searchFoodsCached({ query: "egg", dataType: ["Branded"], page: 1 });
    expect(res.totalHits).toBe(1);
    expect(searchFoods).toHaveBeenCalledWith({ query: "egg", dataType: ["Branded"], pageNumber: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/fdc/cache.test.ts`
Expected: FAIL — `Cannot find module '@/lib/fdc/cache'`.

- [ ] **Step 3: Create the service-role client (`lib/supabase/admin.ts`)**

```ts
// lib/supabase/admin.ts
import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getServerEnv } from "@/lib/env";

/** Service-role client. Bypasses RLS — use ONLY for server-side writes to public
 *  reference tables (food_cache). NEVER import from app/; never expose to the client. */
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    getServerEnv().SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
```

- [ ] **Step 4: Write the cache implementation**

```ts
// lib/fdc/cache.ts
import "server-only";
import { unstable_cache } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { searchFoods, getFoodDetail, FdcError } from "@/lib/fdc/client";
import { normalizeNutrition, type NormalizedNutrition, type RawNutrient } from "@/lib/fdc/nutrients";
import type { FdcFoodDetail, FdcSearchResponse } from "@/lib/validation/fdc";

const SEARCH_TTL = 120; // seconds
const DETAIL_TTL = 900; // seconds
const L2_FRESH_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export type NormalizedFood = {
  fdcId: number;
  description: string;
  dataType: string | null;
  nutrition: NormalizedNutrition;
};

export async function searchFoodsCached(args: {
  query: string;
  dataType: string[];
  page: number;
}): Promise<FdcSearchResponse> {
  const run = unstable_cache(
    () => searchFoods({ query: args.query, dataType: args.dataType, pageNumber: args.page }),
    ["foods-search", args.query, args.dataType.join(","), String(args.page)],
    { revalidate: SEARCH_TTL },
  );
  return run();
}

function toNormalized(detail: FdcFoodDetail): NormalizedFood {
  const foodNutrients: RawNutrient[] = detail.foodNutrients.map((fn) => ({
    id: fn.nutrient.id,
    amount: fn.amount ?? null,
    unitName: fn.nutrient.unitName ?? "",
  }));
  const serving =
    detail.servingSize != null
      ? {
          amount: detail.servingSize,
          unit: detail.servingSizeUnit ?? "g",
          household: detail.householdServingFullText ?? null,
        }
      : undefined;
  return {
    fdcId: detail.fdcId,
    description: detail.description,
    dataType: detail.dataType ?? null,
    nutrition: normalizeNutrition({ dataType: detail.dataType ?? "", foodNutrients, serving }),
  };
}

function rowToFood(row: {
  fdc_id: number; description: string; data_type: string | null; nutrition: NormalizedNutrition;
}): NormalizedFood {
  return { fdcId: row.fdc_id, description: row.description, dataType: row.data_type, nutrition: row.nutrition };
}

export async function getFoodDetailCached(
  fdcId: number,
): Promise<{ food: NormalizedFood; stale: boolean }> {
  const supabase = await createClient();

  // L2: durable Postgres cache
  const { data: row } = await supabase
    .from("food_cache")
    .select("fdc_id, description, data_type, nutrition, fetched_at")
    .eq("fdc_id", fdcId)
    .maybeSingle();

  if (row && Date.now() - new Date(row.fetched_at).getTime() < L2_FRESH_MS) {
    return { food: rowToFood(row), stale: false };
  }

  // L2 miss / stale → L1-wrapped fetch → normalize → upsert
  try {
    const run = unstable_cache(
      () => getFoodDetail(fdcId),
      ["foods-detail", String(fdcId)],
      { revalidate: DETAIL_TTL },
    );
    const detail = await run();
    const food = toNormalized(detail);
    // Cache write uses the service-role client (bypasses RLS). There is no
    // authenticated write path, so an invited user cannot poison the shared cache.
    await createAdminClient().from("food_cache").upsert({
      fdc_id: food.fdcId,
      data_type: food.dataType,
      description: food.description,
      brand_owner: detail.brandOwner ?? null,
      gtin_upc: detail.gtinUpc ?? null,
      raw: detail,
      nutrition: food.nutrition,
    });
    return { food, stale: false };
  } catch (e) {
    // FDC over-limit → serve a stale row if we have one, rather than failing.
    if (e instanceof FdcError && e.kind === "rate_limited" && row) {
      return { food: rowToFood(row), stale: true };
    }
    throw e;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec vitest run tests/fdc/cache.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/supabase/admin.ts lib/fdc/cache.ts tests/fdc/cache.test.ts
git commit -m "feat: add two-layer FDC cache (in-memory L1 + Postgres L2) with service-role write"
```

---

## Task 7: Search route + HTTP helpers (`app/api/foods/route.ts`, `lib/fdc/http.ts`)

**Files:**
- Create: `lib/fdc/http.ts`
- Modify (replace stub): `app/api/foods/route.ts`
- Modify (replace 501 test): `tests/api/foods.test.ts`

**Interfaces:**
- Consumes: `verifySession` (`lib/dal/session.ts`); `enforceRateLimit`, `RateLimitError` (Task 5); `searchQuerySchema` (Task 2); `searchFoodsCached` (Task 6); `FdcError` (Task 3).
- Produces: `lib/fdc/http.ts` exports `jsonError(code, message, status)` and `mapFdcError(e): NextResponse`. `GET` handler for `/api/foods`.

- [ ] **Step 1: Write the failing test (replace the 501 stub test)**

```ts
// tests/api/foods.test.ts  (overwrites the old 501 stub test)
import { describe, it, expect, vi, beforeEach } from "vitest";

const verifySession = vi.fn();
const enforceRateLimit = vi.fn();
const searchFoodsCached = vi.fn();

class RateLimitError extends Error { constructor() { super("rate"); this.name = "RateLimitError"; } }
class FdcError extends Error { constructor(readonly kind: string, readonly retryAfter?: number) { super(kind); this.name = "FdcError"; } }

vi.mock("@/lib/dal/session", () => ({ verifySession: () => verifySession() }));
vi.mock("@/lib/dal/rate-limit", () => ({
  enforceRateLimit: () => enforceRateLimit(),
  RateLimitError,
}));
vi.mock("@/lib/fdc/cache", () => ({ searchFoodsCached: (a: unknown) => searchFoodsCached(a) }));
vi.mock("@/lib/fdc/client", () => ({ FdcError }));

const req = (qs: string) => new Request(`http://localhost/api/foods${qs}`);

beforeEach(() => {
  verifySession.mockResolvedValue({ userId: "u1" });
  enforceRateLimit.mockResolvedValue(undefined);
  searchFoodsCached.mockReset();
});

describe("GET /api/foods (search)", () => {
  it("returns slim results for an authenticated request", async () => {
    searchFoodsCached.mockResolvedValue({
      totalHits: 1, currentPage: 1, totalPages: 1,
      foods: [{ fdcId: 7, description: "Egg", dataType: "Branded", brandOwner: "X", gtinUpc: "0" }],
    });
    const { GET } = await import("@/app/api/foods/route");
    const res = await GET(req("?q=egg"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0]).toEqual({
      fdcId: 7, description: "Egg", dataType: "Branded", brandOwner: "X", gtinUpc: "0",
    });
  });

  it("401s when unauthenticated", async () => {
    verifySession.mockResolvedValue(null);
    const { GET } = await import("@/app/api/foods/route");
    expect((await GET(req("?q=egg"))).status).toBe(401);
  });

  it("429s when throttled", async () => {
    enforceRateLimit.mockRejectedValue(new RateLimitError());
    const { GET } = await import("@/app/api/foods/route");
    expect((await GET(req("?q=egg"))).status).toBe(429);
  });

  it("400s on a missing query", async () => {
    const { GET } = await import("@/app/api/foods/route");
    expect((await GET(req(""))).status).toBe(400);
  });

  it("maps an FDC rate-limit to 429", async () => {
    searchFoodsCached.mockRejectedValue(new FdcError("rate_limited", 30));
    const { GET } = await import("@/app/api/foods/route");
    const res = await GET(req("?q=egg"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/api/foods.test.ts`
Expected: FAIL — the route still exports the 501 stub (no `verifySession`/results behaviour).

- [ ] **Step 3: Write the HTTP helpers**

```ts
// lib/fdc/http.ts
import { NextResponse } from "next/server";
import { FdcError } from "@/lib/fdc/client";

export function jsonError(code: string, message: string, status: number): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

/** Translate an FdcError into a safe client response. Re-throws non-FDC errors. */
export function mapFdcError(e: unknown): NextResponse {
  if (e instanceof FdcError) {
    if (e.kind === "rate_limited") {
      const res = jsonError("UPSTREAM_RATE_LIMITED", "Food database is busy; try again later", 429);
      if (e.retryAfter) res.headers.set("retry-after", String(e.retryAfter));
      return res;
    }
    if (e.kind === "key_missing" || e.kind === "key_rejected") {
      return jsonError("UPSTREAM_UNAVAILABLE", "Food database is unavailable", 503);
    }
    if (e.kind === "not_found") return jsonError("NOT_FOUND", "Food not found", 404);
    return jsonError("UPSTREAM_ERROR", "Food database error", 502);
  }
  throw e as Error;
}
```

- [ ] **Step 4: Write the search route (replace the stub)**

```ts
// app/api/foods/route.ts
import { NextResponse, type NextRequest } from "next/server";
import { verifySession } from "@/lib/dal/session";
import { enforceRateLimit, RateLimitError } from "@/lib/dal/rate-limit";
import { searchQuerySchema } from "@/lib/validation/fdc";
import { searchFoodsCached } from "@/lib/fdc/cache";
import { jsonError, mapFdcError } from "@/lib/fdc/http";

// proxy.ts does NOT gate /api routes — this handler authenticates itself.
export async function GET(request: NextRequest | Request) {
  const session = await verifySession();
  if (!session) return jsonError("UNAUTHENTICATED", "Sign in required", 401);

  try {
    await enforceRateLimit();
  } catch (e) {
    if (e instanceof RateLimitError) return jsonError("RATE_LIMITED", "Too many requests", 429);
    throw e;
  }

  const sp = new URL(request.url).searchParams;
  const parsed = searchQuerySchema.safeParse({
    q: sp.get("q") ?? undefined,
    dataType: sp.get("dataType")?.split(",").filter(Boolean) ?? undefined,
    page: sp.get("page") ?? undefined,
  });
  if (!parsed.success) return jsonError("INVALID_REQUEST", "Invalid search parameters", 400);

  try {
    const result = await searchFoodsCached({
      query: parsed.data.q,
      dataType: parsed.data.dataType,
      page: parsed.data.page,
    });
    return NextResponse.json({
      query: parsed.data.q,
      page: parsed.data.page,
      totalHits: result.totalHits,
      results: result.foods.map((f) => ({
        fdcId: f.fdcId,
        description: f.description,
        dataType: f.dataType ?? null,
        brandOwner: f.brandOwner ?? null,
        gtinUpc: f.gtinUpc ?? null,
      })),
    });
  } catch (e) {
    return mapFdcError(e);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec vitest run tests/api/foods.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/fdc/http.ts app/api/foods/route.ts tests/api/foods.test.ts
git commit -m "feat: wire /api/foods search to FDC with auth, throttle, and cache"
```

---

## Task 8: Detail route (`app/api/foods/[fdcId]/route.ts`)

**Files:**
- Create: `app/api/foods/[fdcId]/route.ts`
- Test: `tests/api/foods-detail.test.ts`

**Interfaces:**
- Consumes: `verifySession`; `enforceRateLimit`, `RateLimitError` (Task 5); `fdcIdSchema` (Task 2); `getFoodDetailCached` (Task 6); `jsonError`, `mapFdcError` (Task 7).
- Produces: `GET(request, { params: Promise<{ fdcId: string }> })` for `/api/foods/[fdcId]`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/api/foods-detail.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const verifySession = vi.fn();
const enforceRateLimit = vi.fn();
const getFoodDetailCached = vi.fn();

class RateLimitError extends Error { constructor() { super("rate"); this.name = "RateLimitError"; } }
class FdcError extends Error { constructor(readonly kind: string) { super(kind); this.name = "FdcError"; } }

vi.mock("@/lib/dal/session", () => ({ verifySession: () => verifySession() }));
vi.mock("@/lib/dal/rate-limit", () => ({ enforceRateLimit: () => enforceRateLimit(), RateLimitError }));
vi.mock("@/lib/fdc/cache", () => ({ getFoodDetailCached: (id: number) => getFoodDetailCached(id) }));
vi.mock("@/lib/fdc/client", () => ({ FdcError }));

const ctx = (fdcId: string) => ({ params: Promise.resolve({ fdcId }) });
const req = new Request("http://localhost/api/foods/5");

beforeEach(() => {
  verifySession.mockResolvedValue({ userId: "u1" });
  enforceRateLimit.mockResolvedValue(undefined);
  getFoodDetailCached.mockReset();
});

describe("GET /api/foods/[fdcId] (detail)", () => {
  it("returns the normalized food", async () => {
    getFoodDetailCached.mockResolvedValue({
      food: { fdcId: 5, description: "Egg", dataType: "Branded",
              nutrition: { basis: "100g", nutrients: {} } },
      stale: false,
    });
    const { GET } = await import("@/app/api/foods/[fdcId]/route");
    const res = await GET(req, ctx("5"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fdcId).toBe(5);
    expect(body.stale).toBeUndefined();
  });

  it("flags a stale response", async () => {
    getFoodDetailCached.mockResolvedValue({
      food: { fdcId: 5, description: "Egg", dataType: "Branded",
              nutrition: { basis: "100g", nutrients: {} } },
      stale: true,
    });
    const { GET } = await import("@/app/api/foods/[fdcId]/route");
    const body = await (await GET(req, ctx("5"))).json();
    expect(body.stale).toBe(true);
  });

  it("400s on a non-numeric id", async () => {
    const { GET } = await import("@/app/api/foods/[fdcId]/route");
    expect((await GET(req, ctx("abc"))).status).toBe(400);
  });

  it("401s when unauthenticated", async () => {
    verifySession.mockResolvedValue(null);
    const { GET } = await import("@/app/api/foods/[fdcId]/route");
    expect((await GET(req, ctx("5"))).status).toBe(401);
  });

  it("404s when FDC reports not found", async () => {
    getFoodDetailCached.mockRejectedValue(new FdcError("not_found"));
    const { GET } = await import("@/app/api/foods/[fdcId]/route");
    expect((await GET(req, ctx("5"))).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/api/foods-detail.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/foods/[fdcId]/route'`.

- [ ] **Step 3: Write the implementation**

```ts
// app/api/foods/[fdcId]/route.ts
import { NextResponse } from "next/server";
import { verifySession } from "@/lib/dal/session";
import { enforceRateLimit, RateLimitError } from "@/lib/dal/rate-limit";
import { fdcIdSchema } from "@/lib/validation/fdc";
import { getFoodDetailCached } from "@/lib/fdc/cache";
import { jsonError, mapFdcError } from "@/lib/fdc/http";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ fdcId: string }> },
) {
  const session = await verifySession();
  if (!session) return jsonError("UNAUTHENTICATED", "Sign in required", 401);

  try {
    await enforceRateLimit();
  } catch (e) {
    if (e instanceof RateLimitError) return jsonError("RATE_LIMITED", "Too many requests", 429);
    throw e;
  }

  const { fdcId } = await params;
  const parsed = fdcIdSchema.safeParse(fdcId);
  if (!parsed.success) return jsonError("INVALID_REQUEST", "Invalid food id", 400);

  try {
    const { food, stale } = await getFoodDetailCached(parsed.data);
    return NextResponse.json({ ...food, ...(stale ? { stale: true } : {}) });
  } catch (e) {
    return mapFdcError(e);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/api/foods-detail.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/foods/[fdcId]/route.ts tests/api/foods-detail.test.ts
git commit -m "feat: add /api/foods/[fdcId] nutrient detail route"
```

---

## Task 9: Docs, env, and full-suite verification

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Refresh the `FDC_API_KEY` comment in `.env.example`**

Replace the stale "reserved for a later phase; unused in v1" comment:

```bash
# USDA FoodData Central — SERVER ONLY. Powers /api/foods search + detail.
# Free key: https://fdc.nal.usda.gov/api-key-signup/ (1,000 requests/hour).
FDC_API_KEY=your-fdc-key-here
```

- [ ] **Step 2: Document the endpoints in `README.md`**

Add a section after `## Scripts`:

```markdown
## Food API (Phase 1)

Authenticated JSON endpoints backed by USDA FoodData Central (FDC), cached and rate-limited.

- `GET /api/foods?q=<query>&dataType=<csv>&page=<n>` — search (defaults to Branded + Foundation + SR Legacy).
- `GET /api/foods/{fdcId}` — normalized nutrient detail for one food.

Both require a signed-in session and apply a per-user request throttle. Set `FDC_API_KEY`
(see `.env.example`) for live data; without it the endpoints return `503`.

Data source: **USDA FoodData Central** (public domain, CC0 1.0).
```

- [ ] **Step 3: Run the full per-push suite**

```bash
pnpm lint
pnpm typecheck
pnpm test
```
Expected: all green. The new unit suites (`tests/fdc/*`, `tests/dal/*`, `tests/api/*`) run; `tests/rls/food-cache.test.ts` self-skips without `SUPABASE_TEST_*` env.

- [ ] **Step 4: Run the RLS integration suite once against a local stack**

```bash
supabase start && supabase db reset --no-seed
supabase status -o env > /tmp/supa.env
export SUPABASE_TEST_URL=$(grep '^API_URL=' /tmp/supa.env | cut -d= -f2- | tr -d '"')
export SUPABASE_TEST_ANON_KEY=$(grep '^ANON_KEY=' /tmp/supa.env | cut -d= -f2- | tr -d '"')
export SUPABASE_TEST_SERVICE_ROLE_KEY=$(grep '^SERVICE_ROLE_KEY=' /tmp/supa.env | cut -d= -f2- | tr -d '"')
pnpm exec vitest run tests/rls/food-cache.test.ts --no-file-parallelism
supabase stop
```
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add .env.example README.md
git commit -m "docs: document the Phase 1 food API and FDC key"
```

---

## Self-Review (completed during planning)

**1. Spec coverage** — every spec section maps to a task:
- §3 backend-only / cache / L1 mechanism / RLS / privileged-write / nutrient model / throttle → Tasks 1–8.
- §4 module layout → File Structure + Tasks 1–8.
- §5 data model + functions → Task 4.
- §5 nutrient model → Task 1.
- §6 request flow → Tasks 7, 8 (+ cache Task 6).
- §7 errors → `lib/fdc/http.ts` (Task 7), `FdcError` (Task 3), 401/400/429 in routes.
- §8 default tunables → constants in Tasks 5 (`RATE_LIMIT`/`RATE_WINDOW_SECONDS`), 6 (`SEARCH_TTL`/`DETAIL_TTL`/`L2_FRESH_MS`), 2 (`DEFAULT_DATA_TYPES`).
- §8 secret handling → Task 3 (`apiKey()` + `import "server-only"`), Task 9 (`.env.example`).
- §9 testing matrix → test file per task + Task 4 RLS suite.
- §10 risks → lenient Zod (Task 2), throttle (Tasks 4/5), no service-role on request path (Task 4 functions), null-not-zero (Task 1).
- §11 success criteria → covered by Tasks 7/8 (auth + 401), 6 (L2 hit skips FDC), 4/5 (throttle), 7 (stale/429 grace), 9 (full suite green), 4 (RLS CI).

**2. Placeholder scan** — no TBD/TODO; every code step contains complete code; every test step contains real assertions.

**3. Type consistency** — `NormalizedNutrition`/`RawNutrient`/`NormalizeInput` (Task 1) are consumed unchanged by Task 6; `FdcFoodDetail`/`FdcSearchResponse` (Task 2) flow into Tasks 3 and 6; `FdcError.kind` values are identical across Tasks 3, 6, 7; `NormalizedFood` shape returned by Task 6 matches what Tasks 8's test asserts; RPC names (`upsert_food_cache`, `check_and_increment_rate`) and parameter names match between Task 4 (SQL), Task 5, and Task 6.
