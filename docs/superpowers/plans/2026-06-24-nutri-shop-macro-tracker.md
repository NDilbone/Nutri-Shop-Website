# Phase 2 — Macro/Micro Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a phone-first macro/micro tracker — search USDA foods, log what you ate (grams or servings, by meal, on a chosen day) via a quick-add sheet, and see that day's meal-grouped totals — on a dark-editorial design system with a bottom-tab nav shell.

**Architecture:** A new owner-only `logged_foods` table (RLS, snapshot nutrition per row) sits behind a server-only DAL. Server Actions validate input and derive the authoritative nutrition snapshot from the existing Phase-1 `getFoodDetailCached`. Pure functions in `lib/nutrition` + `lib/date` do all math/date logic (fully unit-tested). The UI is a `(app)` route group (server-gated by `requireUser()`) with a bottom `TabBar`; the interactive parts (search, quick-add/edit sheet) are client components calling the Server Actions and the Phase-1 `/api/foods` routes.

**Tech Stack:** Next.js 16 App Router, React 19, Supabase (Postgres + RLS + `@supabase/ssr`), Zod 4, Tailwind 4, vitest 4, TypeScript 6.

## Global Constraints

- **Versions (already pinned — do not change):** next 16.2.9, react/react-dom 19.2.7, @supabase/supabase-js 2.108.2, @supabase/ssr 0.12.0, zod 4.4.3, tailwindcss 4.3.1, vitest 4.1.9, typescript 6.0.3. pnpm 11.9.0, Node ≥24.
- **No new dependencies.** Inter font via `next/font/google` (self-hosts; satisfies `font-src 'self'`). No component library; build the ~8 primitives by hand. No date library.
- **TS strict + `noUncheckedIndexedAccess: true`** — array element access is `T | undefined`; iterate with `for…of`, not indexed loops. `Record<NutrientKey, V>` indexed by a `NutrientKey` literal is `V` (safe).
- **CSP (from `proxy.ts`): no inline `<script>`, no inline `style="…"` attributes** (prod `style-src` is `'self' 'nonce-…'`, no `'unsafe-inline'`). All styling via Tailwind classes / `globals.css`. Client interactivity is fine (bundled JS gets the nonce). Native `<details>`/`<summary>` for collapsibles (no JS). `fetch` only to same-origin `/api/*` (`connect-src 'self'`).
- **Security:** `logged_foods` is owner-only RLS (all of select/insert/update/delete keyed to `auth.uid() = user_id`). Log writes use the **authenticated** server client under RLS — never the service-role client. Stored `nutrition` is **always server-derived from `fdcId`** via `getFoodDetailCached`, never taken from client input. `user_id` always from the verified session. Zod-validate every Server Action boundary.
- **Tests are logic-only** (vitest `environment: "node"`, no DOM). Test pure functions, the DAL, and Server Actions by mocking. UI is verified by `pnpm typecheck && pnpm build` + manual run. Mock pattern: `vi.mock("@/lib/supabase/server", …)` + dynamic `await import(...)` after mocks (see `tests/fdc/cache.test.ts`).
- **Identity:** all commits authored by the repo-local git identity **NDilbone**. No AI/Claude attribution anywhere. Branch: `phase-2-macro-tracker` (already created; spec already committed there).
- **Path alias:** `@/*` → repo root. Run all commands from the repo root.

---

### Task 1: `logged_foods` migration + RLS isolation test

**Files:**
- Create: `supabase/migrations/0003_logged_foods.sql`
- Create: `tests/rls/logged-foods.test.ts`

**Interfaces:**
- Produces: table `public.logged_foods` (columns `id, user_id, fdc_id, description, meal, amount_grams, nutrition, logged_on, logged_at, created_at, updated_at, deleted_at`); function `public.set_updated_at()`. Consumed by Task 5 (DAL) and the RLS workflow.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0003_logged_foods.sql`:

```sql
-- Phase 2: per-user food log. Owner-only RLS. Nutrition is snapshotted per row
-- (a log is a historical fact: it must not change if USDA refreshes or the cache evicts).

create table public.logged_foods (
  id           uuid primary key default gen_random_uuid(),       -- DB default; a client may also mint (offline-ready, Phase 5)
  user_id      uuid not null references auth.users (id) on delete cascade,
  fdc_id       bigint not null,                                   -- source food (re-open / future re-derive)
  description  text not null,                                     -- label snapshot at log time
  meal         text not null check (meal in ('breakfast','lunch','dinner','snack')),
  amount_grams numeric not null check (amount_grams > 0 and amount_grams <= 100000),
  nutrition    jsonb not null,                                    -- per-100g NormalizedNutrition snapshot
  logged_on    date not null,                                     -- day it counts toward (client local tz)
  logged_at    timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz                                        -- soft delete (sync-ready, Phase 5)
);

create index logged_foods_user_day
  on public.logged_foods (user_id, logged_on)
  where deleted_at is null;

alter table public.logged_foods enable row level security;

create policy "logged_foods_select_own" on public.logged_foods
  for select using ( (select auth.uid()) = user_id );
create policy "logged_foods_insert_own" on public.logged_foods
  for insert with check ( (select auth.uid()) = user_id );
create policy "logged_foods_update_own" on public.logged_foods
  for update using ( (select auth.uid()) = user_id )
             with check ( (select auth.uid()) = user_id );
create policy "logged_foods_delete_own" on public.logged_foods
  for delete using ( (select auth.uid()) = user_id );

-- Explicit grants: a fresh local CI stack lacks Supabase's implicit defaults
-- (lesson from 0001). RLS still gates which rows each role can touch.
grant all on public.logged_foods to service_role;
grant select, insert, update, delete on public.logged_foods to authenticated;

-- Bump updated_at on every UPDATE (last-write-wins sync, Phase 5).
create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end; $$;

create trigger logged_foods_set_updated_at
  before update on public.logged_foods
  for each row execute function public.set_updated_at();
```

- [ ] **Step 2: Write the RLS isolation test**

Create `tests/rls/logged-foods.test.ts` (mirrors `tests/rls/isolation.test.ts`; self-skips without `SUPABASE_TEST_*`, fail-closed under `REQUIRE_SUPABASE_TESTS=1`):

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { HAS_SUPABASE_TEST_ENV, makeUser } from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

if (process.env.REQUIRE_SUPABASE_TESTS === "1" && !HAS_SUPABASE_TEST_ENV) {
  throw new Error("REQUIRE_SUPABASE_TESTS=1 but SUPABASE_TEST_* env is missing");
}

const SNAPSHOT = { basis: "100g", nutrients: {} };

let userA: SupabaseClient;
let userB: SupabaseClient;
let userAId: string;
let userBId: string;

describe.skipIf(!HAS_SUPABASE_TEST_ENV)("logged_foods RLS isolation", () => {
  beforeAll(async () => {
    userA = await makeUser("logger-a@example.com", "LoggerA-pw-123!");
    userB = await makeUser("logger-b@example.com", "LoggerB-pw-123!");
    userAId = (await userA.auth.getUser()).data.user!.id;
    userBId = (await userB.auth.getUser()).data.user!.id;
  });

  it("a user can insert and read their OWN entry", async () => {
    const { error: insErr } = await userA.from("logged_foods").insert({
      user_id: userAId, fdc_id: 1, description: "A food", meal: "lunch",
      amount_grams: 100, nutrition: SNAPSHOT, logged_on: "2026-06-24",
    });
    expect(insErr).toBeNull();
    const { data, error } = await userA.from("logged_foods")
      .select("id").eq("user_id", userAId).eq("logged_on", "2026-06-24");
    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterTplaceholderHANZERO; // replaced below
  });

  it("a user CANNOT insert an entry owned by another user", async () => {
    const { error } = await userB.from("logged_foods").insert({
      user_id: userAId, fdc_id: 2, description: "spoof", meal: "snack",
      amount_grams: 50, nutrition: SNAPSHOT, logged_on: "2026-06-24",
    });
    expect(error).not.toBeNull(); // with-check rejects user_id != auth.uid()
  });

  it("a user CANNOT read another user's entries", async () => {
    const { data, error } = await userB.from("logged_foods").select("id").eq("user_id", userAId);
    expect(error).toBeNull();          // RLS returns zero rows, not an error
    expect(data).toHaveLength(0);
  });

  it("a user CANNOT update another user's entry", async () => {
    await userB.from("logged_foods").update({ amount_grams: 999 }).eq("user_id", userAId);
    const { data } = await userA.from("logged_foods")
      .select("amount_grams").eq("user_id", userAId).eq("fdc_id", 1).limit(1).single();
    expect(data!.amount_grams).not.toBe(999);
  });

  it("soft-deleted rows are excluded when filtering deleted_at is null", async () => {
    const ins = await userA.from("logged_foods").insert({
      user_id: userAId, fdc_id: 3, description: "to delete", meal: "dinner",
      amount_grams: 10, nutrition: SNAPSHOT, logged_on: "2026-06-25",
    }).select("id").single();
    await userA.from("logged_foods").update({ deleted_at: new Date().toISOString() }).eq("id", ins.data!.id);
    const { data } = await userA.from("logged_foods")
      .select("id").eq("logged_on", "2026-06-25").is("deleted_at", null);
    expect(data ?? []).toHaveLength(0);
  });
});
```

