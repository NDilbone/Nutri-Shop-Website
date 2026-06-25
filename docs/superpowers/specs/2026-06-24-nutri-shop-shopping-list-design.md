# Nutri-Shop — Phase 3: Shopping List (online) (design)

**Date:** 2026-06-24
**Author:** NDilbone
**Status:** Approved design, pending implementation plan
**Predecessor:** [`2026-06-24-nutri-shop-macro-tracker-design.md`](./2026-06-24-nutri-shop-macro-tracker-design.md) (roadmap Phase 2) · [`2026-06-24-nutri-shop-usda-food-search-design.md`](./2026-06-24-nutri-shop-usda-food-search-design.md) (Phase 1) · foundation [`2026-06-23-nutri-shop-foundation-design.md`](./2026-06-23-nutri-shop-foundation-design.md)

**Scope of this spec:** the online shopping list (roadmap Phase 3). A per-user list of things to buy — free-text items with an optional quantity, an optional aisle category, and an optional link back to a USDA food. Items can be checked off while shopping and cleared in a batch. It adds a `shopping_lists` table and a `shopping_list_items` table (both with owner-only RLS), Server Actions to add/edit/toggle/delete/clear, a `/list` tab, and a center-＋ chooser. The schema is shaped so the **offline + sync** phase (Phase 5) and a future **shared/household** list (Phase 6+) are non-breaking additions, not rewrites.

---

## 1. Goal & non-goals

### Goal
Let an invited, logged-in user keep a running shopping list on their phone: add items fast (free-text, or linked from a USDA food they were looking at), group them by aisle, check them off in-store, and clear the checked ones when done — owned per user, isolated by RLS, online-only for now but built to go offline next.

### Non-goals (Phase 3 — deferred)
- **Offline use + sync** (Dexie local store + outbox, last-write-wins) — Phase 5. The schema (client-mintable UUID, `updated_at`, `deleted_at`, idempotent upsert) is laid down now so Phase 5 adds a sync layer without a migration.
- **Shared / household list** (you + fiancé see one list) — Phase 6+. Ownership is modeled so this becomes a *broaden-the-policy* change, not a re-architecture (see §6).
- **Multiple named lists UI** — the schema supports many lists per owner (`name`, `is_default`), but v1 surfaces exactly one default list. No list-management UI.
- **Manual drag-reorder** of items — items sort by category then insertion order.
- **Recurring / staple presets** ("re-add my usuals"), favorites, history of past lists.
- **Category auto-guess** from a USDA food's data — category is user-set (or none).
- **Quantity unit math** — quantity is a free-text label ("2 lbs", "1 dozen"), not a parsed/convertible number.
- **PWA install** (Phase 4), **MFA / in-app invite admin** (Phase 6).

---

## 2. Decisions locked

