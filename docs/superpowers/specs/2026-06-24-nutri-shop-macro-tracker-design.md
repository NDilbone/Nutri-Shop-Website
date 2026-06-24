# Nutri-Shop — Phase 2: Macro/Micro Tracker (design)

**Date:** 2026-06-24
**Author:** NDilbone
**Status:** Approved design, pending implementation plan
**Predecessor:** [`2026-06-24-nutri-shop-usda-food-search-design.md`](./2026-06-24-nutri-shop-usda-food-search-design.md) (roadmap Phase 1) · foundation [`2026-06-23-nutri-shop-foundation-design.md`](./2026-06-23-nutri-shop-foundation-design.md)

**Scope of this spec:** the first user-facing feature — a phone-first macro/micro **tracker**. It builds the search UI deferred from Phase 1, a `logged_foods` table with RLS, Server Actions to log/edit/delete entries, per-day totals, and the authenticated **navigation shell** (bottom tab bar) plus a **right-sized dark-editorial design system** the later phases reuse. The food data API (`/api/foods` search + detail) already exists from Phase 1 and is consumed unchanged.

---

## 1. Goal & non-goals

### Goal
Let an invited, logged-in user search USDA foods, log what they ate (by grams or servings, tagged to a meal and a day), and see that day's running macro and micro totals — on a phone, fast, with a coherent visual identity that carries forward.

A logged entry is a **historical fact**: once recorded it must not change if USDA refreshes its data or the cache evicts.

### Non-goals (Phase 2 — deferred)
- **Macro/micro goals & targets** with progress rings/bars (needs a `targets` table) — deferred.
- **Overview dashboard** (a whole-account summary landing the owner wants *eventually*) — deferred; `/today` is the day-view tab, an overview can be added later as its own route without disturbing this.
- Custom/manual foods, favorites, recents, saved searches.
- Barcode scanning.
- Multi-day analytics / trends / charts (single-day view only; a date picker selects which day).
- Light theme (tokens are structured to support it; only dark is built).
- PWA install (Phase 4), offline logging & sync (Phase 5), in-app invite admin / MFA (Phase 6).

---

## 2. Decisions locked