Fix the deliberate typo from Step 2: replace `expect((data ?? []).length).toBeGreaterTplaceholderHANZERO;` with `expect((data ?? []).length).toBeGreaterThan(0);`. (Sentinel so you don't skim past it — the line must read `toBeGreaterThan(0)`.)

- [ ] **Step 3: Run the test (verify it self-skips offline)**

Run: `pnpm test tests/rls/logged-foods.test.ts`
Expected: the suite is **skipped** (no `SUPABASE_TEST_*` locally) — vitest reports 0 failures. (Real execution happens in the `rls.yml` workflow and against the cloud project in Task 12.)

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (the `.test.ts` compiles).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0003_logged_foods.sql tests/rls/logged-foods.test.ts
git commit -m "feat(db): add logged_foods table with owner-only RLS and isolation test"
```

---

### Task 2: Nutrition types + pure math (`lib/nutrition`)

**Files:**
- Create: `lib/nutrition/types.ts`
- Create: `lib/nutrition/compute.ts`
- Test: `tests/nutrition/compute.test.ts`

**Interfaces:**
- Consumes: `NutrientKey`, `NutrientValue`, `NormalizedNutrition` from `@/lib/fdc/nutrients`.
- Produces:
  - types: `Meal`, `MEALS: readonly Meal[]`, `LoggedEntry`, `NutrientTotal`, `DayTotals = Record<NutrientKey, NutrientTotal>`, `MealGroup`, `DayData`.
  - fns: `scaleNutrients(nutrition, grams): Record<NutrientKey, NutrientValue>`; `entryKcal(entry): number | null`; `servingsToGrams(servings, serving?): number | null`; `defaultMealForHour(hour): Meal`; `sumTotals(entries): DayTotals`; `groupByMeal(entries): MealGroup[]`; `buildDayData(date, entries): DayData`.

- [ ] **Step 1: Write the failing tests**

Create `tests/nutrition/compute.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  scaleNutrients, entryKcal, servingsToGrams, defaultMealForHour, sumTotals, buildDayData,
} from "@/lib/nutrition/compute";
import type { LoggedEntry } from "@/lib/nutrition/types";
import type { NormalizedNutrition } from "@/lib/fdc/nutrients";

function nutrition(part: Partial<Record<string, { amount: number | null; unit: string }>> = {}): NormalizedNutrition {
  const base = {
    energyKcal: { amount: 0, unit: "kcal" }, protein: { amount: 0, unit: "g" },
    totalFat: { amount: 0, unit: "g" }, saturatedFat: { amount: 0, unit: "g" },
    carbs: { amount: 0, unit: "g" }, fiber: { amount: 0, unit: "g" },
    totalSugars: { amount: 0, unit: "g" }, addedSugars: { amount: 0, unit: "g" },
    sodium: { amount: 0, unit: "mg" }, calcium: { amount: 0, unit: "mg" },
    iron: { amount: 0, unit: "mg" }, potassium: { amount: 0, unit: "mg" },
    cholesterol: { amount: 0, unit: "mg" }, vitaminD: { amount: 0, unit: "µg" },
  };
  return { basis: "100g", nutrients: { ...base, ...part } } as NormalizedNutrition;
}

function entry(over: Partial<LoggedEntry>): LoggedEntry {
  return {
    id: "x", fdcId: 1, description: "f", meal: "lunch", amountGrams: 100,
    nutrition: nutrition(), loggedOn: "2026-06-24", loggedAt: "2026-06-24T12:00:00Z", ...over,
  };
}

describe("scaleNutrients", () => {
  it("scales per-100g by grams/100", () => {
    const n = nutrition({ protein: { amount: 20, unit: "g" } });
    expect(scaleNutrients(n, 150).protein).toEqual({ amount: 30, unit: "g" });
  });
  it("keeps null as null (never coerces to 0)", () => {
    const n = nutrition({ sodium: { amount: null, unit: "mg" } });
    expect(scaleNutrients(n, 200).sodium).toEqual({ amount: null, unit: "mg" });
  });
});

describe("entryKcal", () => {
  it("returns scaled calories", () => {
    expect(entryKcal(entry({ nutrition: nutrition({ energyKcal: { amount: 100, unit: "kcal" } }), amountGrams: 250 }))).toBe(250);
  });
  it("returns null when energy is unreported", () => {
    expect(entryKcal(entry({ nutrition: nutrition({ energyKcal: { amount: null, unit: "kcal" } }) }))).toBeNull();
  });
});

describe("servingsToGrams", () => {
  it("multiplies servings by serving size", () => {
    expect(servingsToGrams(2, { amount: 30, unit: "g" })).toBe(60);
  });
  it("returns null when no serving size exists", () => {
    expect(servingsToGrams(2, undefined)).toBeNull();
  });
});

describe("defaultMealForHour", () => {
  it("maps hours to meals", () => {
    expect(defaultMealForHour(8)).toBe("breakfast");
    expect(defaultMealForHour(13)).toBe("lunch");
    expect(defaultMealForHour(19)).toBe("dinner");
    expect(defaultMealForHour(23)).toBe("snack");
  });
});

describe("sumTotals", () => {
  it("sums a nutrient across entries", () => {
    const e1 = entry({ nutrition: nutrition({ protein: { amount: 10, unit: "g" } }), amountGrams: 100 });
    const e2 = entry({ nutrition: nutrition({ protein: { amount: 20, unit: "g" } }), amountGrams: 50 });
    const t = sumTotals([e1, e2]);
    expect(t.protein.amount).toBe(20); // 10 + 10
    expect(t.protein.incomplete).toBe(false);
  });
  it("flags incomplete when any contributor was null", () => {
    const e1 = entry({ nutrition: nutrition({ sodium: { amount: 5, unit: "mg" } }) });
    const e2 = entry({ nutrition: nutrition({ sodium: { amount: null, unit: "mg" } }) });
    const t = sumTotals([e1, e2]);
    expect(t.sodium.amount).toBe(5);       // null contributes 0
    expect(t.sodium.incomplete).toBe(true);
  });
});

