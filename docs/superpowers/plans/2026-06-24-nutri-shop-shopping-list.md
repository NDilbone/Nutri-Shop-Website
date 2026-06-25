# Shopping List (online) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-user online shopping list — add/check/edit/clear items (free-text or USDA-linked), grouped by aisle — behind owner-only RLS, on a new `/list` tab.

**Architecture:** Two new tables (`shopping_lists`, `shopping_list_items`) with owner-only RLS; item access derives through `list_id → owner_id` (the seam that makes household-sharing a non-breaking later change). A `server-only` DAL (`verifySession` first, RLS-scoped Supabase client) backs thin Zod-validated Server Actions. The UI reuses the Phase-2 dark-editorial primitives, adds a `Checkbox` + `Select`, and renders a grouped list whose ordering lives in a pure, unit-tested helper. The schema carries client-mintable UUIDs + `updated_at` + `deleted_at` so the Phase-5 offline/sync layer needs no migration.

**Tech Stack:** Next.js 16 (App Router, Server Actions), React 19, Supabase (Postgres + RLS, `@supabase/ssr`), Zod 4, TypeScript 6, Tailwind 4, Vitest 4, pnpm.

## Global Constraints

- **Pinned versions (do not bump in this phase):** `next@16.2.9`, `react@19.2.7`, `react-dom@19.2.7`, `@supabase/supabase-js@2.108.2`, `@supabase/ssr@0.12.0`, `zod@4.4.3`, `typescript@6.0.3`, `vitest@4.1.9`, `pnpm@11.9.0`, Node `>=24`.
- **No new dependencies.** `Checkbox` and `Select` are hand-rolled primitives; there is no React DOM test harness (Vitest runs `environment: "node"`, no testing-library) and this phase does not add one.
- **Identity:** every commit is authored by the repo-local git identity **NDilbone** (already configured). Never write the string "RegEdits", and never add any AI/Claude/"Generated with" attribution to commits, code, or docs.
- **Security:** owner-only RLS on both tables; the service-role key never appears in a request path — the DAL uses the RLS-scoped anon client (`lib/supabase/server.ts`). `import "server-only"` on the DAL; `verifySession()` runs before any data access and throws `Unauthenticated` when absent.
- **RLS for items derives from the list** (`EXISTS (select 1 from shopping_lists l where l.id = list_id and l.owner_id = auth.uid() and l.deleted_at is null)`) — there is no `user_id` column on items.
- **Explicit grants** on both tables (a fresh local CI stack lacks Supabase's implicit default privileges — the 0001 lesson). RLS still gates rows.
- **Lint is part of "done":** UI/React tasks run `pnpm lint` in addition to `pnpm typecheck` and `pnpm build`. Turbopack build does NOT run ESLint — the React-19 set-state-in-effect rule only surfaces via `pnpm lint` (Phase-2 lesson). Avoid `useEffect` for state derivation; use the render-time reset pattern.
- **Conventional commit messages**, no attribution trailers.
- **Migration is multi-statement**; on the cloud project it applies via `db-migrate.yml` on merge (or the dashboard SQL Editor, not the pooled "Query" surface).

---

## File structure

**Create:**
- `supabase/migrations/0004_shopping_list.sql` — tables, RLS, grants, triggers.
- `lib/shopping/types.ts` — `CATEGORIES`, `Category`, `CATEGORY_LABEL`, `ShoppingListItem`, `ItemGroup`, `GroupedList`.
- `lib/shopping/group.ts` — pure `groupItems()`.
- `lib/validation/shopping-list.ts` — Zod schemas + input types.
- `lib/dal/shopping-list.ts` — `server-only` data access.
- `app/(app)/list/actions.ts` — Server Actions.
- `app/(app)/list/page.tsx` — server page → `ListView`.
- `app/(app)/list/ListView.tsx` — client list (inline add, groups, toggle, clear, edit sheet).
- `app/(app)/list/ItemSheet.tsx` — client add/edit sheet (reused by the ＋ chooser).
- `components/ui/Checkbox.tsx`, `components/ui/Select.tsx` — primitives.
- Tests: `tests/validation/shopping-list.test.ts`, `tests/shopping/group.test.ts`, `tests/dal/shopping-list.test.ts`, `tests/actions/shopping-list.test.ts`, `tests/rls/shopping-list.test.ts`.

**Modify:**
- `components/ui/Input.tsx` — forward a `ref` (React-19 ref-as-prop) so the inline-add row can keep focus (Task 6 Step 0).
- `components/ui/TabBar.tsx` — add `/list` tab; ＋ becomes a chooser (Log food / Add to list).
- `app/(app)/add/QuickAddSheet.tsx` — optional "Add to shopping list" button (add-mode only).
- `app/(app)/add/AddView.tsx` — pass the `onAddToList` handler (sets `fdc_id`).
- `README.md` — note the shopping list feature.

**Testing note (read before Task 7):** `ListView` is a thin client wrapper. Its *ordering* logic lives in `groupItems` (unit-tested, Task 3); its *mutations* run through the actions + DAL (unit-tested, Tasks 4–5). The repo has no React DOM test runner (node env, no testing-library) and this phase does not add one. `ListView`'s rendered behavior (groups render, checked section, Clear-checked visibility, inline-add focus retention) is verified by the manual e2e smoke in the success criteria, consistent with how Phase 2's views were validated. Adding React Testing Library is a deferred infra decision, not part of this phase.

---

## Task 1: Migration — tables, RLS, grants, triggers

**Files:**
- Create: `supabase/migrations/0004_shopping_list.sql`
- Test: `tests/rls/shopping-list.test.ts`

**Interfaces:**
- Produces (DB): tables `public.shopping_lists(id, owner_id, name, is_default, created_at, updated_at, deleted_at)` and `public.shopping_list_items(id, list_id, name, quantity, category, fdc_id, checked, created_at, updated_at, deleted_at)`; owner-only RLS on both; reuses `public.set_updated_at()` from 0003.

- [ ] **Step 1: Write the failing RLS test**

Create `tests/rls/shopping-list.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { HAS_SUPABASE_TEST_ENV, makeUser } from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

if (process.env.REQUIRE_SUPABASE_TESTS === "1" && !HAS_SUPABASE_TEST_ENV) {
  throw new Error("REQUIRE_SUPABASE_TESTS=1 but SUPABASE_TEST_* env is missing");
}

let userA: SupabaseClient;
let userB: SupabaseClient;
let userAId: string;
let listAId: string;

describe.skipIf(!HAS_SUPABASE_TEST_ENV)("shopping_list RLS isolation", () => {
  beforeAll(async () => {
    userA = await makeUser("shopper-a@example.com", "ShopperA-pw-123!");
    userB = await makeUser("shopper-b@example.com", "ShopperB-pw-123!");
    userAId = (await userA.auth.getUser()).data.user!.id;
    const { data, error } = await userA
      .from("shopping_lists")
      .insert({ owner_id: userAId, is_default: true })
      .select("id")
      .single();
    if (error) throw error;
    listAId = data!.id;
  });

  it("a user can add an item to their own list", async () => {
    const { error } = await userA.from("shopping_list_items").insert({ list_id: listAId, name: "Milk" });
    expect(error).toBeNull();
  });

  it("a user CANNOT read another user's list", async () => {
    const { data, error } = await userB.from("shopping_lists").select("id").eq("id", listAId);
    expect(error).toBeNull(); // RLS returns zero rows, not an error
    expect(data).toHaveLength(0);
  });

  it("a user CANNOT read another user's items", async () => {
    const { data, error } = await userB.from("shopping_list_items").select("id").eq("list_id", listAId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("a user CANNOT insert an item into another user's list", async () => {
    const { error } = await userB.from("shopping_list_items").insert({ list_id: listAId, name: "spoof" });
    expect(error).not.toBeNull(); // with-check EXISTS(owner) rejects it
  });

  it("a user CANNOT update another user's item", async () => {
    const ins = await userA.from("shopping_list_items").insert({ list_id: listAId, name: "Eggs" }).select("id").single();
    await userB.from("shopping_list_items").update({ name: "hacked" }).eq("id", ins.data!.id);
    const { data } = await userA.from("shopping_list_items").select("name").eq("id", ins.data!.id).single();
    expect(data!.name).not.toBe("hacked");
  });

  it("a user CANNOT delete another user's item", async () => {
    const ins = await userA.from("shopping_list_items").insert({ list_id: listAId, name: "Bread" }).select("id").single();
    await userB.from("shopping_list_items").delete().eq("id", ins.data!.id); // RLS USING denies → 0 rows affected
    const { data } = await userA.from("shopping_list_items").select("id").eq("id", ins.data!.id).single();
    expect(data).not.toBeNull(); // still there, read back as the owner
  });

  it("a user CANNOT delete another user's list", async () => {
    await userB.from("shopping_lists").delete().eq("id", listAId);
    const { data } = await userA.from("shopping_lists").select("id").eq("id", listAId).single();
    expect(data).not.toBeNull();
  });

  it("soft-deleted items are excluded when filtering deleted_at is null", async () => {
    const ins = await userA.from("shopping_list_items").insert({ list_id: listAId, name: "ToClear", checked: true }).select("id").single();
    await userA.from("shopping_list_items").update({ deleted_at: new Date().toISOString() }).eq("id", ins.data!.id);
    const { data } = await userA.from("shopping_list_items").select("id").eq("id", ins.data!.id).is("deleted_at", null);
    expect(data ?? []).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it — expect SKIP (no local stack)**

Run: `pnpm exec vitest run tests/rls/shopping-list.test.ts`
Expected: the suite is **skipped** (`describe.skipIf(!HAS_SUPABASE_TEST_ENV)`) — 0 failures. (It runs for real in the `RLS Integration Tests` workflow against a live stack.)

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0004_shopping_list.sql`:

```sql
-- Phase 3: per-user shopping list. Owner-only RLS. Item ownership derives through
-- the list (no user_id on items) so a future household share is a policy broaden,
-- not a rewrite. UUID PK + updated_at + deleted_at keep it offline/sync-ready (Phase 5).

create table public.shopping_lists (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users (id) on delete cascade,
  name       text not null default 'Shopping list' check (char_length(name) between 1 and 100),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Exactly one live default list per owner; the DAL's get-or-create relies on this
-- to stay idempotent under a concurrent double-insert.
create unique index shopping_lists_one_default
  on public.shopping_lists (owner_id) where is_default and deleted_at is null;

create table public.shopping_list_items (
  id         uuid primary key default gen_random_uuid(),   -- a client may also mint (offline, Phase 5)
  list_id    uuid not null references public.shopping_lists (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 200),
  quantity   text check (quantity is null or char_length(quantity) <= 50),
  category   text check (category in
               ('produce','meat','dairy','bakery','frozen','pantry','beverages','household','other')),
  fdc_id     bigint,                                        -- set only for USDA-linked items
  checked    boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz                                    -- soft delete; "Clear checked" sets this
);

create index shopping_list_items_list
  on public.shopping_list_items (list_id) where deleted_at is null;

alter table public.shopping_lists      enable row level security;
alter table public.shopping_list_items enable row level security;

-- shopping_lists: owner-only.
create policy "shopping_lists_select_own" on public.shopping_lists
  for select using ( (select auth.uid()) = owner_id );
create policy "shopping_lists_insert_own" on public.shopping_lists
  for insert with check ( (select auth.uid()) = owner_id );
create policy "shopping_lists_update_own" on public.shopping_lists
  for update using ( (select auth.uid()) = owner_id )
             with check ( (select auth.uid()) = owner_id );
create policy "shopping_lists_delete_own" on public.shopping_lists
  for delete using ( (select auth.uid()) = owner_id );

-- shopping_list_items: you may touch an item iff you own its live list.
-- This EXISTS predicate is the forward-compat seam (later: "owner OR member").
create policy "shopping_list_items_select_own" on public.shopping_list_items
  for select using ( exists (
    select 1 from public.shopping_lists l
    where l.id = list_id and l.owner_id = (select auth.uid()) and l.deleted_at is null ) );
create policy "shopping_list_items_insert_own" on public.shopping_list_items
  for insert with check ( exists (
    select 1 from public.shopping_lists l
    where l.id = list_id and l.owner_id = (select auth.uid()) and l.deleted_at is null ) );
create policy "shopping_list_items_update_own" on public.shopping_list_items
  for update using ( exists (
    select 1 from public.shopping_lists l
    where l.id = list_id and l.owner_id = (select auth.uid()) and l.deleted_at is null ) )
             with check ( exists (
    select 1 from public.shopping_lists l
    where l.id = list_id and l.owner_id = (select auth.uid()) and l.deleted_at is null ) );
create policy "shopping_list_items_delete_own" on public.shopping_list_items
  for delete using ( exists (
    select 1 from public.shopping_lists l
    where l.id = list_id and l.owner_id = (select auth.uid()) and l.deleted_at is null ) );

-- Explicit grants: a fresh local CI stack lacks Supabase's implicit defaults (0001 lesson).
grant all on public.shopping_lists      to service_role;
grant all on public.shopping_list_items to service_role;
grant select, insert, update, delete on public.shopping_lists      to authenticated;
grant select, insert, update, delete on public.shopping_list_items to authenticated;

-- Bump updated_at on UPDATE (last-write-wins sync, Phase 5). Reuses set_updated_at() from 0003.
create trigger shopping_lists_set_updated_at
  before update on public.shopping_lists
  for each row execute function public.set_updated_at();
create trigger shopping_list_items_set_updated_at
  before update on public.shopping_list_items
  for each row execute function public.set_updated_at();
```

- [ ] **Step 4: Verify the migration applies + RLS passes against a local stack (optional locally; required in CI)**

If Supabase CLI + Docker are available locally:
Run: `supabase db reset --no-seed` then export creds and `REQUIRE_SUPABASE_TESTS=1 pnpm exec vitest run tests/rls/shopping-list.test.ts --no-file-parallelism`
Expected: 8 passing tests.
Otherwise rely on the `RLS Integration Tests` workflow (it already globs `tests/rls/**` and `supabase/migrations/**`) — no workflow edit needed.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0004_shopping_list.sql "tests/rls/shopping-list.test.ts"
git commit -m "feat(db): shopping_lists + shopping_list_items tables with owner-only RLS"
```

---

## Task 2: Domain types + validation schemas

**Files:**
- Create: `lib/shopping/types.ts`
- Create: `lib/validation/shopping-list.ts`
- Test: `tests/validation/shopping-list.test.ts`

**Interfaces:**
- Produces: `CATEGORIES` (readonly tuple), `type Category`, `CATEGORY_LABEL`, `type ShoppingListItem`, `type ItemGroup`, `type GroupedList`; Zod `addItemSchema`/`editItemSchema`/`toggleItemSchema`/`deleteItemSchema` and `type AddItemInput`/`EditItemInput`/`ToggleItemInput`.

- [ ] **Step 1: Write the domain types**

Create `lib/shopping/types.ts`:

```ts
export const CATEGORIES = [
  "produce", "meat", "dairy", "bakery", "frozen", "pantry", "beverages", "household", "other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABEL: Record<Category, string> = {
  produce: "Produce",
  meat: "Meat & Seafood",
  dairy: "Dairy & Eggs",
  bakery: "Bakery",
  frozen: "Frozen",
  pantry: "Pantry",
  beverages: "Beverages",
  household: "Household",
  other: "Other",
};

export type ShoppingListItem = {
  id: string;
  name: string;
  quantity: string | null;
  category: Category | null;
  fdcId: number | null;
  checked: boolean;
  createdAt: string;
};

export type ItemGroup = { category: Category; items: ShoppingListItem[] };

/** Unchecked items grouped by aisle (non-empty groups, aisle order) + all checked items flat. */
export type GroupedList = { groups: ItemGroup[]; checked: ShoppingListItem[] };
```

- [ ] **Step 2: Write the failing validation test**

Create `tests/validation/shopping-list.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { addItemSchema, editItemSchema, toggleItemSchema, deleteItemSchema } from "@/lib/validation/shopping-list";

describe("addItemSchema", () => {
  it("accepts a minimal free-text item", () => {
    expect(addItemSchema.safeParse({ name: "Milk" }).success).toBe(true);
  });
  it("accepts a fully-specified USDA-linked item", () => {
    const r = addItemSchema.safeParse({ name: "Chicken breast", quantity: "2 lbs", category: "meat", fdcId: 171077 });
    expect(r.success).toBe(true);
  });
  it("rejects an empty or oversized name", () => {
    expect(addItemSchema.safeParse({ name: "" }).success).toBe(false);
    expect(addItemSchema.safeParse({ name: "x".repeat(201) }).success).toBe(false);
  });
  it("rejects an unknown category and a non-positive fdcId", () => {
    expect(addItemSchema.safeParse({ name: "Milk", category: "snacks" }).success).toBe(false);
    expect(addItemSchema.safeParse({ name: "Milk", fdcId: 0 }).success).toBe(false);
  });
});

describe("editItemSchema", () => {
  it("requires a uuid id and allows partial / nullable fields", () => {
    expect(editItemSchema.safeParse({ id: crypto.randomUUID(), name: "Eggs" }).success).toBe(true);
    expect(editItemSchema.safeParse({ id: crypto.randomUUID(), quantity: null, category: null }).success).toBe(true);
    expect(editItemSchema.safeParse({ name: "Eggs" }).success).toBe(false);
  });
});

describe("toggleItemSchema", () => {
  it("requires a uuid id and a boolean", () => {
    expect(toggleItemSchema.safeParse({ id: crypto.randomUUID(), checked: true }).success).toBe(true);
    expect(toggleItemSchema.safeParse({ id: crypto.randomUUID(), checked: "yes" }).success).toBe(false);
  });
});

describe("deleteItemSchema", () => {
  it("requires a uuid id", () => {
    expect(deleteItemSchema.safeParse({ id: crypto.randomUUID() }).success).toBe(true);
    expect(deleteItemSchema.safeParse({ id: "nope" }).success).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm exec vitest run tests/validation/shopping-list.test.ts`
Expected: FAIL — cannot resolve `@/lib/validation/shopping-list`.

- [ ] **Step 4: Write the schemas**

Create `lib/validation/shopping-list.ts`:

```ts
import { z } from "zod";
import { CATEGORIES } from "@/lib/shopping/types";

const name = z.string().trim().min(1).max(200);
const quantity = z.string().trim().max(50);
const category = z.enum(CATEGORIES);

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
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm exec vitest run tests/validation/shopping-list.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add lib/shopping/types.ts lib/validation/shopping-list.ts tests/validation/shopping-list.test.ts
git commit -m "feat(shopping): domain types and input validation schemas"
```

---

## Task 3: Grouping helper (pure)

**Files:**
- Create: `lib/shopping/group.ts`
- Test: `tests/shopping/group.test.ts`

**Interfaces:**
- Consumes: `ShoppingListItem`, `Category`, `ItemGroup`, `GroupedList`, `CATEGORIES` from `lib/shopping/types`.
- Produces: `groupItems(items: ShoppingListItem[]): GroupedList`.

**Behavior:** unchecked items grouped by category in aisle order (`CATEGORIES` order; `null` category → `other`; empty groups omitted), each group sub-sorted by `createdAt` ascending; all checked items collected into a single flat `checked` array, also `createdAt` ascending. (This matches the approved UI: aisle groups of unchecked items, then one struck-through "checked" section at the bottom.)

- [ ] **Step 1: Write the failing test**

Create `tests/shopping/group.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { groupItems } from "@/lib/shopping/group";
import type { ShoppingListItem } from "@/lib/shopping/types";

function item(p: Partial<ShoppingListItem> & { id: string }): ShoppingListItem {
  return { name: p.id, quantity: null, category: null, fdcId: null, checked: false, createdAt: "2026-06-24T00:00:00Z", ...p };
}

describe("groupItems", () => {
  it("orders groups by aisle, not insertion order", () => {
    const { groups } = groupItems([
      item({ id: "a", category: "pantry" }),
      item({ id: "b", category: "produce" }),
      item({ id: "c", category: "dairy" }),
    ]);
    expect(groups.map((g) => g.category)).toEqual(["produce", "dairy", "pantry"]);
  });

  it("puts null-category items in the 'other' bucket", () => {
    const { groups } = groupItems([item({ id: "a", category: null })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.category).toBe("other");
  });

  it("omits empty groups", () => {
    const { groups } = groupItems([item({ id: "a", category: "meat" })]);
    expect(groups.map((g) => g.category)).toEqual(["meat"]);
  });

  it("collects checked items into a flat section, out of the groups", () => {
    const { groups, checked } = groupItems([
      item({ id: "a", category: "produce", checked: false }),
      item({ id: "b", category: "produce", checked: true }),
    ]);
    expect(groups.map((g) => g.category)).toEqual(["produce"]);
    expect(groups[0]!.items.map((i) => i.id)).toEqual(["a"]);
    expect(checked.map((i) => i.id)).toEqual(["b"]);
  });

  it("sub-sorts each group and the checked section by createdAt ascending", () => {
    const { groups, checked } = groupItems([
      item({ id: "late", category: "dairy", createdAt: "2026-06-24T10:00:00Z" }),
      item({ id: "early", category: "dairy", createdAt: "2026-06-24T08:00:00Z" }),
      item({ id: "c-late", checked: true, createdAt: "2026-06-24T11:00:00Z" }),
      item({ id: "c-early", checked: true, createdAt: "2026-06-24T09:00:00Z" }),
    ]);
    expect(groups[0]!.items.map((i) => i.id)).toEqual(["early", "late"]);
    expect(checked.map((i) => i.id)).toEqual(["c-early", "c-late"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run tests/shopping/group.test.ts`
Expected: FAIL — cannot resolve `@/lib/shopping/group`.

- [ ] **Step 3: Write the helper**

Create `lib/shopping/group.ts`:

```ts
import type { Category, GroupedList, ItemGroup, ShoppingListItem } from "@/lib/shopping/types";
import { CATEGORIES } from "@/lib/shopping/types";

const byCreatedAt = (a: ShoppingListItem, b: ShoppingListItem) => a.createdAt.localeCompare(b.createdAt);

export function groupItems(items: ShoppingListItem[]): GroupedList {
  const checked = items.filter((i) => i.checked).sort(byCreatedAt);

  const unchecked = new Map<Category, ShoppingListItem[]>();
  for (const i of items) {
    if (i.checked) continue;
    const cat: Category = i.category ?? "other";
    const arr = unchecked.get(cat) ?? [];
    arr.push(i);
    unchecked.set(cat, arr);
  }

  const groups: ItemGroup[] = [];
  for (const category of CATEGORIES) {
    const arr = unchecked.get(category);
    if (!arr || arr.length === 0) continue;
    arr.sort(byCreatedAt);
    groups.push({ category, items: arr });
  }

  return { groups, checked };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run tests/shopping/group.test.ts`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Commit**

```bash
git add lib/shopping/group.ts tests/shopping/group.test.ts
git commit -m "feat(shopping): pure aisle-grouping helper"
```

---

## Task 4: Data access layer (DAL)

**Files:**
- Create: `lib/dal/shopping-list.ts`
- Test: `tests/dal/shopping-list.test.ts`

**Interfaces:**
- Consumes: `verifySession` (`lib/dal/session`), `createClient` (`lib/supabase/server`), `AddItemInput`/`EditItemInput` (`lib/validation/shopping-list`), `ShoppingListItem` (`lib/shopping/types`).
- Produces: `getOrCreateDefaultList(): Promise<{ id: string }>`, `getItems(): Promise<ShoppingListItem[]>`, `addItem(input: AddItemInput): Promise<{ id: string }>`, `toggleItem(id: string, checked: boolean): Promise<void>`, `editItem(input: EditItemInput): Promise<void>`, `softDeleteItem(id: string): Promise<void>`, `clearChecked(): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `tests/dal/shopping-list.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const verifySession = vi.fn();
vi.mock("@/lib/dal/session", () => ({ verifySession: (...a: unknown[]) => verifySession(...a) }));

const from = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn().mockResolvedValue({ from }) }));

beforeEach(() => { verifySession.mockReset(); from.mockReset(); verifySession.mockResolvedValue({ userId: "u1" }); });

// select("id").eq("owner_id").eq("is_default").is("deleted_at").maybeSingle()
function listSelect(result: { data: unknown; error: unknown }) {
  return { select: () => ({ eq: () => ({ eq: () => ({ is: () => ({ maybeSingle: () => Promise.resolve(result) }) }) }) }) };
}
// insert({...}).select("id").single()
function insertSingle(result: { data: unknown; error: unknown }, capture?: (row: unknown) => void) {
  return { insert: (row: unknown) => { capture?.(row); return { select: () => ({ single: () => Promise.resolve(result) }) }; } };
}

describe("getOrCreateDefaultList", () => {
  it("returns the existing default list without inserting", async () => {
    from.mockReturnValueOnce(listSelect({ data: { id: "L1" }, error: null }));
    const { getOrCreateDefaultList } = await import("@/lib/dal/shopping-list");
    expect(await getOrCreateDefaultList()).toEqual({ id: "L1" });
    expect(from).toHaveBeenCalledTimes(1);
  });

  it("creates a default list when none exists", async () => {
    from.mockReturnValueOnce(listSelect({ data: null, error: null }));
    const captured: unknown[] = [];
    from.mockReturnValueOnce(insertSingle({ data: { id: "L2" }, error: null }, (r) => captured.push(r)));
    const { getOrCreateDefaultList } = await import("@/lib/dal/shopping-list");
    expect(await getOrCreateDefaultList()).toEqual({ id: "L2" });
    expect(captured[0]).toEqual({ owner_id: "u1", is_default: true });
  });

  it("throws when unauthenticated", async () => {
    verifySession.mockResolvedValue(null);
    const { getOrCreateDefaultList } = await import("@/lib/dal/shopping-list");
    await expect(getOrCreateDefaultList()).rejects.toThrow(/Unauthenticated/);
  });
});

describe("addItem", () => {
  it("resolves the default list then inserts the item with nulls for omitted fields", async () => {
    from.mockReturnValueOnce(listSelect({ data: { id: "L1" }, error: null }));
    let row: Record<string, unknown> = {};
    from.mockReturnValueOnce(insertSingle({ data: { id: "i1" }, error: null }, (r) => { row = r as Record<string, unknown>; }));
    const { addItem } = await import("@/lib/dal/shopping-list");
    const res = await addItem({ name: "Milk" });
    expect(res).toEqual({ id: "i1" });
    expect(row).toEqual({ list_id: "L1", name: "Milk", quantity: null, category: null, fdc_id: null });
  });

  it("passes through quantity/category/fdcId when provided", async () => {
    from.mockReturnValueOnce(listSelect({ data: { id: "L1" }, error: null }));
    let row: Record<string, unknown> = {};
    from.mockReturnValueOnce(insertSingle({ data: { id: "i2" }, error: null }, (r) => { row = r as Record<string, unknown>; }));
    const { addItem } = await import("@/lib/dal/shopping-list");
    await addItem({ name: "Chicken", quantity: "2 lbs", category: "meat", fdcId: 171077 });
    expect(row).toEqual({ list_id: "L1", name: "Chicken", quantity: "2 lbs", category: "meat", fdc_id: 171077 });
  });
});

describe("toggleItem", () => {
  it("updates checked scoped by id", async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq });
    from.mockReturnValue({ update });
    const { toggleItem } = await import("@/lib/dal/shopping-list");
    await toggleItem("i1", true);
    expect(update).toHaveBeenCalledWith({ checked: true });
    expect(eq).toHaveBeenCalledWith("id", "i1");
  });
});

describe("editItem", () => {
  it("updates only the provided fields", async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq });
    from.mockReturnValue({ update });
    const { editItem } = await import("@/lib/dal/shopping-list");
    await editItem({ id: "i1", name: "Eggs", category: null });
    expect(update).toHaveBeenCalledWith({ name: "Eggs", category: null });
    expect(eq).toHaveBeenCalledWith("id", "i1");
  });

  it("does not call supabase when the patch is empty", async () => {
    const { editItem } = await import("@/lib/dal/shopping-list");
    await editItem({ id: "00000000-0000-0000-0000-000000000000" });
    expect(from).not.toHaveBeenCalled();
  });
});

describe("softDeleteItem", () => {
  it("sets deleted_at scoped by id", async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq });
    from.mockReturnValue({ update });
    const { softDeleteItem } = await import("@/lib/dal/shopping-list");
    await softDeleteItem("i1");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ deleted_at: expect.any(String) }));
    expect(eq).toHaveBeenCalledWith("id", "i1");
  });
});

describe("clearChecked", () => {
  it("soft-deletes checked rows scoped to the default list", async () => {
    from.mockReturnValueOnce(listSelect({ data: { id: "L1" }, error: null }));
    const is = vi.fn().mockResolvedValue({ error: null });
    const eqChecked = vi.fn().mockReturnValue({ is });
    const eqList = vi.fn().mockReturnValue({ eq: eqChecked });
    const update = vi.fn().mockReturnValue({ eq: eqList });
    from.mockReturnValueOnce({ update });
    const { clearChecked } = await import("@/lib/dal/shopping-list");
    await clearChecked();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ deleted_at: expect.any(String) }));
    expect(eqList).toHaveBeenCalledWith("list_id", "L1");
    expect(eqChecked).toHaveBeenCalledWith("checked", true);
  });
});

describe("getItems", () => {
  it("maps DB rows to ShoppingListItem for the default list", async () => {
    from.mockReturnValueOnce(listSelect({ data: { id: "L1" }, error: null }));
    const rows = [{ id: "i1", name: "Milk", quantity: "1 gal", category: "dairy", fdc_id: null, checked: false, created_at: "2026-06-24T00:00:00Z" }];
    const is = vi.fn().mockResolvedValue({ data: rows, error: null });
    const eq = vi.fn().mockReturnValue({ is });
    const select = vi.fn().mockReturnValue({ eq });
    from.mockReturnValueOnce({ select });
    const { getItems } = await import("@/lib/dal/shopping-list");
    const items = await getItems();
    expect(items).toEqual([{ id: "i1", name: "Milk", quantity: "1 gal", category: "dairy", fdcId: null, checked: false, createdAt: "2026-06-24T00:00:00Z" }]);
    expect(eq).toHaveBeenCalledWith("list_id", "L1");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run tests/dal/shopping-list.test.ts`
Expected: FAIL — cannot resolve `@/lib/dal/shopping-list`.

- [ ] **Step 3: Write the DAL**

Create `lib/dal/shopping-list.ts`:

```ts
import "server-only";
import { verifySession } from "@/lib/dal/session";
import { createClient } from "@/lib/supabase/server";
import type { ShoppingListItem } from "@/lib/shopping/types";
import type { AddItemInput, EditItemInput } from "@/lib/validation/shopping-list";

async function authedClient() {
  const session = await verifySession();
  if (!session) throw new Error("Unauthenticated");
  const supabase = await createClient();
  return { session, supabase };
}

/** The owner's single default list, created on first use. Idempotent under the
 *  shopping_lists_one_default partial unique index. */
export async function getOrCreateDefaultList(): Promise<{ id: string }> {
  const { session, supabase } = await authedClient();
  const { data: existing, error: selErr } = await supabase
    .from("shopping_lists")
    .select("id")
    .eq("owner_id", session.userId)
    .eq("is_default", true)
    .is("deleted_at", null)
    .maybeSingle();
  if (selErr) throw new Error(`getDefaultList select failed: ${selErr.message}`);
  if (existing) return { id: existing.id as string };

  const { data: created, error: insErr } = await supabase
    .from("shopping_lists")
    .insert({ owner_id: session.userId, is_default: true })
    .select("id")
    .single();
  if (insErr || !created) {
    // Lost a concurrent create race → the unique index rejected us; re-select.
    const { data: again } = await supabase
      .from("shopping_lists")
      .select("id")
      .eq("owner_id", session.userId)
      .eq("is_default", true)
      .is("deleted_at", null)
      .maybeSingle();
    if (!again) throw new Error(`createDefaultList failed: ${insErr?.message ?? "no row returned"}`);
    return { id: again.id as string };
  }
  return { id: created.id as string };
}

type Row = {
  id: string; name: string; quantity: string | null; category: string | null;
  fdc_id: number | null; checked: boolean; created_at: string;
};

/** The default list's non-deleted items, flat. Grouping is applied client-side. */
export async function getItems(): Promise<ShoppingListItem[]> {
  const { id: listId } = await getOrCreateDefaultList();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("shopping_list_items")
    .select("id, name, quantity, category, fdc_id, checked, created_at")
    .eq("list_id", listId)
    .is("deleted_at", null);
  if (error) throw new Error(`getItems failed: ${error.message}`);
  return (data as Row[]).map((r) => ({
    id: r.id, name: r.name, quantity: r.quantity,
    category: r.category as ShoppingListItem["category"],
    fdcId: r.fdc_id, checked: r.checked, createdAt: r.created_at,
  }));
}

export async function addItem(input: AddItemInput): Promise<{ id: string }> {
  const { id: listId } = await getOrCreateDefaultList();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("shopping_list_items")
    .insert({
      list_id: listId,
      name: input.name,
      quantity: input.quantity ?? null,
      category: input.category ?? null,
      fdc_id: input.fdcId ?? null,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`addItem failed: ${error?.message ?? "no row returned"}`);
  return { id: data.id as string };
}

export async function toggleItem(id: string, checked: boolean): Promise<void> {
  const { supabase } = await authedClient();
  const { error } = await supabase.from("shopping_list_items").update({ checked }).eq("id", id);
  if (error) throw new Error(`toggleItem failed: ${error.message}`);
}

export async function editItem(input: EditItemInput): Promise<void> {
  const patch: { name?: string; quantity?: string | null; category?: string | null } = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.quantity !== undefined) patch.quantity = input.quantity;
  if (input.category !== undefined) patch.category = input.category;
  if (Object.keys(patch).length === 0) return;
  const { supabase } = await authedClient();
  const { error } = await supabase.from("shopping_list_items").update(patch).eq("id", input.id);
  if (error) throw new Error(`editItem failed: ${error.message}`);
}

export async function softDeleteItem(id: string): Promise<void> {
  const { supabase } = await authedClient();
  const { error } = await supabase
    .from("shopping_list_items")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`softDeleteItem failed: ${error.message}`);
}

export async function clearChecked(): Promise<void> {
  const { id: listId } = await getOrCreateDefaultList();
  const supabase = await createClient();
  const { error } = await supabase
    .from("shopping_list_items")
    .update({ deleted_at: new Date().toISOString() })
    .eq("list_id", listId)
    .eq("checked", true)
    .is("deleted_at", null);
  if (error) throw new Error(`clearChecked failed: ${error.message}`);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run tests/dal/shopping-list.test.ts`
Expected: PASS (all describes).

- [ ] **Step 5: Commit**

```bash
git add lib/dal/shopping-list.ts tests/dal/shopping-list.test.ts
git commit -m "feat(shopping): data access layer with lazy default-list provisioning"
```

---

## Task 5: Server Actions

**Files:**
- Create: `app/(app)/list/actions.ts`
- Test: `tests/actions/shopping-list.test.ts`

**Interfaces:**
- Consumes: DAL fns from `lib/dal/shopping-list`; schemas from `lib/validation/shopping-list`; `revalidatePath` from `next/cache`.
- Produces: `type ActionResult = { ok: true } | { error: string }`; `addItemAction`, `editItemAction`, `toggleItemAction`, `deleteItemAction`, `clearCheckedAction` — each `(input?: unknown) => Promise<ActionResult>`.

- [ ] **Step 1: Write the failing test**

Create `tests/actions/shopping-list.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const addItem = vi.fn();
const editItem = vi.fn();
const toggleItem = vi.fn();
const softDeleteItem = vi.fn();
const clearChecked = vi.fn();
vi.mock("@/lib/dal/shopping-list", () => ({
  addItem: (...a: unknown[]) => addItem(...a),
  editItem: (...a: unknown[]) => editItem(...a),
  toggleItem: (...a: unknown[]) => toggleItem(...a),
  softDeleteItem: (...a: unknown[]) => softDeleteItem(...a),
  clearChecked: (...a: unknown[]) => clearChecked(...a),
}));
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));

beforeEach(() => { [addItem, editItem, toggleItem, softDeleteItem, clearChecked, revalidatePath].forEach((m) => m.mockReset()); });

describe("addItemAction", () => {
  it("validates, adds, and revalidates", async () => {
    addItem.mockResolvedValue({ id: "i1" });
    const { addItemAction } = await import("@/app/(app)/list/actions");
    const res = await addItemAction({ name: "Milk", category: "dairy" });
    expect(res).toEqual({ ok: true });
    expect(addItem).toHaveBeenCalledWith({ name: "Milk", category: "dairy" });
    expect(revalidatePath).toHaveBeenCalledWith("/list");
  });
  it("rejects invalid input without calling the DAL", async () => {
    const { addItemAction } = await import("@/app/(app)/list/actions");
    const res = await addItemAction({ name: "", category: "snacks" });
    expect("error" in res).toBe(true);
    expect(addItem).not.toHaveBeenCalled();
  });
});

describe("toggleItemAction", () => {
  it("validates and toggles", async () => {
    toggleItem.mockResolvedValue(undefined);
    const { toggleItemAction } = await import("@/app/(app)/list/actions");
    const id = crypto.randomUUID();
    const res = await toggleItemAction({ id, checked: true });
    expect(res).toEqual({ ok: true });
    expect(toggleItem).toHaveBeenCalledWith(id, true);
    expect(revalidatePath).toHaveBeenCalledWith("/list");
  });
});

describe("editItemAction", () => {
  it("validates and edits", async () => {
    editItem.mockResolvedValue(undefined);
    const { editItemAction } = await import("@/app/(app)/list/actions");
    const id = crypto.randomUUID();
    const res = await editItemAction({ id, name: "Eggs" });
    expect(res).toEqual({ ok: true });
    expect(editItem).toHaveBeenCalledWith({ id, name: "Eggs" });
  });
});

describe("deleteItemAction", () => {
  it("validates and soft-deletes", async () => {
    softDeleteItem.mockResolvedValue(undefined);
    const { deleteItemAction } = await import("@/app/(app)/list/actions");
    const id = crypto.randomUUID();
    const res = await deleteItemAction({ id });
    expect(res).toEqual({ ok: true });
    expect(softDeleteItem).toHaveBeenCalledWith(id);
  });
});

describe("clearCheckedAction", () => {
  it("clears checked and revalidates", async () => {
    clearChecked.mockResolvedValue(undefined);
    const { clearCheckedAction } = await import("@/app/(app)/list/actions");
    const res = await clearCheckedAction();
    expect(res).toEqual({ ok: true });
    expect(clearChecked).toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith("/list");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run tests/actions/shopping-list.test.ts`
Expected: FAIL — cannot resolve `@/app/(app)/list/actions`.

- [ ] **Step 3: Write the actions**

Create `app/(app)/list/actions.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { addItem, editItem, toggleItem, softDeleteItem, clearChecked } from "@/lib/dal/shopping-list";
import { addItemSchema, editItemSchema, toggleItemSchema, deleteItemSchema } from "@/lib/validation/shopping-list";

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
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run tests/actions/shopping-list.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/list/actions.ts" "tests/actions/shopping-list.test.ts"
git commit -m "feat(shopping): server actions for list mutations"
```

---

## Task 6: Primitives + add/edit sheet

**Files:**
- Create: `components/ui/Checkbox.tsx`
- Create: `components/ui/Select.tsx`
- Modify: `components/ui/Input.tsx` (forward a ref — Task 7's inline-add needs it)
- Create: `app/(app)/list/ItemSheet.tsx`

**Interfaces:**
- Produces: `Checkbox({ checked, onChange, label })`; `Select(props: SelectHTMLAttributes)`; `Input` gains an optional `ref?: Ref<HTMLInputElement>`; `ItemSheet({ open, onClose, mode, item?, onSubmit, onDelete? })` and `type ItemDraft = { name: string; quantity: string; category: Category | "" }`.
- Consumes: `Sheet`, `Field`, `Input`, `Button`; `CATEGORIES`, `CATEGORY_LABEL`, `Category`, `ShoppingListItem` from `lib/shopping/types`.

**No unit test** (presentational; the repo's primitives are untested by convention and there is no DOM test runner). Verified by `pnpm typecheck && pnpm lint && pnpm build` at the final step.

- [ ] **Step 0: Make `Input` forward a ref**

The existing `components/ui/Input.tsx` types its props as `InputHTMLAttributes<HTMLInputElement>`, which does **not** include `ref`, and never applies a ref to the `<input>`. Task 7 passes `<Input ref={inputRef} />` for focus retention — without this change `pnpm typecheck` fails with `TS2322: Property 'ref' does not exist…` and the ref would be null at runtime. Replace `components/ui/Input.tsx` with:

```tsx
import type { InputHTMLAttributes, Ref } from "react";

export function Input({ className = "", ref, ...rest }: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return (
    <input
      ref={ref}
      className={`w-full rounded-md bg-surface border border-border px-3 py-2.5 text-sm text-text placeholder:text-muted outline-none focus:border-brand ${className}`}
      {...rest}
    />
  );
}
```

(React 19 supports `ref` as an ordinary prop on a function component when its props type declares it. This is backward-compatible with every existing `<Input>` call site — `ref` is optional.)

- [ ] **Step 1: Write `Checkbox`**

Create `components/ui/Checkbox.tsx`:

```tsx
"use client";

export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border transition ${
        checked ? "border-brand bg-brand text-[#08130b]" : "border-border bg-surface"
      }`}
    >
      {checked ? <span className="text-xs leading-none">✓</span> : null}
    </button>
  );
}
```

- [ ] **Step 2: Write `Select`**

Create `components/ui/Select.tsx`:

```tsx
import type { SelectHTMLAttributes } from "react";

export function Select({ className = "", children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`w-full rounded-md bg-surface border border-border px-3 py-2.5 text-sm text-text outline-none focus:border-brand ${className}`}
      {...rest}
    >
      {children}
    </select>
  );
}
```

- [ ] **Step 3: Write `ItemSheet`**

Create `app/(app)/list/ItemSheet.tsx` (uses the render-time reset pattern from `QuickAddSheet` — no `useEffect`):

```tsx
"use client";

import { useState } from "react";
import type { Category, ShoppingListItem } from "@/lib/shopping/types";
import { CATEGORIES, CATEGORY_LABEL } from "@/lib/shopping/types";
import { Sheet } from "@/components/ui/Sheet";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";

export type ItemDraft = { name: string; quantity: string; category: Category | "" };

export function ItemSheet({
  open, onClose, mode, item, onSubmit, onDelete,
}: {
  open: boolean;
  onClose: () => void;
  mode: "add" | "edit";
  item?: ShoppingListItem | null;
  onSubmit: (draft: ItemDraft) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState("");
  const [category, setCategory] = useState<Category | "">("");
  const [pending, setPending] = useState(false);

  // Re-seed inputs when the sheet (re)opens for a given item. Done during render,
  // keyed on a stable string, to avoid an effect (and the React-19 set-state-in-effect rule).
  const seedKey = `${open ? "o" : "c"}:${item?.id ?? "new"}`;
  const [seededKey, setSeededKey] = useState<string | null>(null);
  if (open && seedKey !== seededKey) {
    setSeededKey(seedKey);
    setName(item?.name ?? "");
    setQuantity(item?.quantity ?? "");
    setCategory(item?.category ?? "");
  }

  async function submit() {
    if (!name.trim()) return;
    setPending(true);
    try { await onSubmit({ name: name.trim(), quantity, category }); onClose(); }
    finally { setPending(false); }
  }

  return (
    <Sheet open={open} onClose={onClose} title={mode === "edit" ? "Edit item" : "Add to list"}>
      <div className="grid gap-3">
        <Field label="Item">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Chicken breast" />
        </Field>
        <Field label="Quantity (optional)">
          <Input value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="e.g. 2 lbs" />
        </Field>
        <Field label="Category (optional)">
          <Select value={category} onChange={(e) => setCategory(e.target.value as Category | "")}>
            <option value="">Uncategorized</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
          </Select>
        </Field>
        {item?.fdcId != null ? <p className="text-xs text-muted">Linked to USDA food #{item.fdcId}</p> : null}
        <Button onClick={submit} disabled={pending || !name.trim()}>
          {pending ? "…" : mode === "edit" ? "Save" : "Add"}
        </Button>
        {mode === "edit" && onDelete ? (
          <Button
            variant="danger"
            onClick={async () => { setPending(true); try { await onDelete(); onClose(); } finally { setPending(false); } }}
          >
            Delete item
          </Button>
        ) : null}
      </div>
    </Sheet>
  );
}
```

- [ ] **Step 4: Verify it compiles, lints, and builds**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: all pass (no type errors, no ESLint errors, build succeeds). The `Input` ref change is backward-compatible — existing `/login`, `/signup`, `/add` inputs still typecheck.

- [ ] **Step 5: Commit**

```bash
git add components/ui/Input.tsx components/ui/Checkbox.tsx components/ui/Select.tsx "app/(app)/list/ItemSheet.tsx"
git commit -m "feat(ui): ref-forwarding Input, Checkbox + Select primitives, shopping ItemSheet"
```

---

## Task 7: List screen (page + ListView)

**Files:**
- Create: `app/(app)/list/page.tsx`
- Create: `app/(app)/list/ListView.tsx`

**Interfaces:**
- Consumes: `getItems` (DAL); `groupItems` (`lib/shopping/group`); actions from `./actions`; `ItemSheet`/`ItemDraft` (`./ItemSheet`); `Checkbox`, `Input`, `Button`; `CATEGORY_LABEL`, `ShoppingListItem` (`lib/shopping/types`).
- Produces: default-exported `ListPage` (server) and `ListView({ initialItems })` (client).

**No unit test** (see the Testing note above — covered by `groupItems` + action/DAL tests and the e2e smoke). Verified by `pnpm typecheck && pnpm lint && pnpm build`.

- [ ] **Step 1: Write the server page**

Create `app/(app)/list/page.tsx`:

```tsx
import { getItems } from "@/lib/dal/shopping-list";
import { ListView } from "./ListView";

export default async function ListPage() {
  const items = await getItems();
  return <ListView initialItems={items} />;
}
```

- [ ] **Step 2: Write `ListView`**

Create `app/(app)/list/ListView.tsx` (optimistic via a local mirror that re-syncs when the server prop changes — render-time reset, no `useEffect`):

```tsx
"use client";

import { useState, useTransition, useRef } from "react";
import type { ShoppingListItem } from "@/lib/shopping/types";
import { CATEGORY_LABEL } from "@/lib/shopping/types";
import { groupItems } from "@/lib/shopping/group";
import { addItemAction, toggleItemAction, editItemAction, deleteItemAction, clearCheckedAction } from "./actions";
import { ItemSheet, type ItemDraft } from "./ItemSheet";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

export function ListView({ initialItems }: { initialItems: ShoppingListItem[] }) {
  const [items, setItems] = useState(initialItems);
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<ShoppingListItem | null>(null);
  const [, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  // Server data is the source of truth: re-sync the local mirror when a revalidate
  // delivers a new prop (render-time reset keyed on prop identity — no effect).
  const [syncedFrom, setSyncedFrom] = useState(initialItems);
  if (initialItems !== syncedFrom) { setSyncedFrom(initialItems); setItems(initialItems); }

  const { groups, checked } = groupItems(items);

  function addInline(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setNewName("");
    inputRef.current?.focus();
    startTransition(async () => { await addItemAction({ name }); });
  }

  function toggle(target: ShoppingListItem) {
    const next = !target.checked;
    setItems((prev) => prev.map((i) => (i.id === target.id ? { ...i, checked: next } : i))); // optimistic
    startTransition(async () => { await toggleItemAction({ id: target.id, checked: next }); });
  }

  function clearChecked() {
    setItems((prev) => prev.filter((i) => !i.checked)); // optimistic
    startTransition(async () => { await clearCheckedAction(); });
  }

  async function saveEdit(draft: ItemDraft) {
    if (!editing) return;
    await editItemAction({
      id: editing.id,
      name: draft.name,
      quantity: draft.quantity.trim() || null,
      category: draft.category || null,
    });
  }

  async function removeEditing() {
    if (!editing) return;
    await deleteItemAction({ id: editing.id });
  }

  return (
    <main className="p-4">
      <h1 className="mb-3 text-lg font-semibold">Shopping list</h1>

      <form onSubmit={addInline} className="mb-4 flex gap-2">
        <Input
          ref={inputRef}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Add item…"
          aria-label="Add item"
        />
        <button
          type="submit"
          aria-label="Add"
          className="shrink-0 rounded-md bg-brand px-4 text-lg font-light text-[#08130b]"
        >
          +
        </button>
      </form>

      {groups.length === 0 && checked.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted">Nothing on the list yet.</p>
      ) : null}

      {groups.map((group) => (
        <section key={group.category} className="mb-4">
          <h2 className="mb-1 text-[11px] uppercase tracking-wide text-muted">{CATEGORY_LABEL[group.category]}</h2>
          <ul className="divide-y divide-border/50">
            {group.items.map((item) => (
              <li key={item.id} className="flex items-center gap-3 py-2.5">
                <Checkbox checked={item.checked} onChange={() => toggle(item)} label={`Check ${item.name}`} />
                <button type="button" onClick={() => setEditing(item)} className="flex flex-1 justify-between text-left text-sm">
                  <span>{item.name}</span>
                  {item.quantity ? <span className="text-muted">{item.quantity}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {checked.length > 0 ? (
        <section className="mb-4">
          <h2 className="mb-1 text-[11px] uppercase tracking-wide text-muted">Checked</h2>
          <ul className="divide-y divide-border/50">
            {checked.map((item) => (
              <li key={item.id} className="flex items-center gap-3 py-2.5">
                <Checkbox checked={item.checked} onChange={() => toggle(item)} label={`Uncheck ${item.name}`} />
                <button type="button" onClick={() => setEditing(item)} className="flex flex-1 justify-between text-left text-sm text-muted line-through">
                  <span>{item.name}</span>
                  {item.quantity ? <span>{item.quantity}</span> : null}
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-3">
            <Button variant="ghost" onClick={clearChecked}>Clear checked</Button>
          </div>
        </section>
      ) : null}

      <ItemSheet
        open={editing !== null}
        onClose={() => setEditing(null)}
        mode="edit"
        item={editing}
        onSubmit={saveEdit}
        onDelete={removeEditing}
      />
    </main>
  );
}
```

- [ ] **Step 3: Verify it compiles, lints, and builds**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: all pass. (Confirm the `/list` route appears in the build route list.)

- [ ] **Step 4: Commit**

```bash
git add "app/(app)/list/page.tsx" "app/(app)/list/ListView.tsx"
git commit -m "feat(shopping): /list screen with inline add, aisle groups, check-off, clear"
```

---

## Task 8: Navigation — List tab + ＋ chooser

**Files:**
- Modify: `components/ui/TabBar.tsx`

**Interfaces:**
- Consumes: `Sheet`, `Button`; `ItemSheet`/`ItemDraft` (`@/app/(app)/list/ItemSheet`); `addItemAction` (`@/app/(app)/list/actions`); `useRouter` (`next/navigation`).
- Produces: updated `TabBar` (4 tabs + ＋ chooser).

**No unit test** (navigation chrome; verified by typecheck/lint/build + e2e smoke).

- [ ] **Step 1: Replace `components/ui/TabBar.tsx`**

```tsx
"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/Button";
import { ItemSheet, type ItemDraft } from "@/app/(app)/list/ItemSheet";
import { addItemAction } from "@/app/(app)/list/actions";

export function TabBar() {
  const pathname = usePathname();
  const router = useRouter();
  const [chooser, setChooser] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [, startTransition] = useTransition();
  const active = (p: string) => pathname === p || pathname.startsWith(p + "/");

  async function addToList(draft: ItemDraft) {
    startTransition(async () => {
      await addItemAction({
        name: draft.name,
        quantity: draft.quantity.trim() || undefined,
        category: draft.category || undefined,
      });
    });
  }

  return (
    <>
      <nav className="fixed inset-x-0 bottom-0 z-40 flex items-end justify-around border-t border-border bg-surface-2 px-2 pb-2 pt-2">
        <Link href="/today" className={`flex flex-1 flex-col items-center gap-0.5 text-[10px] ${active("/today") ? "text-brand" : "text-muted"}`}>
          <span className="text-lg leading-none">▦</span>Today
        </Link>
        <Link href="/list" className={`flex flex-1 flex-col items-center gap-0.5 text-[10px] ${active("/list") ? "text-brand" : "text-muted"}`}>
          <span className="text-lg leading-none">☑</span>List
        </Link>
        <button type="button" aria-label="Add" onClick={() => setChooser(true)} className="flex flex-1 flex-col items-center">
          <span className="-mt-5 flex h-12 w-12 items-center justify-center rounded-full bg-brand text-2xl font-light text-[#08130b] shadow-lg">+</span>
        </button>
        <Link href="/account" className={`flex flex-1 flex-col items-center gap-0.5 text-[10px] ${active("/account") ? "text-brand" : "text-muted"}`}>
          <span className="text-lg leading-none">◔</span>Account
        </Link>
      </nav>

      <Sheet open={chooser} onClose={() => setChooser(false)} title="Add">
        <div className="grid gap-2">
          <Button onClick={() => { setChooser(false); router.push("/add"); }}>Log food</Button>
          <Button variant="ghost" onClick={() => { setChooser(false); setAddOpen(true); }}>Add to list</Button>
        </div>
      </Sheet>

      <ItemSheet open={addOpen} onClose={() => setAddOpen(false)} mode="add" onSubmit={addToList} />
    </>
  );
}
```

- [ ] **Step 2: Verify it compiles, lints, and builds**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add components/ui/TabBar.tsx
git commit -m "feat(nav): List tab and center-plus chooser (log food / add to list)"
```

---

## Task 9: USDA-linked add from the food detail sheet

**Files:**
- Modify: `app/(app)/add/QuickAddSheet.tsx`
- Modify: `app/(app)/add/AddView.tsx`

**Interfaces:**
- `QuickAddSheet` gains an optional prop `onAddToList?: () => Promise<void>`; the "Add to shopping list" button renders only when `mode === "add"` and `onAddToList` is provided.
- `AddView` passes `onAddToList` that calls `addItemAction({ name: selected.description, fdcId: selected.fdcId })`.

**No unit test** (UI wiring; the `addItem` fdc_id path is covered in Task 4). Verified by typecheck/lint/build + e2e smoke.

- [ ] **Step 1: Add the prop + button to `QuickAddSheet`**

In `app/(app)/add/QuickAddSheet.tsx`, add `onAddToList` to the props type (after `onDelete`):

```tsx
  onSubmit: (args: { amountGrams: number; meal: Meal }) => Promise<void>;
  onDelete?: () => Promise<void>;
  onAddToList?: () => Promise<void>;
}) {
```

Destructure it in the function signature:

```tsx
  open, onClose, food, initialMeal, initialGrams, mode = "add", onSubmit, onDelete, onAddToList,
```

Then, inside the `food ? (...)` block, immediately after the primary submit `<Button>…</Button>` and before the `mode === "edit"` delete button, insert:

```tsx
          {mode === "add" && onAddToList ? (
            <Button
              variant="ghost"
              onClick={async () => { setPending(true); try { await onAddToList(); onClose(); } finally { setPending(false); } }}
            >
              Add to shopping list
            </Button>
          ) : null}
```

- [ ] **Step 2: Wire `onAddToList` in `AddView`**

In `app/(app)/add/AddView.tsx`, add the action import near the existing `addFoodAction` import:

```tsx
import { addItemAction } from "@/app/(app)/list/actions";
```

Then pass the handler on the `<QuickAddSheet>` element (alongside `onSubmit`):

```tsx
        onAddToList={selected ? async () => {
          await addItemAction({ name: selected.description, fdcId: selected.fdcId });
          setToast("Added to shopping list.");
        } : undefined}
```

- [ ] **Step 3: Verify it compiles, lints, and builds**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: all pass. (`TodayView` still uses `QuickAddSheet` in `mode="edit"` with no `onAddToList` → the button stays hidden there.)

- [ ] **Step 4: Commit**

```bash
git add "app/(app)/add/QuickAddSheet.tsx" "app/(app)/add/AddView.tsx"
git commit -m "feat(shopping): add a USDA food to the shopping list from the detail sheet"
```

---

## Task 10: Docs + full-suite verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the feature in `README.md`**

Find the feature list / phase section in `README.md` and add a line describing the shopping list, e.g. under the existing features:

```markdown
- **Shopping list** — a per-user list of items to buy (free-text or linked from a USDA food), grouped by aisle, with check-off and one-tap "Clear checked". Owner-only (RLS); built to go offline in a later phase.
```

If `README.md` has no feature bullets, add a short `## Shopping list` subsection with the same sentence. Keep wording neutral (no AI/attribution).

- [ ] **Step 2: Run the full unit/boundary suite**

Run: `pnpm test`
Expected: all suites green; the RLS suites self-skip offline (no `SUPABASE_TEST_*`).

- [ ] **Step 3: Run typecheck, lint, build together**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: all pass; build lists routes `/today`, `/list`, `/add`, `/account`.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document the shopping list feature"
```

- [ ] **Step 5: (Post-merge) live RLS + e2e**

After the branch merges to `main`:
- `db-migrate.yml` applies `0004_shopping_list.sql` to the cloud project (secrets configured since Phase 2).
- `RLS Integration Tests` runs `tests/rls/shopping-list.test.ts` against a fresh local stack (it already globs `tests/rls/**` + `supabase/migrations/**`).
- Manual e2e smoke (success criteria below): ＋ → Add to list → item appears under its aisle; check it → moves to the struck-through Checked section; Clear checked → it's gone; from `/add`, search a food → detail sheet → "Add to shopping list" → it appears on `/list` with the food's name.

---

## Success criteria (Phase 3 is done when…)

1. A logged-in user sees a `/list` tab; the center ＋ offers **Log food** and **Add to list**.
2. Items add three ways — inline on `/list`, via the ＋ chooser, and from a USDA food's detail sheet (the last carrying `fdc_id`) — each with optional quantity and category.
3. Items group by aisle category; checking one strikes it through and moves it to the Checked section; **Clear checked** removes all checked items at once.
4. Edit and single-item delete work; removed items are soft-deleted (`deleted_at`), never hard-deleted.
5. The RLS suite proves User B cannot read or modify User A's lists or items (including by `list_id`) and passes in CI against real Postgres.
6. `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` are green; the migration applies cleanly on merge.
7. Scope held: one default list per user, online-only — no offline/sync, sharing, or multi-list UI.

---

## Self-review

**Spec coverage:** §3 data model → Task 1. §4 validation/DAL/actions/grouping → Tasks 2–5. §5 UI/nav (tab, ＋ chooser, list screen, add-to-list sheet, edit sheet, USDA-link button, Checkbox/Select) → Tasks 6–9. §6 forward-compat → encoded in the Task 1 schema (UUID/updated_at/deleted_at/ownership-via-list) + noted. §7 testing → RLS (T1), validation (T2), grouping (T3), DAL (T4), actions (T5); the §7 "ListView component test" is deliberately replaced by the helper/action/DAL coverage + e2e smoke (no DOM harness — flagged in the Testing note). §8 error handling → boundary `safeParse` in actions, DAL throws, RLS `42501` surfaces. §9 deploy → Task 10 Step 5. §10 success criteria → carried verbatim.

**Placeholder scan:** no TBD/TODO; every code step has complete code; no "similar to Task N".

**Type consistency:** `ShoppingListItem` shape (camelCase, `fdcId`, `createdAt`) is defined in T2 and consumed identically in T3/T4/T7. DAL `Row` (snake_case) maps to it only in `getItems`. `ItemDraft` (`{ name, quantity, category }`) defined in T6, consumed in T7 (`saveEdit`) and T8 (`addToList`). `ActionResult` defined in T5, used by all actions. `groupItems → GroupedList { groups, checked }` defined in T2/T3, destructured in T7. Action input objects match each Zod schema's field names.