| # | Decision | Rationale |
|---|---|---|
| Scope | Tracker MVP: search UI → log → day totals → nav shell + design system. | One cohesive vertical slice; goals/diary/custom-foods deferred. |
| Quantity | **Grams + servings**: user types grams *or* picks N servings; servings convert to grams; grams stored. | Flexible; gracefully degrades to grams-only when a food carries no serving size (common for Foundation/SR Legacy). |
| Meals | `breakfast / lunch / dinner / snack`; day view groups by meal with subtotals. | Familiar tracker UX; one `meal` column. |
| Day selection | **Date picker**, default today; the day view is parameterized by date. | User can fix "forgot to log yesterday"; pulls a sliver of diary forward without full analytics. |
| Nutrient surfacing | **Headline 4 macros** (cal/protein/carbs/fat) always visible; the other 10 in a collapsible "Full nutrition"; **all 14 summed** for the day. | Honors the macro/*micro* promise while staying readable on a phone. |
| Nutrition storage | **Snapshot** per-100g `NormalizedNutrition` + `description` into each log row. | Historical correctness (immune to USDA refresh / 30-day cache eviction) and renders the day without re-fetching. |
| Aesthetic | **Dark-editorial**: near-monochrome `#0f1411`, green accent `#22c55e`, thin type, minimal chrome, dark-first. | Owner choice (visual companion). |
| Navigation | **Bottom tab bar**: `Today · ＋(Add) · Account`, center "+" launches the add flow. | Phone-first thumb-zone; a `List` tab slots in for Phase 3 with no redesign. |
| Log interaction | **Quick-add bottom sheet** over the search screen (tap result → set amount/meal → Add, stay in place). | Owner logs frequently; minimizes taps and navigation. |
| Landing route | Rename `/dashboard` → `/today` (day view); update root + proxy redirects. | Cleaner semantics; leaves `/dashboard` free for the future overview. |

---

## 3. Module & route layout

```
supabase/migrations/0003_logged_foods.sql   logged_foods table + RLS + grants + updated_at trigger

lib/nutrition/compute.ts        pure: perEntry/day/meal totals from snapshot × grams; servings→grams; null handling
lib/nutrition/types.ts          LoggedFood, DayTotals, Meal enum, AddFoodInput (re-uses Phase-1 NormalizedNutrition)
lib/dal/logged-foods.ts         server-only DAL: logFood / editLog / softDeleteLog / getDay (snapshot derived server-side)
lib/validation/log.ts           Zod: addFoodSchema, editFoodSchema, dateParam, meal enum

app/(app)/layout.tsx            authenticated shell: requireUser() + <TabBar/>
app/(app)/today/page.tsx        day view (?date=) — headline macros + collapsible full nutrition + meal sections
app/(app)/today/actions.ts      'use server' Server Actions: addFoodAction, editFoodAction, deleteFoodAction
app/(app)/add/page.tsx          search screen (calls /api/foods) + <QuickAddSheet/>
app/(app)/account/page.tsx      profile + sign out (moved from old dashboard)
app/(app)/_components/          QuickAddSheet (client), DayView, MealSection, EntryRow, NutritionPanel

components/ui/                   design-system primitives: Button, Input, Field, Card, Segmented, Sheet, TabBar, StatTile
app/globals.css                 Tailwind 4 @theme tokens (dark-first); self-hosted Inter via next/font/local
```

Each unit keeps one purpose: `compute.ts` is pure (no I/O, fully unit-tested); the DAL is the only place that writes logs and the only place nutrition is snapshotted; Server Actions orchestrate `verifySession → validate → DAL → revalidate`; UI components are presentational except the sheet.

---

## 4. Data model — `0003_logged_foods.sql`

```sql
create table public.logged_foods (
  id           uuid primary key default gen_random_uuid(),   -- DB-default; client may also mint (offline-ready, Phase 5)
  user_id      uuid not null references auth.users (id) on delete cascade,
  fdc_id       bigint not null,                               -- source food (for re-open / future re-derive)
  description  text not null,                                 -- label snapshot at log time
  meal         text not null check (meal in ('breakfast','lunch','dinner','snack')),
  amount_grams numeric not null check (amount_grams > 0 and amount_grams <= 100000),
  nutrition    jsonb not null,                                -- per-100g NormalizedNutrition snapshot at log time
  logged_on    date not null,                                 -- the day it counts toward (client local tz)
  logged_at    timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz                                    -- soft delete (sync-ready, Phase 5)
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

-- Explicit grants (fresh local CI stack lacks Supabase's implicit defaults — see RLS workflow notes).
grant all on public.logged_foods to service_role;
grant select, insert, update, delete on public.logged_foods to authenticated;

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

**Conventions adopted** (per the foundation forward-compat plan): client-mintable UUID PK, `updated_at`, `deleted_at` soft-delete. Phase 5 (offline + last-write-wins sync) then needs no migration.

**Soft delete:** the app deletes by `update … set deleted_at = now()` (so deletions can sync later). The `delete` RLS policy is kept as an owner-scoped safety valve but the app does not hard-delete.

---

## 5. Nutrition math contract — `lib/nutrition/compute.ts` (pure)

```ts
// per-entry value of one nutrient: snapshot is per-100g
amount_for_entry(k) = nutrition.nutrients[k].amount === null
                        ? null
                        : nutrition.nutrients[k].amount * amount_grams / 100;

// servings → grams (add sheet): grams = servings * serving.amount   (serving from Phase-1 detail)
// enabled only when detail.serving is present; ml is treated 1:1 with g (documented approximation)

// day totals: sum each nutrient across the day's non-deleted entries.
//   null = "not reported" → contributes 0 to the sum; if ANY contributor was null,
//   mark that nutrient incomplete so the UI can show e.g. "Sodium 104 mg*".
```
- All amounts rounded for display only, never in storage.
- Calories shown per entry and per meal subtotal are derived the same way (`energyKcal`).

---

## 6. Server layer — DAL + Server Actions (security & integrity)

`lib/dal/logged-foods.ts` (`import 'server-only'`):

| Function | Behavior |
|---|---|
| `logFood({ fdcId, amountGrams, meal, loggedOn })` | `verifySession()` → **fetch authoritative per-100g nutrition for `fdcId` from `food_cache` via the Phase-1 cached-detail path** → snapshot `{ nutrition, description }` → insert with `user_id` from the session (the authenticated server client, under RLS). |
| `editLog({ id, amountGrams?, meal? })` | `verifySession()` → update by `id` (RLS scopes to owner) → returns updated row. Does not let the client change `nutrition`/`fdc_id`. |
| `softDeleteLog({ id })` | `verifySession()` → `update … set deleted_at = now()` (RLS-scoped). |
| `getDay(loggedOn)` | `verifySession()` → select owner's non-deleted entries for `loggedOn` (RLS-scoped) → compute meal groups + day totals via `compute.ts`. |

**Integrity rule (load-bearing):** the stored `nutrition` is **always server-derived from `fdcId`**, never accepted from the client. The client sends only `{ fdcId, amountGrams, meal, loggedOn }`. The sheet's live macro preview is UX only. This prevents a forged-nutrition log even though the data is per-user.

**Trust model (documented honestly):** writes use the user's authenticated server client under RLS, so a row's `user_id` can only ever be the caller (`with check`). A user could call supabase-js directly to insert/edit *their own* row with arbitrary values — but this is private, per-user data, so the only victim is themselves (same model as `profiles.display_name`). The Server Action is the sanctioned, authoritative path. No cross-user exposure exists.

**No FDC throttle on logging:** `logFood` reads `food_cache` (already warm — the sheet just fetched the detail through the rate-limited `/api/foods/[fdcId]` route). If somehow absent it goes through the same cached-detail function once; the per-user FDC throttle stays on the API routes, not on log writes.

**Validation (`lib/validation/log.ts`, Zod `safeParse` at the boundary):** `fdcId` positive int; `amountGrams` finite, `> 0`, `<= 100000`; `meal` ∈ enum; `loggedOn` a valid `YYYY-MM-DD`; `id` a uuid. `user_id` is never read from input.

---

## 7. UI — shell, screens, design system

### Design system (dark-editorial, right-sized)
Tokens via Tailwind 4 `@theme` in `globals.css`, dark-first:

| Token | Value |
|---|---|
| `--color-bg` | `#0f1411` |
| `--color-surface` | `#1a211c` |
| `--color-border` | `#232b25` |
| `--color-text` | `#e7ece8` |
| `--color-muted` | `#8a948c` (approx; finalize in build) |
| `--color-accent` (= brand) | `#22c55e` |
| `--color-protein` / `--color-carbs` / `--color-fat` | `#4ade80` / `#fbbf24` / `#60a5fa` |
| type scale, spacing scale, radii (`--radius-md: 12px`, etc.) | a small fixed set |

Font: **Inter**, self-hosted via `next/font/local` (keeps CSP `font-src 'self'`; no external fetch). Primitives in `components/ui/`: `Button`, `Input`, `Field`, `Card`, `Segmented` (g/serving + meal pickers), `Sheet`, `TabBar`, `StatTile`. Existing `/login` + `/signup` are retrofitted to these primitives so the app is visually consistent. Tokens are named for theme-ability; a light theme is **not** built.

### Nav shell — `app/(app)/layout.tsx`
`requireUser()` gate (DAL session check) + a fixed bottom `<TabBar>` (`Today · ＋ · Account`). The "+" routes to `/add`. CSP: all interactivity is nonce-stamped component JS; no inline scripts.

### Today — `app/(app)/today/page.tsx?date=YYYY-MM-DD`
Server Component. Header: `‹ {date} ›` date nav (defaults today). Headline: calories + protein/carbs/fat stat tiles. Collapsible **Full nutrition** panel: the remaining 10 nutrients (with `*` incompleteness markers). Meal sections (Breakfast/Lunch/Dinner/Snack) with per-meal subtotal and `EntryRow`s (`description · {amount}g · kcal`). Tapping a row opens the sheet in **edit** mode. Empty state per meal.

### Add — `app/(app)/add/page.tsx`
Search box → `GET /api/foods?q=` → results (`description`, source/brand, kcal/100g) with a source filter (All / Branded / Generic). Tapping a result opens `QuickAddSheet`.

### QuickAddSheet (client component)
On open: `GET /api/foods/[fdcId]` → hold per-100g nutrition + serving. Controls: amount field with **g ⇄ serving** segmented toggle (serving disabled when absent), **meal** segmented control (defaults by time of day), live-recomputed macro tiles, **Add** button. Submit → `addFoodAction` → `revalidatePath('/today')` → close. Edit mode pre-fills from the row and shows **Save** + **Delete**.

---

## 8. Request / data flow

```
Add:   /add → search (/api/foods?q=) → tap result
            → sheet fetch (/api/foods/[fdcId])  [rate-limited, warms food_cache]
            → set amount/meal → addFoodAction { fdcId, amountGrams, meal, loggedOn }
            → DAL.logFood: session → snapshot nutrition from food_cache → insert (RLS)
            → revalidate /today → sheet closes → entry visible
Edit:  /today → tap EntryRow → sheet (edit) → editFoodAction / deleteFoodAction → revalidate
View:  /today?date=D → DAL.getDay(D) (RLS) → compute meal groups + totals → render
```

---

## 9. Security & RLS

- `logged_foods`: RLS on, **owner-only** for all of select/insert/update/delete (`auth.uid() = user_id`), mirroring `profiles`. Default-deny everything else.
- Service-role is **not** used for log writes — logging uses the user's authenticated client under RLS (per-user data; service-role would defeat isolation). Service-role stays confined to the public `food_cache` write path from Phase 1.
- Nutrition integrity: server-derived snapshot (§6), never client-supplied.
- Input validation at every Server Action boundary (Zod); `user_id` always from the verified session.
- No secret access added; no new `NEXT_PUBLIC_` values. The sheet's `fetch` hits our own authenticated API routes only.
- CI RLS isolation test extended to cover `logged_foods` (cross-user read/insert/update/delete denied; soft-deleted rows hidden).

---

## 10. Testing (TDD, vitest)

| Suite | Cases |
|---|---|
| `nutrition/compute` | per-entry = per-100g × g/100; servings→grams (and no-serving fallback); `null` stays `null`/contributes 0 with incompleteness flag; day + per-meal sums; rounding only at display. |
| `logged-foods` DAL | `logFood` snapshots nutrition **from cache** (not from input) and inserts with session `user_id`; `editLog` cannot alter `nutrition`/`fdc_id`; `softDeleteLog` sets `deleted_at`; `getDay` returns only the owner's non-deleted rows for the date. |
| Server Actions | Zod rejects bad `amountGrams`/`meal`/`loggedOn`/`fdcId`; `user_id` never sourced from input; happy path calls the DAL and revalidates. |
| RLS (CI) `tests/rls/logged-foods.test.ts` | via `makeUser`: insert own ✓; User B cannot read/insert-as-A/update/delete A's rows; soft-deleted excluded from owner reads when filtered. |
| Components | `compute`-driven render of `DayView`/totals; `QuickAddSheet` recompute on amount/unit change; primitive smoke tests. |

`FDC_API_KEY` not required in CI (food API is Phase-1-tested with mocked fetch; the tracker reads `food_cache`/mocked detail).

---

## 11. Top risks & mitigations

| Risk | Mitigation |
|---|---|
| A log silently changes when USDA data refreshes or the 30-day cache evicts. | Snapshot `nutrition`+`description` into the row at log time; the day view never re-derives from live cache. |
| Forged nutrition via a crafted client request. | Server derives the snapshot from `fdcId` (`food_cache`); client nutrition is ignored. |
| Day-boundary bugs across timezones (an evening log counts to the wrong day). | Client computes `logged_on` (a `date`) in local tz and sends it; server stores it verbatim, plus `logged_at` for audit. |
| servings→grams wrong for `ml`/volume foods (no density). | Enable serving toggle only when a serving size exists; treat `ml` as `g` 1:1 as a documented approximation; grams is always the stored, authoritative amount. |
| New authenticated UI + CSP nonce regressions break the foundation. | All JS is nonce-stamped component code; no inline scripts/styles; reuse the existing `proxy.ts` CSP; verify headers after build. |
| Route rename `/dashboard`→`/today` breaks the auth redirect path. | Update root `/` redirect and `proxy.ts` authed-redirect target together; e2e the login→/today path. |
| Design-system scope creep (a full component library). | Right-sized: ~8 primitives + a token set only; no speculative components; YAGNI. |
| RLS works on cloud but fails on a fresh local CI stack (implicit grants). | Ship **explicit** grants in `0003` (lesson from Phase 1's `0001` grant fix). |

---

## 12. Success criteria (Phase 2 done when…)

1. A logged-in user can search foods, open a result, set grams **or** servings + a meal, and **Add** it to a chosen day via the quick-add sheet.
2. `/today?date=` shows that day's entries grouped by meal with per-meal subtotals, headline macros, and a collapsible full-nutrition panel summing all 14 nutrients (with incompleteness markers).
3. Editing an entry's amount/meal and deleting (soft) an entry both work and the totals update.
4. A logged entry's stored nutrition is unaffected by later USDA/cache changes (snapshot verified in tests).
5. RLS CI proves a user cannot read or write another user's `logged_foods` (cross-user denied); soft-deleted rows are excluded.
6. The app renders in the dark-editorial system with the bottom tab bar; `/login` + `/signup` match; `/dashboard`→`/today` redirect works end-to-end.
7. `pnpm lint && pnpm typecheck && pnpm test` green; deployed to the live Vercel URL.
8. No goals/targets, custom foods, charts, PWA, or offline were built — scope held to the tracker MVP.

---

## Appendix — future hooks (not built now)
- **Overview dashboard** at `/dashboard` (owner-requested): a multi-day/account summary landing; `/today` stays the single-day tab.
- **Goals/targets** table → progress rings on `/today` and the overview.
- The snapshot `fdc_id` + `nutrition.raw` (preserved in `food_cache`) allow re-deriving more nutrients later without relogging.