describe("buildDayData", () => {
  it("groups entries by meal in canonical order with day totals", () => {
    const d = buildDayData("2026-06-24", [
      entry({ meal: "dinner", nutrition: nutrition({ energyKcal: { amount: 100, unit: "kcal" } }) }),
      entry({ meal: "breakfast", nutrition: nutrition({ energyKcal: { amount: 50, unit: "kcal" } }) }),
    ]);
    expect(d.date).toBe("2026-06-24");
    expect(d.meals.map((m) => m.meal)).toEqual(["breakfast", "lunch", "dinner", "snack"]);
    expect(d.totals.energyKcal.amount).toBe(150);
    const breakfast = d.meals.find((m) => m.meal === "breakfast")!;
    expect(breakfast.entries).toHaveLength(1);
    expect(breakfast.subtotalKcal).toBe(50);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/nutrition/compute.test.ts`
Expected: FAIL — `Cannot find module '@/lib/nutrition/compute'`.

- [ ] **Step 3: Write the types**

Create `lib/nutrition/types.ts`:

```ts
import type { NutrientKey, NutrientValue, NormalizedNutrition } from "@/lib/fdc/nutrients";

export type Meal = "breakfast" | "lunch" | "dinner" | "snack";
export const MEALS: readonly Meal[] = ["breakfast", "lunch", "dinner", "snack"];

export type LoggedEntry = {
  id: string;
  fdcId: number;
  description: string;
  meal: Meal;
  amountGrams: number;
  nutrition: NormalizedNutrition; // per-100g snapshot
  loggedOn: string;              // YYYY-MM-DD
  loggedAt: string;              // ISO timestamp
};

export type NutrientTotal = { amount: number; unit: string; incomplete: boolean };
export type DayTotals = Record<NutrientKey, NutrientTotal>;

export type MealGroup = { meal: Meal; entries: LoggedEntry[]; subtotalKcal: number };

export type DayData = { date: string; totals: DayTotals; meals: MealGroup[] };

export type { NutrientKey, NutrientValue };
```

- [ ] **Step 4: Write the implementation**

Create `lib/nutrition/compute.ts`:

```ts
import type { NutrientKey, NutrientValue, NormalizedNutrition } from "@/lib/fdc/nutrients";
import { type Meal, MEALS, type LoggedEntry, type DayTotals, type MealGroup, type DayData } from "@/lib/nutrition/types";

const NUTRIENT_KEYS: NutrientKey[] = [
  "energyKcal", "protein", "totalFat", "saturatedFat", "carbs", "fiber", "totalSugars",
  "addedSugars", "sodium", "calcium", "iron", "potassium", "cholesterol", "vitaminD",
];

export function scaleNutrients(nutrition: NormalizedNutrition, grams: number): Record<NutrientKey, NutrientValue> {
  const out = {} as Record<NutrientKey, NutrientValue>;
  for (const key of NUTRIENT_KEYS) {
    const v = nutrition.nutrients[key];
    out[key] = v.amount == null ? { amount: null, unit: v.unit } : { amount: round(v.amount * grams / 100), unit: v.unit };
  }
  return out;
}

export function entryKcal(entry: LoggedEntry): number | null {
  const e = entry.nutrition.nutrients.energyKcal;
  return e.amount == null ? null : round(e.amount * entry.amountGrams / 100);
}

export function servingsToGrams(servings: number, serving?: { amount: number; unit: string }): number | null {
  if (!serving) return null;
  return round(servings * serving.amount);
}

export function defaultMealForHour(hour: number): Meal {
  if (hour < 11) return "breakfast";
  if (hour < 16) return "lunch";
  if (hour < 21) return "dinner";
  return "snack";
}

export function sumTotals(entries: LoggedEntry[]): DayTotals {
  const totals = {} as DayTotals;
  for (const key of NUTRIENT_KEYS) {
    let sum = 0;
    let incomplete = false;
    let unit = "";
    for (const entry of entries) {
      const v = entry.nutrition.nutrients[key];
      unit = unit || v.unit;
      if (v.amount == null) incomplete = true;
      else sum += v.amount * entry.amountGrams / 100;
    }
    totals[key] = { amount: round(sum), unit, incomplete };
  }
  return totals;
}

export function groupByMeal(entries: LoggedEntry[]): MealGroup[] {
  return MEALS.map((meal) => {
    const mealEntries = entries.filter((e) => e.meal === meal);
    const subtotalKcal = mealEntries.reduce((acc, e) => acc + (entryKcal(e) ?? 0), 0);
    return { meal, entries: mealEntries, subtotalKcal: round(subtotalKcal) };
  });
}

export function buildDayData(date: string, entries: LoggedEntry[]): DayData {
  return { date, totals: sumTotals(entries), meals: groupByMeal(entries) };
}

function round(n: number): number {
  return Math.round(n * 10) / 10; // one decimal; display layer rounds further
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test tests/nutrition/compute.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm typecheck` → PASS

```bash
git add lib/nutrition/types.ts lib/nutrition/compute.ts tests/nutrition/compute.test.ts
git commit -m "feat(nutrition): add pure scaling, totals, and meal-grouping math"
```

---

### Task 3: Date helpers (`lib/date.ts`)

**Files:**
- Create: `lib/date.ts`
- Test: `tests/date.test.ts`

**Interfaces:**
- Produces: `todayLocal(): string`; `addDays(dateStr, n): string`; `isValidDateStr(s): boolean`; `formatDayLabel(dateStr, todayStr): string`.

- [ ] **Step 1: Write the failing tests**

Create `tests/date.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { addDays, isValidDateStr, formatDayLabel } from "@/lib/date";

describe("addDays", () => {
  it("advances and rolls over months", () => {
    expect(addDays("2026-06-24", 1)).toBe("2026-06-25");
    expect(addDays("2026-06-30", 1)).toBe("2026-07-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });
});

describe("isValidDateStr", () => {
  it("accepts YYYY-MM-DD and rejects junk", () => {
    expect(isValidDateStr("2026-06-24")).toBe(true);
    expect(isValidDateStr("2026-6-4")).toBe(false);
    expect(isValidDateStr("nope")).toBe(false);
    expect(isValidDateStr("2026-13-01")).toBe(false);
  });
});

describe("formatDayLabel", () => {
  it("says Today/Yesterday/Tomorrow, else a weekday label", () => {
    expect(formatDayLabel("2026-06-24", "2026-06-24")).toBe("Today");
    expect(formatDayLabel("2026-06-23", "2026-06-24")).toBe("Yesterday");
    expect(formatDayLabel("2026-06-25", "2026-06-24")).toBe("Tomorrow");
    expect(formatDayLabel("2026-06-20", "2026-06-24")).toMatch(/Jun 20/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test tests/date.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `lib/date.ts`:

```ts
/** Local-timezone calendar date as YYYY-MM-DD. Client-side use (reads the wall clock). */
export function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Add n days to a YYYY-MM-DD string using UTC math (no tz drift). */
export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function isValidDateStr(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDayLabel(dateStr: string, todayStr: string): string {
  if (dateStr === todayStr) return "Today";
  if (dateStr === addDays(todayStr, -1)) return "Yesterday";
  if (dateStr === addDays(todayStr, 1)) return "Tomorrow";
  const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  return `${weekday}, ${MONTHS[m - 1]} ${d}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
```

- [ ] **Step 4: Run tests → PASS**

Run: `pnpm test tests/date.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm typecheck` → PASS

```bash
git add lib/date.ts tests/date.test.ts
git commit -m "feat(date): add tz-safe date string helpers"
```

---

### Task 4: Validation schemas (`lib/validation/log.ts`)

**Files:**
- Create: `lib/validation/log.ts`
- Test: `tests/validation/log.test.ts`

**Interfaces:**
- Produces: `addFoodSchema`, `editFoodSchema`, `deleteFoodSchema`, `dateParamSchema`; types `AddFoodInput`, `EditFoodInput`.

- [ ] **Step 1: Write the failing tests**

Create `tests/validation/log.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { addFoodSchema, editFoodSchema, deleteFoodSchema, dateParamSchema } from "@/lib/validation/log";

describe("addFoodSchema", () => {
  it("accepts a valid entry", () => {
    const r = addFoodSchema.safeParse({ fdcId: 5, amountGrams: 150, meal: "lunch", loggedOn: "2026-06-24" });
    expect(r.success).toBe(true);
  });
  it("rejects non-positive or huge grams", () => {
    expect(addFoodSchema.safeParse({ fdcId: 5, amountGrams: 0, meal: "lunch", loggedOn: "2026-06-24" }).success).toBe(false);
    expect(addFoodSchema.safeParse({ fdcId: 5, amountGrams: 999999, meal: "lunch", loggedOn: "2026-06-24" }).success).toBe(false);
  });
  it("rejects a bad meal or date", () => {
    expect(addFoodSchema.safeParse({ fdcId: 5, amountGrams: 10, meal: "brunch", loggedOn: "2026-06-24" }).success).toBe(false);
    expect(addFoodSchema.safeParse({ fdcId: 5, amountGrams: 10, meal: "lunch", loggedOn: "06/24/2026" }).success).toBe(false);
  });
});

describe("editFoodSchema", () => {
  it("requires an id and allows partial fields", () => {
    expect(editFoodSchema.safeParse({ id: crypto.randomUUID(), amountGrams: 80 }).success).toBe(true);
    expect(editFoodSchema.safeParse({ amountGrams: 80 }).success).toBe(false);
  });
});

describe("deleteFoodSchema", () => {
  it("requires a uuid id", () => {
    expect(deleteFoodSchema.safeParse({ id: crypto.randomUUID() }).success).toBe(true);
    expect(deleteFoodSchema.safeParse({ id: "nope" }).success).toBe(false);
  });
});

describe("dateParamSchema", () => {
  it("accepts YYYY-MM-DD only", () => {
    expect(dateParamSchema.safeParse("2026-06-24").success).toBe(true);
    expect(dateParamSchema.safeParse("2026-6-4").success).toBe(false);
  });
});
```

- [ ] **Step 2: Run → FAIL** (`pnpm test tests/validation/log.test.ts`) — module not found.

- [ ] **Step 3: Implement**

Create `lib/validation/log.ts`:

```ts
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
```

- [ ] **Step 4: Run → PASS** (`pnpm test tests/validation/log.test.ts`)

- [ ] **Step 5: Typecheck + commit**

```bash
git add lib/validation/log.ts tests/validation/log.test.ts
git commit -m "feat(validation): add log add/edit/delete Zod schemas"
```

---

### Task 5: Logged-foods DAL (`lib/dal/logged-foods.ts`)

**Files:**
- Create: `lib/dal/logged-foods.ts`
- Test: `tests/dal/logged-foods.test.ts`

**Interfaces:**
- Consumes: `verifySession` from `@/lib/dal/session`; `getFoodDetailCached` from `@/lib/fdc/cache`; `createClient` from `@/lib/supabase/server`; `buildDayData` from `@/lib/nutrition/compute`; `AddFoodInput`, `EditFoodInput` from `@/lib/validation/log`.
- Produces: `logFood(input: AddFoodInput): Promise<{ id: string }>`; `editLog(input: EditFoodInput): Promise<void>`; `softDeleteLog(id: string): Promise<void>`; `getDay(loggedOn: string): Promise<DayData>`.

- [ ] **Step 1: Write the failing tests**

Create `tests/dal/logged-foods.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const verifySession = vi.fn();
vi.mock("@/lib/dal/session", () => ({ verifySession: (...a: unknown[]) => verifySession(...a) }));

const getFoodDetailCached = vi.fn();
vi.mock("@/lib/fdc/cache", () => ({ getFoodDetailCached: (...a: unknown[]) => getFoodDetailCached(...a) }));

const from = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn().mockResolvedValue({ from }) }));

beforeEach(() => {
  verifySession.mockReset();
  getFoodDetailCached.mockReset();
  from.mockReset();
});

const NUTR = { basis: "100g", nutrients: {} };

describe("logFood", () => {
  it("snapshots nutrition from the cache and inserts with the session user_id", async () => {
    verifySession.mockResolvedValue({ userId: "u1" });
    getFoodDetailCached.mockResolvedValue({ food: { fdcId: 5, description: "Egg", dataType: "Foundation", nutrition: NUTR }, stale: false });
    const insertCapture = vi.fn().mockReturnValue({
      select: () => ({ single: () => Promise.resolve({ data: { id: "row1" }, error: null }) }),
    });
    from.mockReturnValue({ insert: insertCapture });

    const { logFood } = await import("@/lib/dal/logged-foods");
    const res = await logFood({ fdcId: 5, amountGrams: 150, meal: "lunch", loggedOn: "2026-06-24" });

    expect(res).toEqual({ id: "row1" });
    expect(insertCapture).toHaveBeenCalledWith(expect.objectContaining({
      user_id: "u1", fdc_id: 5, description: "Egg", meal: "lunch",
      amount_grams: 150, nutrition: NUTR, logged_on: "2026-06-24",
    }));
  });

  it("throws when unauthenticated", async () => {
    verifySession.mockResolvedValue(null);
    const { logFood } = await import("@/lib/dal/logged-foods");
    await expect(logFood({ fdcId: 5, amountGrams: 1, meal: "snack", loggedOn: "2026-06-24" })).rejects.toThrow();
    expect(getFoodDetailCached).not.toHaveBeenCalled();
  });
});

describe("editLog", () => {
  it("updates only the provided fields, scoped by id", async () => {
    verifySession.mockResolvedValue({ userId: "u1" });
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq });
    from.mockReturnValue({ update });
    const { editLog } = await import("@/lib/dal/logged-foods");
    await editLog({ id: "row1", amountGrams: 80 });
    expect(update).toHaveBeenCalledWith({ amount_grams: 80 });
    expect(eq).toHaveBeenCalledWith("id", "row1");
  });
});

describe("softDeleteLog", () => {
  it("sets deleted_at scoped by id", async () => {
    verifySession.mockResolvedValue({ userId: "u1" });
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq });
    from.mockReturnValue({ update });
    const { softDeleteLog } = await import("@/lib/dal/logged-foods");
    await softDeleteLog("row1");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ deleted_at: expect.any(String) }));
    expect(eq).toHaveBeenCalledWith("id", "row1");
  });
});

describe("getDay", () => {
  it("maps rows to a DayData with totals", async () => {
    verifySession.mockResolvedValue({ userId: "u1" });
    const rows = [{
      id: "r1", fdc_id: 5, description: "Egg", meal: "lunch", amount_grams: 100,
      // Full 14-key snapshot — sumTotals iterates every NUTRIENT_KEY and reads v.unit,
      // so a sparse fixture would throw at runtime (production snapshots are always full).
      nutrition: { basis: "100g", nutrients: {
        energyKcal: { amount: 155, unit: "kcal" }, protein: { amount: null, unit: "g" },
        totalFat: { amount: null, unit: "g" }, saturatedFat: { amount: null, unit: "g" },
        carbs: { amount: null, unit: "g" }, fiber: { amount: null, unit: "g" },
        totalSugars: { amount: null, unit: "g" }, addedSugars: { amount: null, unit: "g" },
        sodium: { amount: null, unit: "mg" }, calcium: { amount: null, unit: "mg" },
        iron: { amount: null, unit: "mg" }, potassium: { amount: null, unit: "mg" },
        cholesterol: { amount: null, unit: "mg" }, vitaminD: { amount: null, unit: "µg" },
      } },
      logged_on: "2026-06-24", logged_at: "2026-06-24T12:00:00Z",
    }];
    const is = vi.fn().mockResolvedValue({ data: rows, error: null });
    const eq2 = vi.fn().mockReturnValue({ is });
    const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
    const select = vi.fn().mockReturnValue({ eq: eq1 });
    from.mockReturnValue({ select });
    const { getDay } = await import("@/lib/dal/logged-foods");
    const day = await getDay("2026-06-24");
    expect(day.date).toBe("2026-06-24");
    expect(day.meals.find((m) => m.meal === "lunch")!.entries).toHaveLength(1);
    expect(day.totals.energyKcal.amount).toBe(155);
  });
});
```

- [ ] **Step 2: Run → FAIL** (`pnpm test tests/dal/logged-foods.test.ts`) — module not found.

- [ ] **Step 3: Implement**

Create `lib/dal/logged-foods.ts`:

```ts
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
```

- [ ] **Step 4: Run → PASS** (`pnpm test tests/dal/logged-foods.test.ts`)

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm typecheck` → PASS

```bash
git add lib/dal/logged-foods.ts tests/dal/logged-foods.test.ts
git commit -m "feat(dal): add logged_foods DAL with server-derived nutrition snapshot"
```

---

### Task 6: Server Actions (`app/(app)/today/actions.ts`)

**Files:**
- Create: `app/(app)/today/actions.ts`
- Test: `tests/actions/log.test.ts`

**Interfaces:**
- Consumes: DAL (`logFood`, `editLog`, `softDeleteLog`); schemas (`addFoodSchema`, `editFoodSchema`, `deleteFoodSchema`); `revalidatePath` from `next/cache`.
- Produces: `addFoodAction(input): Promise<ActionResult>`; `editFoodAction(input): Promise<ActionResult>`; `deleteFoodAction(input): Promise<ActionResult>` where `ActionResult = { ok: true } | { error: string }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/actions/log.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const logFood = vi.fn();
const editLog = vi.fn();
const softDeleteLog = vi.fn();
vi.mock("@/lib/dal/logged-foods", () => ({
  logFood: (...a: unknown[]) => logFood(...a),
  editLog: (...a: unknown[]) => editLog(...a),
  softDeleteLog: (...a: unknown[]) => softDeleteLog(...a),
}));
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));

beforeEach(() => { logFood.mockReset(); editLog.mockReset(); softDeleteLog.mockReset(); revalidatePath.mockReset(); });

describe("addFoodAction", () => {
  it("validates, logs, and revalidates", async () => {
    logFood.mockResolvedValue({ id: "r1" });
    const { addFoodAction } = await import("@/app/(app)/today/actions");
    const res = await addFoodAction({ fdcId: 5, amountGrams: 150, meal: "lunch", loggedOn: "2026-06-24" });
    expect(res).toEqual({ ok: true });
    expect(logFood).toHaveBeenCalledWith({ fdcId: 5, amountGrams: 150, meal: "lunch", loggedOn: "2026-06-24" });
    expect(revalidatePath).toHaveBeenCalledWith("/today");
  });
  it("rejects invalid input without calling the DAL", async () => {
    const { addFoodAction } = await import("@/app/(app)/today/actions");
    const res = await addFoodAction({ fdcId: -1, amountGrams: 0, meal: "brunch", loggedOn: "bad" });
    expect("error" in res).toBe(true);
    expect(logFood).not.toHaveBeenCalled();
  });
});

describe("editFoodAction", () => {
  it("validates and edits", async () => {
    editLog.mockResolvedValue(undefined);
    const { editFoodAction } = await import("@/app/(app)/today/actions");
    const id = crypto.randomUUID();
    const res = await editFoodAction({ id, amountGrams: 80 });
    expect(res).toEqual({ ok: true });
    expect(editLog).toHaveBeenCalledWith({ id, amountGrams: 80 });
    expect(revalidatePath).toHaveBeenCalledWith("/today");
  });
});

describe("deleteFoodAction", () => {
  it("validates and soft-deletes", async () => {
    softDeleteLog.mockResolvedValue(undefined);
    const { deleteFoodAction } = await import("@/app/(app)/today/actions");
    const id = crypto.randomUUID();
    const res = await deleteFoodAction({ id });
    expect(res).toEqual({ ok: true });
    expect(softDeleteLog).toHaveBeenCalledWith(id);
    expect(revalidatePath).toHaveBeenCalledWith("/today");
  });
});
```

- [ ] **Step 2: Run → FAIL** (`pnpm test tests/actions/log.test.ts`) — module not found.

- [ ] **Step 3: Implement**

Create `app/(app)/today/actions.ts`:

```ts
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
```

- [ ] **Step 4: Run → PASS** (`pnpm test tests/actions/log.test.ts`)

> Note: a Server Actions file under a route group still typechecks/tests fine; React only treats it specially at runtime when imported by a component.

- [ ] **Step 5: Typecheck + commit**

```bash
git add "app/(app)/today/actions.ts" tests/actions/log.test.ts
git commit -m "feat(actions): add add/edit/delete log Server Actions with Zod boundaries"
```

---

### Task 7: Design system — tokens, font, primitives

**Files:**
- Modify: `app/globals.css` (replace contents)
- Modify: `app/layout.tsx` (add Inter font + dark body)
- Create: `components/ui/Button.tsx`, `components/ui/Input.tsx`, `components/ui/Field.tsx`, `components/ui/Card.tsx`, `components/ui/StatTile.tsx`, `components/ui/Segmented.tsx`, `components/ui/Sheet.tsx`, `components/ui/TabBar.tsx`

**Interfaces:**
- Produces presentational primitives. Key signatures consumed later:
  - `Button(props: ButtonHTMLAttributes & { variant?: "primary"|"ghost"|"danger" })`
  - `Input(props: InputHTMLAttributes)`
  - `Field({ label, children }: { label: string; children: ReactNode })`
  - `Card({ className?, children })`
  - `StatTile({ label, value, tone? }: { label: string; value: string; tone?: "protein"|"carbs"|"fat"|"default" })`
  - `Segmented<T>({ options, value, onChange }: { options: { value: T; label: string; disabled?: boolean }[]; value: T; onChange: (v: T) => void })` (client)
  - `Sheet({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode })` (client)
  - `TabBar()` (client)

- [ ] **Step 1: Replace `app/globals.css`**

```css
@import "tailwindcss";

@theme {
  --color-bg: #0f1411;
  --color-surface: #1a211c;
  --color-surface-2: #141a16;
  --color-border: #232b25;
  --color-text: #e7ece8;
  --color-muted: #8a948c;
  --color-brand: #22c55e;
  --color-accent: #22c55e;
  --color-protein: #4ade80;
  --color-carbs: #fbbf24;
  --color-fat: #60a5fa;
  --color-danger: #f87171;

  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 18px;

  --font-sans: var(--font-inter), ui-sans-serif, system-ui, sans-serif;
}

html, body {
  background-color: var(--color-bg);
  color: var(--color-text);
}
body {
  font-family: var(--font-sans);
  -webkit-font-smoothing: antialiased;
}
```

- [ ] **Step 2: Update `app/layout.tsx` for the font + dark shell**

```tsx
import "./globals.css";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { Inter } from "next/font/google";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata = { title: "Nutri-Shop", description: "Private nutrition tracker" };

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Reading a request-time API keeps this layout dynamic so Next.js injects the
  // CSP nonce (set on the request header in proxy.ts) onto its own scripts.
  await headers();
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
```

> Note (deliberate spec deviation): spec §3/§7 says Inter via `next/font/local`; this plan uses `next/font/google`. `next/font/google` downloads the font at **build time** and self-hosts it under `/_next/static` (served same-origin → satisfies `font-src 'self'` and `style-src 'self'`), so the strict nonce CSP is unaffected — the only difference is a build-time network fetch (fine on Vercel/CI). Chosen because no font files are committed. If an offline/air-gapped build is ever required, switch to `next/font/local` with a committed `Inter-Variable.woff2`.

- [ ] **Step 3: Create the static primitives**

`components/ui/Button.tsx`:

```tsx
import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "ghost" | "danger";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand text-[#08130b] font-semibold",
  ghost: "bg-surface text-text border border-border",
  danger: "bg-transparent text-danger border border-border",
};

export function Button({
  variant = "primary", className = "", ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={`w-full rounded-md px-4 py-3 text-sm transition active:scale-[.99] disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      {...rest}
    />
  );
}
```

`components/ui/Input.tsx`:

```tsx
import type { InputHTMLAttributes } from "react";

export function Input({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full rounded-md bg-surface border border-border px-3 py-2.5 text-sm text-text placeholder:text-muted outline-none focus:border-brand ${className}`}
      {...rest}
    />
  );
}
```

`components/ui/Field.tsx`:

```tsx
import type { ReactNode } from "react";

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] uppercase tracking-wide text-muted">{label}</span>
      {children}
    </label>
  );
}
```

`components/ui/Card.tsx`:

```tsx
import type { ReactNode } from "react";

export function Card({ className = "", children }: { className?: string; children: ReactNode }) {
  return <div className={`rounded-lg bg-surface border border-border ${className}`}>{children}</div>;
}
```

`components/ui/StatTile.tsx`:

```tsx
type Tone = "protein" | "carbs" | "fat" | "default";
const TONES: Record<Tone, string> = {
  protein: "text-protein", carbs: "text-carbs", fat: "text-fat", default: "text-text",
};

export function StatTile({ label, value, tone = "default" }: { label: string; value: string; tone?: Tone }) {
  return (
    <div className="flex-1 rounded-md bg-surface border border-border px-2 py-2 text-center">
      <div className={`text-lg font-bold ${TONES[tone]}`}>{value}</div>
      <div className="text-[9px] uppercase tracking-wide text-muted">{label}</div>
    </div>
  );
}
```

- [ ] **Step 4: Create the client primitives**

`components/ui/Segmented.tsx`:

```tsx
"use client";

export function Segmented<T extends string | number>({
  options, value, onChange,
}: {
  options: { value: T; label: string; disabled?: boolean }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={`rounded-md border px-3 py-1.5 text-xs transition disabled:opacity-40 ${
              on ? "border-brand bg-[#16341f] text-protein" : "border-border bg-surface text-muted"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
```

`components/ui/Sheet.tsx` (bottom sheet; animated via classes only — no inline styles):

```tsx
"use client";

import type { ReactNode } from "react";

export function Sheet({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  return (
    <div className={`fixed inset-0 z-50 ${open ? "" : "pointer-events-none"}`} aria-hidden={!open}>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className={`absolute inset-0 bg-black/50 transition-opacity ${open ? "opacity-100" : "opacity-0"}`}
      />
      <div
        role="dialog"
        aria-modal="true"
        className={`absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-border bg-surface-2 p-4 pb-6 shadow-2xl transition-transform duration-200 ${
          open ? "translate-y-0" : "translate-y-full"
        }`}
      >
        <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-border" />
        {children}
      </div>
    </div>
  );
}
```

`components/ui/TabBar.tsx` (active state via `usePathname`):

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function TabBar() {
  const pathname = usePathname();
  const active = (p: string) => pathname === p || pathname.startsWith(p + "/");
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 flex items-end justify-around border-t border-border bg-surface-2 px-2 pb-2 pt-2">
      <Link href="/today" className={`flex flex-1 flex-col items-center gap-0.5 text-[10px] ${active("/today") ? "text-brand" : "text-muted"}`}>
        <span className="text-lg leading-none">▦</span>Today
      </Link>
      <Link href="/add" aria-label="Add food" className="flex flex-1 flex-col items-center">
        <span className="-mt-5 flex h-12 w-12 items-center justify-center rounded-full bg-brand text-2xl font-light text-[#08130b] shadow-lg">+</span>
      </Link>
      <Link href="/account" className={`flex flex-1 flex-col items-center gap-0.5 text-[10px] ${active("/account") ? "text-brand" : "text-muted"}`}>
        <span className="text-lg leading-none">◔</span>Account
      </Link>
    </nav>
  );
}
```

- [ ] **Step 5: Typecheck + build**

Run: `pnpm typecheck` → PASS
Run: `pnpm build` → PASS (compiles tokens + font + components; nothing imports the primitives yet, so they're tree-shaken — that's fine).

- [ ] **Step 6: Commit**

```bash
git add app/globals.css app/layout.tsx components/ui
git commit -m "feat(ui): add dark-editorial tokens, Inter font, and base primitives"
```

---

### Task 8: App shell, route migration, account page, auth retrofit

**Files:**
- Create: `app/(app)/layout.tsx` (authenticated shell + TabBar)
- Create: `app/(app)/account/page.tsx` (replaces the old dashboard)
- Create: `app/(app)/today/page.tsx` (placeholder — real view in Task 9)
- Create: `app/(app)/add/page.tsx` (placeholder — real view in Task 10)
- Delete: `app/dashboard/page.tsx`
- Modify: `proxy.ts` (redirect `/dashboard` → `/today`, line 47)
- Modify: `app/page.tsx` (root redirect → `/today`)
- Modify: `app/auth/actions.ts` (login redirect → `/today`, line 26)
- Modify: `app/auth/confirm/route.ts` (email-confirm success redirect → `/today`, line 13)
- Modify: `app/login/page.tsx`, `app/signup/page.tsx` (retrofit to primitives)

**Interfaces:**
- Produces: working authenticated routes `/today`, `/add`, `/account` under the `(app)` layout; all auth redirects target `/today`.

- [ ] **Step 1: Create the authenticated shell**

`app/(app)/layout.tsx`:

```tsx
import type { ReactNode } from "react";
import { requireUser } from "@/lib/dal/session";
import { TabBar } from "@/components/ui/TabBar";

export default async function AppLayout({ children }: { children: ReactNode }) {
  await requireUser(); // Gate 2 — server-side, defense in depth beyond proxy.ts
  return (
    <div className="mx-auto min-h-dvh w-full max-w-[480px] pb-24">
      {children}
      <TabBar />
    </div>
  );
}
```

- [ ] **Step 2: Create the account page (migrated from dashboard)**

`app/(app)/account/page.tsx`:

```tsx
import { requireUser } from "@/lib/dal/session";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

export default async function AccountPage() {
  const { userId } = await requireUser();
  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("profiles").select("id, display_name").eq("id", userId).single();

  return (
    <main className="p-4">
      <h1 className="mb-4 text-xl font-semibold">Account</h1>
      <Card className="p-4 text-sm">
        <p className="text-muted">Signed in as</p>
        <p className="break-all">{profile?.display_name ?? userId}</p>
      </Card>
      <form action="/auth/signout" method="post" className="mt-4">
        <Button type="submit" variant="ghost">Sign out</Button>
      </form>
    </main>
  );
}
```

- [ ] **Step 3: Create placeholder today + add pages**

`app/(app)/today/page.tsx`:

```tsx
export default function TodayPage() {
  return <main className="p-4"><h1 className="text-xl font-semibold">Today</h1><p className="mt-2 text-muted">Coming next.</p></main>;
}
```

`app/(app)/add/page.tsx`:

```tsx
export default function AddPage() {
  return <main className="p-4"><h1 className="text-xl font-semibold">Add food</h1><p className="mt-2 text-muted">Coming next.</p></main>;
}
```

- [ ] **Step 4: Delete the old dashboard and flip redirects**

```bash
git rm app/dashboard/page.tsx
```

In `proxy.ts`, line ~47-48, change the authenticated redirect target:

```ts
  if (userId && (pathname === "/login" || pathname === "/signup")) {
    const url = request.nextUrl.clone();
    url.pathname = "/today";
    return NextResponse.redirect(url);
  }
```

In `app/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { verifySession } from "@/lib/dal/session";

export default async function Home() {
  const session = await verifySession();
  redirect(session ? "/today" : "/login");
}
```

In `app/auth/actions.ts`, the `loginAction` redirect (line ~26): change `redirect("/dashboard");` to `redirect("/today");`.

In `app/auth/confirm/route.ts` line 13, change the email-confirmation success redirect from `/dashboard` to `/today` (otherwise a freshly confirmed user lands on the deleted route, and the Step 6 grep would still match):

```ts
if (!error) return NextResponse.redirect(`${origin}/today`);
```

- [ ] **Step 5: Retrofit login + signup to the primitives**

`app/login/page.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import { loginAction, type AuthState } from "@/app/auth/actions";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

const initial: AuthState = {};

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(loginAction, initial);
  return (
    <main className="mx-auto w-full max-w-[360px] px-6 py-[12vh]">
      <h1 className="mb-6 text-2xl font-semibold">Log in</h1>
      <form action={formAction} className="grid gap-3">
        <Input name="email" type="email" placeholder="Email" required autoComplete="email" />
        <Input name="password" type="password" placeholder="Password" required autoComplete="current-password" />
        <Button type="submit" disabled={pending}>{pending ? "…" : "Log in"}</Button>
        {state.error ? <p role="alert" className="text-sm text-danger">{state.error}</p> : null}
      </form>
      <p className="mt-4 text-sm text-muted"><a href="/signup" className="underline">Have an invite? Sign up</a></p>
    </main>
  );
}
```

`app/signup/page.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import { signupAction, type AuthState } from "@/app/auth/actions";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

const initial: AuthState = {};

export default function SignupPage() {
  const [state, formAction, pending] = useActionState(signupAction, initial);
  return (
    <main className="mx-auto w-full max-w-[360px] px-6 py-[12vh]">
      <h1 className="mb-2 text-2xl font-semibold">Sign up</h1>
      <p className="mb-6 text-sm text-muted">Invite-only. Use the email you were invited with.</p>
      <form action={formAction} className="grid gap-3">
        <Input name="email" type="email" placeholder="Email" required autoComplete="email" />
        <Input name="password" type="password" placeholder="Password (10+ chars)" required autoComplete="new-password" />
        <Button type="submit" disabled={pending}>{pending ? "…" : "Create account"}</Button>
        {state.error ? <p role="alert" className="text-sm text-danger">{state.error}</p> : null}
        {state.ok ? <p className="text-sm text-protein">Check your email to confirm your account.</p> : null}
      </form>
    </main>
  );
}
```

- [ ] **Step 6: Typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: PASS. No reference to `/dashboard` remains.

Run: `grep -rn "/dashboard" app proxy.ts` → Expected: no matches.

- [ ] **Step 7: Manual verification**

Run: `pnpm dev`. Verify: unauthenticated → `/login`; after login → `/today`; the bottom tab bar shows Today / + / Account; `/account` shows the profile + Sign out; Sign out returns to `/login`. (If you lack a local Supabase, defer this to Task 12's deploy check.)

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(app): add authenticated shell, account page, and migrate /dashboard to /today"
```

---

### Task 9: Today day view (read-only render)

**Files:**
- Modify: `app/(app)/today/page.tsx` (real view)
- Create: `app/(app)/today/TodayView.tsx` (client wrapper, no edit yet)
- Create: `app/(app)/today/DateNav.tsx` (client; prev/next + date input)
- Create: `app/(app)/today/NutritionPanel.tsx` (server; collapsible full nutrition)
- Create: `app/(app)/today/_redirect.tsx` (client; normalize missing `?date=` to local today)

**Interfaces:**
- Consumes: `getDay` (DAL), `dateParamSchema`, `formatDayLabel`, `addDays`, `DayData`, `NUTRIENT` display metadata.
- Produces: a rendered day view. `TodayView({ data }: { data: DayData })`.

- [ ] **Step 1: Create the missing-date redirector**

`app/(app)/today/_redirect.tsx`:

```tsx
"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { todayLocal } from "@/lib/date";

export function NormalizeDate() {
  const router = useRouter();
  useEffect(() => {
    router.replace(`/today?date=${todayLocal()}`);
  }, [router]);
  return <main className="p-4 text-muted">Loading today…</main>;
}
```

- [ ] **Step 2: Create the date nav**

`app/(app)/today/DateNav.tsx`:

```tsx
"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { addDays, todayLocal, formatDayLabel } from "@/lib/date";

export function DateNav({ date }: { date: string }) {
  const router = useRouter();
  // Anchor "Today/Yesterday" on the CLIENT's local today, set after mount to avoid an
  // SSR/client hydration mismatch when server tz and client tz straddle a date boundary.
  const [today, setToday] = useState<string | null>(null);
  useEffect(() => setToday(todayLocal()), []);
  const go = (d: string) => router.push(`/today?date=${d}`);
  const label = today ? formatDayLabel(date, today) : date; // raw date until mounted, then friendly label

  return (
    <div className="px-4 pt-3">
      <div className="flex items-center justify-center gap-4">
        <button type="button" aria-label="Previous day" onClick={() => go(addDays(date, -1))} className="text-xl text-muted">‹</button>
        <span className="min-w-[140px] text-center text-lg font-semibold">{label}</span>
        <button type="button" aria-label="Next day" onClick={() => go(addDays(date, 1))} className="text-xl text-muted">›</button>
      </div>
      <div className="mt-1 flex justify-center">
        <input
          type="date"
          value={date}
          onChange={(e) => { if (e.target.value) go(e.target.value); }}
          className="bg-transparent text-center text-xs text-muted outline-none"
          aria-label="Jump to date"
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create the full-nutrition panel (native collapsible — CSP-safe, no JS)**

`app/(app)/today/NutritionPanel.tsx`:

```tsx
import type { DayTotals, NutrientKey } from "@/lib/nutrition/types";

const ROWS: { key: NutrientKey; label: string }[] = [
  { key: "saturatedFat", label: "Saturated fat" },
  { key: "fiber", label: "Fiber" },
  { key: "totalSugars", label: "Total sugars" },
  { key: "addedSugars", label: "Added sugars" },
  { key: "sodium", label: "Sodium" },
  { key: "calcium", label: "Calcium" },
  { key: "iron", label: "Iron" },
  { key: "potassium", label: "Potassium" },
  { key: "cholesterol", label: "Cholesterol" },
  { key: "vitaminD", label: "Vitamin D" },
];

export function NutritionPanel({ totals }: { totals: DayTotals }) {
  const anyIncomplete = ROWS.some((r) => totals[r.key].incomplete);
  return (
    <details className="mx-4 mt-3 rounded-md border border-border bg-surface px-4 py-2">
      <summary className="cursor-pointer list-none text-xs text-muted">Full nutrition</summary>
      <div className="mt-2">
        {ROWS.map((r) => {
          const t = totals[r.key];
          return (
            <div key={r.key} className="flex justify-between border-t border-border/50 py-1.5 text-sm">
              <span className="text-muted">{r.label}</span>
              <span>{Math.round(t.amount)} {t.unit}{t.incomplete ? "*" : ""}</span>
            </div>
          );
        })}
        {anyIncomplete ? <p className="mt-2 text-[11px] text-muted">* some foods didn’t report this nutrient</p> : null}
      </div>
    </details>
  );
}
```

- [ ] **Step 4: Create the day view client wrapper (render only)**

`app/(app)/today/TodayView.tsx`:

```tsx
"use client";

import type { DayData } from "@/lib/nutrition/types";
import { MEALS } from "@/lib/nutrition/types";
import { StatTile } from "@/components/ui/StatTile";
import { entryKcal } from "@/lib/nutrition/compute";

const MEAL_LABEL: Record<string, string> = {
  breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snack",
};

export function TodayView({ data }: { data: DayData }) {
  const kcal = data.totals.energyKcal;
  return (
    <div>
      <div className="px-4 py-3 text-center">
        <div className="text-3xl font-bold">{Math.round(kcal.amount)}</div>
        <div className="text-[11px] text-muted">kcal eaten{kcal.incomplete ? " (some unreported)" : ""}</div>
      </div>
      <div className="flex gap-2 px-4">
        <StatTile label="Protein" value={`${Math.round(data.totals.protein.amount)}g`} tone="protein" />
        <StatTile label="Carbs" value={`${Math.round(data.totals.carbs.amount)}g`} tone="carbs" />
        <StatTile label="Fat" value={`${Math.round(data.totals.totalFat.amount)}g`} tone="fat" />
      </div>

      <div className="mt-4 space-y-3 px-4">
        {MEALS.map((meal) => {
          const group = data.meals.find((m) => m.meal === meal)!;
          return (
            <section key={meal} className="rounded-lg border border-border bg-surface px-3 py-2">
              <div className="mb-1 flex justify-between text-[11px] uppercase tracking-wide text-muted">
                <span>{MEAL_LABEL[meal]}</span>
                <span>{Math.round(group.subtotalKcal)} kcal</span>
              </div>
              {group.entries.length === 0 ? (
                <p className="py-1 text-xs text-muted">No entries.</p>
              ) : (
                group.entries.map((e) => (
                  <div key={e.id} className="flex justify-between border-t border-border/50 py-1.5 text-sm">
                    <span>{e.description} <span className="text-muted">{Math.round(e.amountGrams)}g</span></span>
                    <span>{entryKcal(e) ?? "—"}</span>
                  </div>
                ))
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Wire the page**

`app/(app)/today/page.tsx`:

```tsx
import { getDay } from "@/lib/dal/logged-foods";
import { dateParamSchema } from "@/lib/validation/log";
import { NormalizeDate } from "./_redirect";
import { DateNav } from "./DateNav";
import { TodayView } from "./TodayView";
import { NutritionPanel } from "./NutritionPanel";

export default async function TodayPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const { date } = await searchParams;
  const parsed = date ? dateParamSchema.safeParse(date) : null;
  if (!parsed?.success) return <NormalizeDate />; // no/invalid date → set local today client-side

  const day = await getDay(parsed.data);
  return (
    <main>
      <DateNav date={parsed.data} />
      <TodayView data={day} />
      <NutritionPanel totals={day.totals} />
    </main>
  );
}
```

> `DateNav` (client) renders the friendly day label itself — `formatDayLabel(date, todayLocal())` — so the page passes only the date string and imports no `formatDayLabel`. The page stays a clean server component: validate the date → fetch the day → render. The day heading lives in `DateNav`; there is no separate `<h1>`.

- [ ] **Step 6: Typecheck + build**

Run: `pnpm typecheck && pnpm build` → PASS.

- [ ] **Step 7: Manual verification (seed a row)**

In the Supabase dashboard SQL editor (cloud project), insert a row for your own user id:

```sql
insert into public.logged_foods (user_id, fdc_id, description, meal, amount_grams, nutrition, logged_on)
values (
  '<YOUR-AUTH-USER-UUID>', 1008, 'Test oatmeal', 'breakfast', 80,
  '{"basis":"100g","nutrients":{"energyKcal":{"amount":389,"unit":"kcal"},"protein":{"amount":16,"unit":"g"},"carbs":{"amount":66,"unit":"g"},"totalFat":{"amount":7,"unit":"g"},"saturatedFat":{"amount":1,"unit":"g"},"fiber":{"amount":10,"unit":"g"},"totalSugars":{"amount":1,"unit":"g"},"addedSugars":{"amount":null,"unit":"g"},"sodium":{"amount":2,"unit":"mg"},"calcium":{"amount":54,"unit":"mg"},"iron":{"amount":4,"unit":"mg"},"potassium":{"amount":362,"unit":"mg"},"cholesterol":{"amount":0,"unit":"mg"},"vitaminD":{"amount":null,"unit":"µg"}}}'::jsonb,
  '2026-06-24'   -- use the LOCAL date /today redirected you to; current_date is UTC and may differ from your local day
);
```

Run `pnpm dev`, open `/today`. Expected: it redirects to `/today?date=<localtoday>`, shows ~311 kcal headline, protein/carbs/fat tiles, the entry under Breakfast, and "Full nutrition" expands to show micros with `*` on added sugars / vitamin D. Date prev/next changes the day (other days empty). Delete the seed row afterward.

- [ ] **Step 8: Commit**

```bash
git add "app/(app)/today"
git commit -m "feat(today): render day view with totals, meals, and full-nutrition panel"
```

---

### Task 10: Add flow — search + quick-add sheet

**Files:**
- Modify: `app/(app)/add/page.tsx` (mount the client view)
- Create: `app/(app)/add/AddView.tsx` (client; search + results)
- Create: `app/(app)/add/QuickAddSheet.tsx` (client; amount/serving + meal + Add, also used in edit mode in Task 11)
- Create: `lib/nutrition/display.ts` (small shared display helpers) + `tests/nutrition/display.test.ts`

**Interfaces:**
- Consumes: `/api/foods` (search), `/api/foods/[fdcId]` (detail → `NormalizedFood`), `addFoodAction`, `scaleNutrients`, `servingsToGrams`, `todayLocal`.
- Produces: `QuickAddSheet({ open, onClose, food, initialMeal, initialGrams, loggedOn, mode, onSubmit })`; display helper `formatGrams(n): string`.

- [ ] **Step 1: Write a failing test for the display helper**

Create `tests/nutrition/display.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatGrams } from "@/lib/nutrition/display";

describe("formatGrams", () => {
  it("trims trailing zeros", () => {
    expect(formatGrams(150)).toBe("150");
    expect(formatGrams(150.5)).toBe("150.5");
    expect(formatGrams(150.0)).toBe("150");
  });
});
```

- [ ] **Step 2: Run → FAIL**, then implement `lib/nutrition/display.ts`:

```ts
export function formatGrams(n: number): string {
  return String(Math.round(n * 10) / 10);
}
```

Run: `pnpm test tests/nutrition/display.test.ts` → PASS.

- [ ] **Step 3: Create the quick-add sheet**

`app/(app)/add/QuickAddSheet.tsx`:

```tsx
"use client";

import { useState } from "react";
import type { NormalizedFood } from "@/lib/fdc/cache";
import type { Meal } from "@/lib/nutrition/types";
import { MEALS } from "@/lib/nutrition/types";
import { scaleNutrients, servingsToGrams } from "@/lib/nutrition/compute";
import { formatGrams } from "@/lib/nutrition/display";
import { Sheet } from "@/components/ui/Sheet";
import { Segmented } from "@/components/ui/Segmented";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

const MEAL_OPTS = MEALS.map((m) => ({ value: m, label: m[0]!.toUpperCase() + m.slice(1) }));

export function QuickAddSheet({
  open, onClose, food, initialMeal, initialGrams, mode = "add", onSubmit, onDelete,
}: {
  open: boolean;
  onClose: () => void;
  food: NormalizedFood | null;
  initialMeal: Meal;
  initialGrams: number;
  mode?: "add" | "edit";
  onSubmit: (args: { amountGrams: number; meal: Meal }) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [meal, setMeal] = useState<Meal>(initialMeal);
  const [unit, setUnit] = useState<"g" | "serving">("g");
  const [value, setValue] = useState<string>(String(initialGrams));
  const [pending, setPending] = useState(false);

  const serving = food?.nutrition.serving;
  const grams = unit === "g"
    ? Number(value) || 0
    : servingsToGrams(Number(value) || 0, serving) ?? 0;

  const scaled = food ? scaleNutrients(food.nutrition, grams) : null;
  const kcal = scaled?.energyKcal.amount;

  async function submit() {
    if (grams <= 0) return;
    setPending(true);
    try { await onSubmit({ amountGrams: grams, meal }); onClose(); }
    finally { setPending(false); }
  }

  return (
    <Sheet open={open} onClose={onClose}>
      {food ? (
        <div className="grid gap-3">
          <div>
            <div className="font-medium">{food.description}</div>
            <div className="text-xs text-muted">{kcal == null ? "—" : Math.round(kcal)} kcal · for {formatGrams(grams)} g</div>
          </div>

          <div className="flex gap-2">
            <div className="flex-1 rounded-md bg-surface border border-border px-2 py-2 text-center">
              <div className="text-base font-bold text-protein">{scaled ? fmt(scaled.protein.amount) : "—"}g</div>
              <div className="text-[9px] uppercase tracking-wide text-muted">Protein</div>
            </div>
            <div className="flex-1 rounded-md bg-surface border border-border px-2 py-2 text-center">
              <div className="text-base font-bold text-carbs">{scaled ? fmt(scaled.carbs.amount) : "—"}g</div>
              <div className="text-[9px] uppercase tracking-wide text-muted">Carbs</div>
            </div>
            <div className="flex-1 rounded-md bg-surface border border-border px-2 py-2 text-center">
              <div className="text-base font-bold text-fat">{scaled ? fmt(scaled.totalFat.amount) : "—"}g</div>
              <div className="text-[9px] uppercase tracking-wide text-muted">Fat</div>
            </div>
          </div>

          <Field label="Amount">
            <div className="flex gap-2">
              <Input
                type="number" inputMode="decimal" min="0" value={value}
                onChange={(e) => setValue(e.target.value)} className="flex-1"
              />
              <Segmented
                options={[
                  { value: "g", label: "g" },
                  { value: "serving", label: serving ? `serving (${formatGrams(serving.amount)}g)` : "serving", disabled: !serving },
                ]}
                value={unit}
                onChange={(u) => setUnit(u)}
              />
            </div>
          </Field>

          <Field label="Meal">
            <Segmented options={MEAL_OPTS} value={meal} onChange={(m) => setMeal(m)} />
          </Field>

          <Button onClick={submit} disabled={pending || grams <= 0}>
            {pending ? "…" : mode === "edit" ? "Save" : `Add to ${meal}`}
          </Button>
          {mode === "edit" && onDelete ? (
            <Button variant="danger" onClick={async () => { setPending(true); try { await onDelete(); onClose(); } finally { setPending(false); } }}>
              Delete entry
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="py-6 text-center text-muted">Loading…</p>
      )}
    </Sheet>
  );
}

function fmt(n: number | null): string {
  return n == null ? "0" : String(Math.round(n));
}
```

- [ ] **Step 4: Create the search view**

`app/(app)/add/AddView.tsx`:

```tsx
"use client";

import { useState } from "react";
import type { NormalizedFood } from "@/lib/fdc/cache";
import type { Meal } from "@/lib/nutrition/types";
import { todayLocal } from "@/lib/date";
import { addFoodAction } from "@/app/(app)/today/actions";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { QuickAddSheet } from "./QuickAddSheet";

type Result = { fdcId: number; description: string; dataType: string | null; brandOwner: string | null };
type Source = "All" | "Branded" | "Generic";
const DATATYPES: Record<Source, string> = { All: "", Branded: "Branded", Generic: "Foundation,SR Legacy" };

export function AddView({ date, presetMeal }: { date: string; presetMeal: Meal }) {
  const [q, setQ] = useState("");
  const [source, setSource] = useState<Source>("All");
  const [results, setResults] = useState<Result[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<NormalizedFood | null>(null);
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const loggedOn = date || todayLocal();

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!q.trim()) return;
    setSearching(true);
    try {
      const params = new URLSearchParams({ q: q.trim() });
      if (DATATYPES[source]) params.set("dataType", DATATYPES[source]);
      const res = await fetch(`/api/foods?${params}`, { credentials: "same-origin" });
      const json = await res.json();
      setResults(res.ok ? json.results : []);
    } finally { setSearching(false); }
  }

  async function pick(fdcId: number) {
    setSelected(null);
    setOpen(true);
    const res = await fetch(`/api/foods/${fdcId}`, { credentials: "same-origin" });
    if (res.ok) setSelected(await res.json());
    else { setOpen(false); setToast("Could not load that food."); }
  }

  async function submit({ amountGrams, meal }: { amountGrams: number; meal: Meal }) {
    if (!selected) return;
    const r = await addFoodAction({ fdcId: selected.fdcId, amountGrams, meal, loggedOn });
    setToast("error" in r ? r.error : "Added.");
  }

  return (
    <main className="p-4">
      <h1 className="mb-3 text-lg font-semibold">Add food</h1>
      <form onSubmit={runSearch} className="mb-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search foods…" aria-label="Search foods" />
      </form>
      <div className="mb-3">
        <Segmented
          options={(["All", "Branded", "Generic"] as Source[]).map((s) => ({ value: s, label: s }))}
          value={source} onChange={(s) => setSource(s)}
        />
      </div>

      {searching ? <p className="text-sm text-muted">Searching…</p> : null}
      <ul className="divide-y divide-border">
        {results.map((r) => (
          <li key={r.fdcId}>
            <button type="button" onClick={() => pick(r.fdcId)} className="w-full py-3 text-left">
              <div className="text-sm">{r.description}</div>
              <div className="text-[11px] text-muted">{r.brandOwner ? `${r.brandOwner} · ` : ""}{r.dataType ?? ""}</div>
            </button>
          </li>
        ))}
      </ul>

      <QuickAddSheet
        open={open}
        onClose={() => setOpen(false)}
        food={selected}
        initialMeal={presetMeal}
        initialGrams={selected?.nutrition.serving?.amount ?? 100}
        mode="add"
        onSubmit={submit}
      />

      {toast ? <p role="status" className="fixed inset-x-0 bottom-24 mx-auto w-fit rounded-md bg-surface px-4 py-2 text-sm text-text shadow-lg">{toast}</p> : null}
    </main>
  );
}
```

- [ ] **Step 5: Wire the add page (reads `?date=` and `?meal=`)**

`app/(app)/add/page.tsx`:

```tsx
import type { Meal } from "@/lib/nutrition/types";
import { MEALS } from "@/lib/nutrition/types";
import { AddView } from "./AddView";

export default async function AddPage({ searchParams }: { searchParams: Promise<{ date?: string; meal?: string }> }) {
  const sp = await searchParams;
  const date = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : "";
  const presetMeal: Meal = MEALS.includes(sp.meal as Meal) ? (sp.meal as Meal) : "lunch";
  return <AddView date={date} presetMeal={presetMeal} />;
}
```

> The empty `date=""` is resolved to local today inside `AddView` via `todayLocal()`. The default meal is `lunch` when no `?meal=`; for a time-of-day default instead, the sheet could call `defaultMealForHour` — kept server-stable here to avoid hydration mismatch.

- [ ] **Step 6: Typecheck + build**

Run: `pnpm typecheck && pnpm build` → PASS.

- [ ] **Step 7: Manual e2e**

`pnpm dev` → `/add`. Search "egg" → results appear (description + source). Tap one → sheet opens, fetches detail, shows live macros; change grams → macros update; toggle serving (if available); pick a meal; **Add** → toast "Added.". Go to `/today` → the entry appears under the chosen meal with correct calories. Search response shows no per-row calories (by design — slim Phase-1 search payload).

- [ ] **Step 8: Commit**

```bash
git add "app/(app)/add" lib/nutrition/display.ts tests/nutrition/display.test.ts
git commit -m "feat(add): food search and quick-add sheet with live macro preview"
```

---

### Task 11: Edit + delete from the day view

**Files:**
- Modify: `app/(app)/today/TodayView.tsx` (entry rows open the sheet in edit mode; meal "add" links)
- Reuse: `app/(app)/add/QuickAddSheet.tsx`, `editFoodAction`, `deleteFoodAction`

**Interfaces:**
- Consumes: `editFoodAction`, `deleteFoodAction`, `QuickAddSheet` (edit mode), `LoggedEntry`.

- [ ] **Step 1: Make entries editable in `TodayView`**

Replace `app/(app)/today/TodayView.tsx` with the interactive version:

```tsx
"use client";

import { useState } from "react";
import type { DayData, LoggedEntry, Meal } from "@/lib/nutrition/types";
import { MEALS } from "@/lib/nutrition/types";
import { StatTile } from "@/components/ui/StatTile";
import { entryKcal } from "@/lib/nutrition/compute";
import { QuickAddSheet } from "@/app/(app)/add/QuickAddSheet";
import { editFoodAction, deleteFoodAction } from "@/app/(app)/today/actions";
import type { NormalizedFood } from "@/lib/fdc/cache";

const MEAL_LABEL: Record<Meal, string> = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snack" };

export function TodayView({ data }: { data: DayData }) {
  const [editing, setEditing] = useState<LoggedEntry | null>(null);
  const kcal = data.totals.energyKcal;

  // The logged entry already carries its per-100g snapshot → build a NormalizedFood for the sheet (no fetch).
  const editFood: NormalizedFood | null = editing
    ? { fdcId: editing.fdcId, description: editing.description, dataType: null, nutrition: editing.nutrition }
    : null;

  return (
    <div>
      <div className="px-4 py-3 text-center">
        <div className="text-3xl font-bold">{Math.round(kcal.amount)}</div>
        <div className="text-[11px] text-muted">kcal eaten{kcal.incomplete ? " (some unreported)" : ""}</div>
      </div>
      <div className="flex gap-2 px-4">
        <StatTile label="Protein" value={`${Math.round(data.totals.protein.amount)}g`} tone="protein" />
        <StatTile label="Carbs" value={`${Math.round(data.totals.carbs.amount)}g`} tone="carbs" />
        <StatTile label="Fat" value={`${Math.round(data.totals.totalFat.amount)}g`} tone="fat" />
      </div>

      <div className="mt-4 space-y-3 px-4">
        {MEALS.map((meal) => {
          const group = data.meals.find((m) => m.meal === meal)!;
          return (
            <section key={meal} className="rounded-lg border border-border bg-surface px-3 py-2">
              <div className="mb-1 flex items-center justify-between text-[11px] uppercase tracking-wide text-muted">
                <span>{MEAL_LABEL[meal]}</span>
                <span>{Math.round(group.subtotalKcal)} kcal</span>
              </div>
              {group.entries.map((e) => (
                <button key={e.id} type="button" onClick={() => setEditing(e)} className="flex w-full justify-between border-t border-border/50 py-1.5 text-left text-sm">
                  <span>{e.description} <span className="text-muted">{Math.round(e.amountGrams)}g</span></span>
                  <span>{entryKcal(e) ?? "—"}</span>
                </button>
              ))}
              <a href={`/add?date=${data.date}&meal=${meal}`} className="mt-1 block py-1 text-xs text-brand">+ Add food</a>
            </section>
          );
        })}
      </div>

      <QuickAddSheet
        open={editing !== null}
        onClose={() => setEditing(null)}
        food={editFood}
        initialMeal={editing?.meal ?? "lunch"}
        initialGrams={editing?.amountGrams ?? 100}
        mode="edit"
        onSubmit={async ({ amountGrams, meal }) => {
          if (editing) await editFoodAction({ id: editing.id, amountGrams, meal });
        }}
        onDelete={async () => {
          if (editing) await deleteFoodAction({ id: editing.id });
        }}
      />
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + build**

Run: `pnpm typecheck && pnpm build` → PASS.

- [ ] **Step 3: Manual e2e**

`pnpm dev` → `/today`. Tap an entry → sheet opens in edit mode pre-filled (macros recompute from its snapshot); change grams → **Save** → totals update. Tap entry → **Delete entry** → it disappears and totals drop. Each meal's "+ Add food" opens `/add` pre-set to that day and meal.

- [ ] **Step 4: Commit**

```bash
git add "app/(app)/today/TodayView.tsx"
git commit -m "feat(today): edit and soft-delete entries via the quick-add sheet"
```

---

### Task 12: Docs, cloud migration, full green, PR

**Files:**
- Modify (if present): repo `README.md`, repo `CLAUDE.md`, `.env.example`
- Verify: `.github/workflows/rls.yml` picks up the new RLS test (it runs `tests/rls/*` after `supabase db reset`)

- [ ] **Step 1: Apply migration 0003 to the cloud project + sync migration history**

In the Supabase dashboard **SQL Editor** (the multi-statement surface; the pooled "Query" tab rejects multi-statement), paste and run the full contents of `supabase/migrations/0003_logged_foods.sql`. Verify `select * from public.logged_foods limit 1;` runs (empty) and that the 4 policies exist.

**Then record 0003 as already-applied in the remote migration history**, or `db-migrate.yml`'s `supabase db push` on merge to `main` will try to re-run 0003 and fail on the existing table (the same hazard that required a repair for 0001/0002):

```bash
supabase link --project-ref kblczigiebeeiqqhpjsl
supabase migration repair --status applied 0003
```

(Alternative: skip the hand-apply and let `db-migrate.yml` apply 0003 on merge — but then the cloud table won't exist for the Task 9–11 manual checks, which run against the cloud project. Hand-apply + repair keeps dev working and the merge clean.)

- [ ] **Step 2: Confirm the RLS workflow covers the new test**

Open `.github/workflows/rls.yml`. Confirm it runs `supabase db reset` (applies all migrations incl. 0003) then the RLS suite (`tests/rls/`). No edit needed if it globs `tests/rls/*.test.ts`; if it lists files explicitly, add `tests/rls/logged-foods.test.ts`.

- [ ] **Step 3: Update docs (only what changed)**

If a repo `README.md` documents routes/features, add the tracker (`/today`, `/add`, `/account`; `/dashboard` removed). No new env vars were introduced — confirm `.env.example` is unchanged. If a repo `CLAUDE.md` lists the route map or phases, note Phase 2 complete and the `/dashboard`→`/today` rename. Keep all wording free of AI/tool attribution.

- [ ] **Step 4: Full green**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
Expected: all PASS. (`tests/rls/*` self-skip locally.)

- [ ] **Step 5: Commit any doc changes**

```bash
git add -A
git commit -m "docs: record Phase 2 tracker routes and /today migration"
```

- [ ] **Step 6: Push + open PR**

```bash
git push -u origin phase-2-macro-tracker
gh pr create --base main --head phase-2-macro-tracker \
  --title "Phase 2: macro/micro tracker" \
  --body "Adds the food search UI, logged_foods table (owner-only RLS), log/edit/delete Server Actions, per-day meal-grouped totals, a bottom-tab nav shell, and the dark-editorial design system. Nutrition is snapshotted per log row for historical correctness. See docs/superpowers/specs/2026-06-24-nutri-shop-macro-tracker-design.md and the plan in docs/superpowers/plans/."
```

- [ ] **Step 7: Watch CI**

Run: `gh pr checks --watch`
Expected: CI, CodeQL, RLS Integration Tests all green. The RLS workflow runs `logged-foods.test.ts` against a real local stack (insert own ✓; cross-user denied; soft-delete hidden). Fix any failure at root cause before merge.

---

## Self-Review

**1. Spec coverage:**
- §2 quantity grams+servings → Task 10 (`servingsToGrams`, g/serving toggle). ✓
- §2 meals → Task 1 (enum) + compute `groupByMeal` (Task 2) + UI (Tasks 9/11). ✓
- §2 date picker / parameterized day → Task 9 (`DateNav`, `?date=`, local-today redirect). ✓
- §2 headline macros + collapsible micros, all 14 summed → Task 9 (`TodayView` + `NutritionPanel`, `sumTotals`). ✓
- §2 snapshot nutrition → Task 1 (column) + Task 5 (`logFood` derives from cache). ✓
- §2 dark-editorial + nav + quick-add sheet → Tasks 7/8/10/11. ✓
- §4 data model → Task 1 (exact SQL). ✓
- §5 nutrition math → Tasks 2/3. ✓
- §6 DAL + actions + integrity/trust → Tasks 5/6. ✓
- §7 design system + screens → Tasks 7–11. ✓
- §9 security & RLS test → Tasks 1/5/6/12. ✓
- §10 testing (compute, DAL, actions, RLS) → Tasks 2–6, 12. (Spec's "component render tests" intentionally replaced by pure-helper coverage — no RTL/jsdom in the repo; noted in Global Constraints.) ✓
- §11 risks (snapshot, forged nutrition, tz, ml→g, CSP, route rename, scope, grants) → addressed across Tasks 1/5/7/8 + constraints. ✓
- §12 success criteria → all reachable by Task 12. ✓

**2. Placeholder scan:** No "TBD/TODO". The Task 1 test contains an intentional sentinel (`toBeGreaterTplaceholderHANZERO`) with an explicit fix step — verify it's corrected to `toBeGreaterThan(0)`. No other placeholders.

**4. Verification pass (post-write):** An adversarial 6-dimension review (zod/TS, Next/React, Supabase/SQL, Phase-1 contract, CSP/security, coherence) ran against the real codebase. zod/TS and CSP/security came back clean. Folded-in fixes: Task 5 `getDay` fixture now carries a full 14-key snapshot (a sparse one threw at runtime in `sumTotals`); Task 8 now also redirects `app/auth/confirm/route.ts` `/dashboard`→`/today`; Task 9 `DateNav` owns the day label (no ambiguous `formatDayLabel` dance on the page); Task 12 adds `supabase migration repair --status applied 0003` so the merge `db push` doesn't double-apply; minor unused-import and seed-date-tz cleanups; next/font/google deviation from the spec documented.

**3. Type consistency:** `NormalizedFood` (from `@/lib/fdc/cache`) reused for the sheet's `food` prop in both add (fetched) and edit (built from snapshot). `Meal`/`MEALS` from `@/lib/nutrition/types` used everywhere. `ActionResult` shape (`{ok:true}|{error}`) consistent across actions and `AddView`. `DayData`/`DayTotals`/`LoggedEntry` consistent between compute (Task 2), DAL (Task 5), and UI (Tasks 9/11). `scaleNutrients`/`servingsToGrams`/`entryKcal` signatures match call sites. Action arg objects (`{fdcId, amountGrams, meal, loggedOn}`) match `addFoodSchema`.