| # | Decision | Rationale |
|---|---|---|
| Ownership | **Per-user** list, owner-only RLS now. Not shared in v1. | Matches the foundation's "security before features"; the user picked per-user-now with a non-breaking path to sharing. |
| Structure | A **`shopping_lists`** table + a **`shopping_list_items`** table; items FK to a list; v1 gives each user one **default** list. | User chose the multi-list-ready structure over a flat items table. Ownership lives on the list; items derive it via `list_id` — the seam that makes household sharing a later broaden (§6). |
| Item fields | `name` (required) · `quantity` (optional free-text) · `category` (optional, fixed set) · `fdc_id` (optional USDA link) · `checked`. | Covers brain-dump items ("paper towels") and food-linked items alike; aisle category helps in-store. |
| Categories | Fixed set: `produce, meat, dairy, bakery, frozen, pantry, beverages, household, other`. `null` = uncategorized, shown in the **Other** bucket. | A constrained set groups cleanly by aisle and avoids free-text fragmentation/typos. |
| Check-off | Checking an item keeps it (struck-through, sorted to the bottom of its group); a **Clear checked** action soft-deletes all checked items at once. | Standard grocery UX; lets you un-check mistakes; soft-delete is sync-safe (Phase 5). |
| Removal | **Soft delete** (`deleted_at`) for both single-item delete and Clear checked. | Sync-ready (last-write-wins needs tombstones); consistent with `logged_foods`. |
| Navigation | `/list` becomes the **4th tab**; the center **＋** becomes a chooser: **Log food** (→ `/add`) or **Add to list**. | List is a primary surface → first-class tab. One prominent add button serves both features (user's choice; accepts the extra tap on the Phase-2 log path). |
| Add paths | (a) inline **Add item** row on the list screen for rapid entry; (b) **Add to list** from the ＋ chooser; (c) **Add to shopping list** button on the USDA food detail sheet. Only (c) sets `fdc_id`. | Fast brain-dump + a cross-app entry point + the food-link integration, without overloading one sheet. |
| Aesthetic | Reuse the Phase-2 **dark-editorial** tokens + primitives. Two new primitives only: `Checkbox`, `Select`. | No new visual identity; stay consistent and minimal. |

---

## 3. Data model

New migration `supabase/migrations/0004_shopping_list.sql`. It **reuses** the existing `public.set_updated_at()` trigger function created in `0003` (does not redefine it).

### `shopping_lists`
One row per list. v1: each user has exactly one row with `is_default = true`.

```sql
create table public.shopping_lists (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users (id) on delete cascade,
  name       text not null default 'Shopping list' check (char_length(name) between 1 and 100),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Exactly one live default list per owner. The lazy get-or-create (§4) relies on
-- this to stay idempotent under a concurrent double-insert (second insert conflicts).
create unique index shopping_lists_one_default
  on public.shopping_lists (owner_id) where is_default and deleted_at is null;
```

### `shopping_list_items`
Ownership is **derived through `list_id`** — there is deliberately no redundant `user_id` column. That single source of ownership is what lets a future "share this list with a household" change broaden access without touching item rows.

```sql
create table public.shopping_list_items (
  id         uuid primary key default gen_random_uuid(),   -- client may also mint (offline-ready, Phase 5)
  list_id    uuid not null references public.shopping_lists (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 200),
  quantity   text check (quantity is null or char_length(quantity) <= 50),  -- free-text label, e.g. "2 lbs"
  category   text check (category in
               ('produce','meat','dairy','bakery','frozen','pantry','beverages','household','other')),
  fdc_id     bigint,                                        -- set ONLY for items added from a USDA food
  checked    boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz                                    -- soft delete; "Clear checked" sets this
);

create index shopping_list_items_list
  on public.shopping_list_items (list_id) where deleted_at is null;
```

### RLS — owner-only on both tables

```sql
alter table public.shopping_lists      enable row level security;
alter table public.shopping_list_items enable row level security;

-- shopping_lists: owner-only across all four verbs.
create policy "shopping_lists_select_own" on public.shopping_lists
  for select using ( (select auth.uid()) = owner_id );
create policy "shopping_lists_insert_own" on public.shopping_lists
  for insert with check ( (select auth.uid()) = owner_id );
create policy "shopping_lists_update_own" on public.shopping_lists
  for update using ( (select auth.uid()) = owner_id )
             with check ( (select auth.uid()) = owner_id );
create policy "shopping_lists_delete_own" on public.shopping_lists
  for delete using ( (select auth.uid()) = owner_id );

-- shopping_list_items: you may touch an item iff you own its (live) list.
-- This EXISTS predicate is the forward-compat seam (§6) — later it becomes "owner OR member".
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
```

### Grants & triggers
Explicit grants on both tables (the `0001` lesson — a fresh local CI stack lacks Supabase's implicit default privileges; RLS still gates which rows each role can touch):

```sql
grant all on public.shopping_lists      to service_role;
grant all on public.shopping_list_items to service_role;
grant select, insert, update, delete on public.shopping_lists      to authenticated;
grant select, insert, update, delete on public.shopping_list_items to authenticated;

create trigger shopping_lists_set_updated_at
  before update on public.shopping_lists
  for each row execute function public.set_updated_at();
create trigger shopping_list_items_set_updated_at
  before update on public.shopping_list_items
  for each row execute function public.set_updated_at();
```

### Default-list provisioning
**Lazy get-or-create in the DAL** — no auth-trigger change, no backfill for the two existing users. On first list access, select the owner's live `is_default` list; if absent, insert one (`is_default = true`) via the RLS-scoped client. The `shopping_lists_one_default` partial unique index makes a concurrent double-insert fail-closed (`insert ... on conflict do nothing`, then re-select), which keeps it idempotent — the same upsert discipline Phase 5 will rely on.

---

## 4. Application layer

### Validation — `lib/validation/shopping-list.ts` (Zod 4)
Boundary validation only (mirrors `lib/validation/log.ts`). Exports a `CATEGORIES` tuple reused by the DB check set and the UI picker.

```ts
export const CATEGORIES = ['produce','meat','dairy','bakery','frozen','pantry','beverages','household','other'] as const;

addItemSchema    // { name: string 1..200, quantity?: string ≤50, category?: enum(CATEGORIES), fdcId?: positive int }
editItemSchema   // { id: uuid, name?: 1..200, quantity?: string ≤50 | null, category?: enum | null }
toggleItemSchema // { id: uuid, checked: boolean }
deleteItemSchema // { id: uuid }
// clearChecked takes no input
```

### DAL — `lib/dal/shopping-list.ts` (`server-only`)
Same shape as `lib/dal/logged-foods.ts`: `import "server-only"`, `verifySession()` first (throws `Unauthenticated` if absent), an RLS-scoped `createClient()` for every query. RLS is the backstop; the DAL also scopes explicitly by the resolved `list_id`.

- `getOrCreateDefaultList(): Promise<{ id: string }>` — select the owner's live `is_default` list; insert one if none (idempotent, §3).
- `getItems(): Promise<ShoppingListItem[]>` — resolve the default list, select its non-deleted items, return them flat and typed. Grouping is applied at render (client), so an optimistic check re-sorts instantly without waiting on a revalidate.
- `addItem(input: AddItemInput): Promise<{ id: string }>` — resolve default list, insert `{ list_id, name, quantity, category, fdc_id }`. For USDA-linked adds the caller passes `name` already snapshotted from the food's `description`; the DAL does **not** fetch FDC data — on a shopping list the food is just a labelled reference, no nutrition is stored.
- `toggleItem(id, checked): Promise<void>` — update `checked`.
- `editItem(input: EditItemInput): Promise<void>` — update `name` / `quantity` / `category` (no-op if patch empty).
- `softDeleteItem(id): Promise<void>` — set `deleted_at`.
- `clearChecked(): Promise<void>` — set `deleted_at` on every `checked = true`, `deleted_at is null` row of the default list (bulk update).

### Server Actions — `app/(app)/list/actions.ts` (`"use server"`)
One thin action per DAL op, using the Phase-2 `ActionResult = { ok: true } | { error: string }` shape. Each `safeParse`s its input, calls the DAL, and `revalidatePath("/list")`:
`addItemAction`, `editItemAction`, `toggleItemAction`, `deleteItemAction`, `clearCheckedAction`.

### Grouping helper — `lib/shopping/group.ts` (pure)
Takes flat items → returns `{ groups, checked }`. **`groups`** = the *unchecked* items grouped by category in **aisle order** `[produce, meat, dairy, bakery, frozen, pantry, beverages, household, other]` (a `null` category falls into `other`; empty groups omitted), each group sub-sorted by `created_at` ascending. **`checked`** = all checked items in one flat list, also `created_at` ascending — rendered as the single struck-through "Checked" section at the bottom. Pure and unit-tested in isolation from the DB.

---

## 5. UI / UX

Phone-first, inside the existing `app/(app)` shell (`requireUser()` gate, `max-w-[480px]`, bottom `TabBar`).

### Navigation — `components/ui/TabBar.tsx`
Four tabs + a center chooser:

```
[▦ Today]   [☑ List]   (＋)   [◔ Account]
```

- New **List** tab (left of ＋), reusing the existing active-state styling.
- The center **＋** is no longer a `<Link href="/add">`. It becomes a button that opens a small chooser `Sheet` with two actions:
  - **Log food** → navigates to `/add` (the Phase-2 flow, unchanged once you're there).
  - **Add to list** → opens the **Add-to-list sheet**.
  - `TabBar` is already a client component, so it owns the chooser open-state. (Tradeoff the user accepted: the Phase-2 "tap ＋ to log food" path now has one extra tap.)

### `/list` screen — `app/(app)/list/page.tsx` (server) → `ListView` (client)
`page.tsx` calls `getItems()` and renders `ListView` with the flat items; `ListView` applies the pure grouping helper at render (so an optimistic toggle re-sorts immediately).

```
 Shopping list
 ┌─ Add item ───────────────┐ [＋]      ← inline rapid-add (type, Enter, repeat)
 PRODUCE
   [ ] Bananas
 MEAT
   [ ] Chicken breast    2 lbs
 DAIRY
   [ ] Milk              1 gal
 ── checked ──
   [x] ~~Eggs~~
            [ Clear checked ]
```

- **Inline add row** at the top: a free-text `name` input; Enter submits `addItemAction` and **keeps focus** so several items can be typed in a row. (Quantity/category for inline-added items are set later via the edit sheet.)
- Items render **grouped by category** (aisle order) with small section headers; unchecked items first; a **"checked"** divider precedes the struck-through, checked items.
- Each row: a **`Checkbox`** (tap → `toggleItemAction`, optimistic) + the name + a muted quantity. Tapping the **row body** opens the **edit sheet**.
- **Clear checked** button — shown only when ≥1 item is checked → `clearCheckedAction`.

### Add-to-list sheet — `AddToListSheet` (client)
A `Sheet` opened by the ＋ chooser's **Add to list**: `name` (required `Input`), `quantity` (optional `Input`), `category` (optional `Select`) → `addItemAction`. Free-text only; never sets `fdc_id`.

### Edit sheet
Same `Sheet` in edit mode: `name` / `quantity` / `category` prefilled → `editItemAction`, plus a **Delete** (`deleteItemAction`, soft delete). If the item is USDA-linked, the link is shown read-only (the food reference is fixed; `fdc_id` isn't user-editable).

### USDA-linked entry — `app/(app)/add/QuickAddSheet.tsx`
In the food **detail** sheet, add a secondary **"Add to shopping list"** button beside "Add to {meal}". It calls `addItemAction` with `name = food.description` and `fdcId = food.fdcId` (category/quantity left empty, editable later). This is the **only** path that sets `fdc_id`.

### Primitives
Two new, token-styled, reused thereafter:
- **`Checkbox`** — an accessible `aria-checked` toggle button.
- **`Select`** — a native `<select>` styled to the dark tokens (accessible, low-build) for the 9-option category picker.

Everything else reuses `Sheet` / `Input` / `Button` / `Field` / `Card`. Actions run through `useTransition`; check/uncheck is optimistic (Phase-2 pattern).

---

## 6. Forward-compat (built in, not built now)

- **Offline + sync (Phase 5):** the convention is already on both tables — client-mintable UUID primary key, `updated_at` (auto-bumped by trigger), `deleted_at` tombstones, and writes expressible as idempotent upserts on the PK. Phase 5 adds a Dexie local store + outbox and a last-write-wins flush; **no schema migration** is needed for sync.
- **Shared / household list (Phase 6+):** ownership lives only on `shopping_lists.owner_id`; items derive access through the `list_id → owner_id` join in their RLS policies. Adding sharing is then: create `households` + `memberships`, add a (nullable) `household_id` to `shopping_lists`, and swap the lists' `owner_id = uid()` check for "owner **OR** a member of the list's household". Item policies are unchanged — they already defer to the list. `name` + `is_default` also mean multiple named lists need no schema change, only UI.
- **PWA (Phase 4):** `/list` is an ordinary authenticated route; the service worker stays out of auth/REST caching per the foundation rule, so adding install support doesn't interact with this phase.

---

## 7. Testing strategy (TDD — each behavior fails first)

- **RLS integration** (`tests/rls/`, the fail-closed suite already gating CI via `.github/workflows/rls.yml`): User B cannot `select` / `insert` / `update` / `delete` User A's `shopping_lists` or `shopping_list_items`; specifically B cannot attach an item to A's list (the item→list→owner `EXISTS` predicate holds). Extends the existing cross-user isolation tests.
- **DAL / action units** (`tests/dal/`, `tests/actions/`): happy paths for add / edit / toggle / softDelete / clearChecked; `getOrCreateDefaultList` creates exactly once then reuses (idempotent); the unauthenticated path throws; ownership backstop. Validation rejects empty/oversized `name`, bad `category`, non-uuid `id`.
- **Grouping helper** (`tests/shopping/group.test.ts`): aisle ordering, `null → other` bucket, unchecked-before-checked, `created_at` sub-sort. Pure, fast, no DB.
- **Component** (`ListView`): renders category groups + struck-through checked section; **Clear checked** hidden when nothing is checked; inline add clears the input and retains focus.

---

## 8. Error handling

Consistent with the existing codebase, no speculative layers:
- **Boundary validation** in Server Actions (`safeParse` → `{ error }`); inputs past that boundary are trusted internally.
- **DAL throws** on a Supabase error; the client maps it to a toast (Phase-2 pattern). An RLS denial surfaces as Postgres `42501` rather than failing silently (the Phase-1 lesson — no swallowed write errors).
- No defensive `null`-checks piled inside the codebase past the validated boundary; no try/catch that only re-throws.

---

## 9. Deployment

- Migration `0004_shopping_list.sql` auto-applies via `db-migrate.yml` on merge to `main` (the three `SUPABASE_*` secrets have been configured since Phase 2).
- The RLS Integration Tests workflow spins up a fresh local Supabase stack and runs the new isolation tests against real Postgres before the feature is trusted.
- No new environment variables, no new third-party services.

---

## 10. Success criteria (Phase 3 is done when…)

1. A logged-in user sees a `/list` tab; the center ＋ offers **Log food** and **Add to list**.
2. They can add items (inline, via the chooser, and from a USDA food's detail sheet — the last carrying `fdc_id`), each with optional quantity and category.
3. Items group by aisle category; checking one strikes it through and sorts it to the bottom; **Clear checked** removes all checked items in one action.
4. Edit and single-item delete work; removed items are soft-deleted (`deleted_at`), never hard-deleted.
5. The RLS suite proves User B cannot read or modify User A's lists or items (including via list_id), and passes in CI against real Postgres.
6. CI (lint, typecheck, build, unit tests) is green; the migration applies cleanly to the cloud project on merge.
7. Scope held: one default list per user, online-only — no offline/sync, sharing, or multi-list UI yet.
