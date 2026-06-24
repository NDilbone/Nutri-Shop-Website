# Nutri-Shop — Phase 1: USDA Food Search + Nutrient Detail (design)

**Date:** 2026-06-24
**Status:** Approved design, pending implementation plan
**Predecessor:** [`2026-06-23-nutri-shop-foundation-design.md`](./2026-06-23-nutri-shop-foundation-design.md) (roadmap Phase 1)

**Scope of this spec:** the **backend API only** — wire the stubbed `/api/foods` proxy to the
real USDA FoodData Central (FDC) API, add a two-layer cache, a curated normalized nutrient
model, a per-user rate-limit throttle, and graceful FDC-429 handling. **No UI** is built in this
phase; the search page ships with the Phase 2 tracker that consumes this API. Success is proven
by tests and route responses, not a screen.

---

## 1. Goal & non-goals

### Goal
Turn the foundation's reserved boundary (`app/api/foods/route.ts`, currently `501`) into a
working, authenticated, cached, rate-limited proxy over FDC that returns:
- a **search** result list for a free-text query, and
- a **nutrient detail** record for a single food (`fdcId`) in a stable normalized shape.

### Non-goals (Phase 1 — deferred)
- No search UI / results page / detail page (Phase 2 consumes the API).
- No food logging, diary, or daily totals (Phase 2 — `logged_foods`).
- No favorites, recents, or saved searches.
- No Redis/KV or any external cache service.
- No `cacheComponents` / `use cache` app-wide rendering switch.
- No write of FDC data beyond the cache table.

---

## 2. Verified FDC facts (primary-source grounding)

All facts below were confirmed against primary USDA / api.data.gov sources (see Appendix A for
URLs). Three load-bearing facts were independently re-verified by adversarial check.

| Area | Fact |
|---|---|
| Base URL | `https://api.nal.usda.gov/fdc/v1` |
| Auth | API key as **query parameter** `api_key`. The `X-Api-Key` header is **not** in the FDC spec — do not rely on it. |
| Search | `GET /foods/search` params: `query` (required), `dataType` (array; enum `Branded`/`Foundation`/`Survey (FNDDS)`/`SR Legacy`), `pageSize` (default 50, max 200), `pageNumber`, `sortBy`, `sortOrder`, `brandOwner`. |
| Search response | The spec types it as an array but the live API returns a **single `SearchResult` object** — parse one object. Fields: `totalHits`, `currentPage`, `totalPages`, `foods[]`. |
| `foods[]` | `SearchResultFood`: `fdcId`, `dataType`, `description`, `brandOwner` (Branded), `gtinUpc` (Branded), `ingredients`, `foodNutrients[]` (abridged; top-level `number` = legacy tagnum, not the id). **No `brandName`** on search results. |
| Detail | `GET /food/{fdcId}?format=full` (default `full`). Optional `nutrients=` filter (1–25 numbers). Batch `GET /foods?fdcIds=` (≤20). |
| Detail response | `oneOf` five dataType schemas. **Full** format → `foodNutrients[].nutrient.id` (canonical, e.g. `1005`) + `nutrient.number` (string tagnum, e.g. `"205"`). Match on `nutrient.id`. |
| Branded extras | `labelNutrients{}` (per-**serving** values, camelCase keys, `potassium` is misspelled `postassium`), `servingSize`, `servingSizeUnit`, `householdServingFullText`, `gtinUpc`, `brandOwner`, `ingredients`. `foodNutrients` are per-**100g**. |
| Rate limit | **1,000 requests/hour per IP** for a signed key (`DEMO_KEY` = 30/hr + 50/day). Over → **HTTP 429**, body `{"error":{"code":"OVER_RATE_LIMIT","message":…}}`, ~1-hour rolling block. |
| Rate headers | `X-RateLimit-Limit` and `X-RateLimit-Remaining` on every response. **No documented `Retry-After`** or `X-RateLimit-Reset` — treat `Retry-After` as best-effort only. |
| Other errors | api.data.gov envelope `{"error":{"code":…,"message":…}}`. 403 `API_KEY_*` (missing/invalid/disabled), 400 `HTTPS_REQUIRED`, 404 `NOT_FOUND`. |
| License | Data is **CC0 1.0 public domain**. Storing raw payloads in our own DB and redistributing is legal. Attribution is **requested, not required** — credit "FoodData Central". |

### Nutrient id map (verified against the official `nutrient.csv`)
Match on the FDC **nutrient `id`** (the API's `nutrient.id` in full detail responses):

| Internal key | FDC id | Unit | Notes |
|---|---|---|---|
| `energyKcal` | **1008** | kcal | Foundation foods omit 1008 since Oct-2020 → fall back to **2047** (Atwater General), then **2048** (Atwater Specific). |
| `protein` | 1003 | g | |
| `totalFat` | 1004 | g | |
| `saturatedFat` | 1258 | g | |
| `carbs` | 1005 | g | Carbohydrate, by difference. |
| `fiber` | 1079 | g | |
| `totalSugars` | 2000 | g | "Sugars, total including NLEA". |
| `addedSugars` | 1235 | g | Often absent (Branded/FNDDS mainly). |
| `sodium` | 1093 | mg | |
| `calcium` | 1087 | mg | |
| `iron` | 1089 | mg | |
| `potassium` | 1092 | mg | |
| `cholesterol` | 1253 | mg | |
| `vitaminD` | **1114** | µg | Modern label unit. Fall back to **1110** (IU) only if 1114 absent, flagged as IU. |

> Implementation note: `unitName` comes back **uppercase** (`KCAL`, `G`, `MG`, `UG`, `IU`) — normalize casing. A missing nutrient means the food did **not report it**; represent as `null`, never `0`.

---

## 3. Architecture decisions (locked)

| # | Decision | Rationale |
|---|---|---|
| Scope | Backend API only; no UI. | Phase 2 owns the search screen; Phase 1 proves search→proxy→cache→normalize end-to-end via tests. |
| Cache | **Two-layer**: L1 = Next 16 `unstable_cache` (short TTL, in-memory, request-coalescing); L2 = **Supabase Postgres `food_cache`** (durable, cross-instance, detail only). | Next's in-memory Data Cache is **not durable across Vercel serverless instances**, so Postgres is the real durable layer — and avoids paid Redis/KV. Search results use **L1 only** (queries are unbounded → low hit rate). |
| L1 mechanism | `unstable_cache` (not `use cache`). | `use cache` needs `cacheComponents: true`, an **app-wide** rendering-model switch that would force re-verifying the whole auth foundation. `unstable_cache` is isolated, stable in Next 16, blast radius = the food module. |
| Cache RLS | `food_cache`: RLS on, `authenticated` may **SELECT** (public reference data); **privileged writes only**. | Mirrors the foundation's default-deny posture; reference data is safe to read for any logged-in user. |
| **Privileged write path** | **Cache writes** use a **server-only service-role client** (`lib/supabase/admin.ts`, bypasses RLS); `food_cache` has no authenticated write policy. **Throttle** uses a `SECURITY DEFINER` function (`check_and_increment_rate`) with a **hard-coded** limit/window and identity from `auth.uid()`. | A security review found the earlier "SECURITY DEFINER upsert granted to `authenticated`" let any invited user poison the shared cache, and client-supplied limit/window let a caller reset their own throttle. Service-role-write (cache) + constant-config DEFINER (throttle) close both. Service-role touches only the public reference cache (no per-user data → no IDOR), and lives in `lib/`, never `app/`. |
| Nutrient model | Curated macros + key micros, keyed by FDC nutrient `id`, canonical units; **raw payload stored too**. | Stable contract for Phase 2; raw lets us derive more nutrients later without refetching. |
| Rate limits | Per-user **durable** throttle (Postgres fixed-window fn) **plus** graceful FDC-429 handling. | One authed user can't exhaust the shared 1,000/hr key; durable counter works across serverless instances. |
| dataType default | Search defaults to **Branded + Foundation + SR Legacy** (exclude Survey/FNDDS + Experimental); overridable. | Branded carries real packaged products (GTIN/UPC, brand, label serving) for the shopping-list half; Foundation/SR Legacy give clean generic macros. Survey is derived/noisy; Experimental is non-consumer. |

---

## 4. Module layout

```
lib/fdc/client.ts        server-only FDC HTTP client (searchFoods, getFoodDetail)
lib/fdc/nutrients.ts     canonical id→key map + normalize() → NormalizedNutrition
lib/fdc/cache.ts         L1 unstable_cache + L2 Postgres read (authed) / write (service-role)
lib/supabase/admin.ts    server-only service-role client (cache writes only; never in app/)
lib/validation/fdc.ts    Zod: query params, fdcId, FDC search/detail response schemas
lib/dal/rate-limit.ts    enforceRateLimit() → check_and_increment_rate() DB function (no args)
app/api/foods/route.ts             GET search  (replaces the 501 stub)
app/api/foods/[fdcId]/route.ts     GET detail
supabase/migrations/0002_food_cache.sql   food_cache + api_rate_limit + functions + RLS
```

Each unit has one purpose, a typed interface, and is independently testable. `client.ts` is the
sole reader of `FDC_API_KEY`. `nutrients.ts` is pure (no I/O). `cache.ts` composes client +
DB. Route handlers orchestrate `verifySession → enforceRateLimit → validate → cache → respond`.

---

## 5. Data model — `0002_food_cache.sql`

### `food_cache`
```sql
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
  using ( true );                 -- public reference data; any logged-in user may read
-- No insert/update/delete policy => default-deny. The server writes the cache with the
-- service-role client (bypasses RLS) ONLY after fetching from FDC. There is deliberately NO
-- authenticated-callable write path.

grant select on public.food_cache to authenticated;
grant all    on public.food_cache to service_role;
```

> **Cache writes are server-only via the service-role client** (`lib/supabase/admin.ts`), not a
> SECURITY DEFINER function. An earlier design exposed an `upsert_food_cache` function granted to
> `authenticated`; a security review found it let any invited user write arbitrary rows and poison
> shared nutrition data. Service-role touches only this public reference table (no per-user rows →
> no IDOR), lives in `lib/` (CI greps service-role out of `app/`), and the key never reaches the client.

### `api_rate_limit` (per-user fixed window)
```sql
create table public.api_rate_limit (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  window_start  timestamptz not null default now(),
  request_count int not null default 0
);
alter table public.api_rate_limit enable row level security;
-- No policies => default-deny. Touched only via the SECURITY DEFINER fn below.

-- Limit + window are CONSTANTS, not parameters: a client-tunable window let a caller reset
-- their own counter (p_window_seconds => 0) and defeat the throttle.
create or replace function public.check_and_increment_rate()
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_limit          constant int := 60;
  v_window_seconds constant int := 60;
  uid uuid := (select auth.uid());   -- identity from the session, never from client input
  allowed boolean;
begin
  if uid is null then return false; end if;
  insert into public.api_rate_limit (user_id, window_start, request_count)
    values (uid, now(), 1)
  on conflict (user_id) do update set
    window_start  = case when public.api_rate_limit.window_start
                              < now() - make_interval(secs => v_window_seconds)
                         then now() else public.api_rate_limit.window_start end,
    request_count = case when public.api_rate_limit.window_start
                              < now() - make_interval(secs => v_window_seconds)
                         then 1 else public.api_rate_limit.request_count + 1 end
  returning (request_count <= v_limit) into allowed;
  return allowed;
end; $$;
grant execute on function public.check_and_increment_rate() to authenticated;
```

RLS coverage for both new tables is added to the CI isolation suite (§9).

---

## 6. Nutrient model (the stable Phase-2 contract)

```ts
type NutrientValue = { amount: number | null; unit: string };

type NormalizedNutrition = {
  basis: '100g';                      // canonical macro/micro basis
  serving?: {                         // Branded only
    amount: number; unit: string; household: string | null;
  };
  nutrients: {
    energyKcal: NutrientValue; protein: NutrientValue; totalFat: NutrientValue;
    saturatedFat: NutrientValue; carbs: NutrientValue; fiber: NutrientValue;
    totalSugars: NutrientValue; addedSugars: NutrientValue; sodium: NutrientValue;
    calcium: NutrientValue; iron: NutrientValue; potassium: NutrientValue;
    cholesterol: NutrientValue; vitaminD: NutrientValue;
  };
};
```
- `normalize(detail)` matches each curated key on `nutrient.id` (full format), applying the
  energy Atwater fallback and the vitamin-D µg→IU fallback.
- Missing nutrient → `{ amount: null, unit }`. Never coerce to `0`.
- Branded: the canonical `nutrients` come from `foodNutrients` (per-100g); `serving` +
  `labelNutrients` (per-serving) are preserved in `raw` for Phase 2 to surface later.

---

## 7. Request flow & contracts

### Search — `GET /api/foods?q=&dataType=&page=`
1. `requireUser()` (route is **not** gated by `proxy.ts` — it self-gates).
2. `enforceRateLimit()` → 429 on exceed.
3. Validate: `q` required (1–100 chars); `dataType` ⊆ {`Branded`,`Foundation`,`SR Legacy`}, default all three; `page` ≥ 1.
4. `unstable_cache(() => searchFoods(...), ['foods-search', q, dataType, page], { revalidate: 120 })`.
5. Map to slim results and respond `200`:
```jsonc
{ "query": "cheddar", "page": 1, "totalHits": 1034,
  "results": [ { "fdcId": 534358, "description": "...", "dataType": "Branded",
                 "brandOwner": "...", "gtinUpc": "..." } ] }
```

### Detail — `GET /api/foods/[fdcId]`
1. `requireUser()` → `enforceRateLimit()`.
2. Validate `fdcId` (positive integer).
3. **L2**: select `food_cache` by `fdc_id`; if present and `fetched_at` within the refresh window (**30 days** — CC0 data is effectively immutable per id) → return it.
4. Miss → `unstable_cache(() => getFoodDetail(fdcId), ['foods-detail', fdcId], { revalidate: 900 })`.
5. `normalize()` → service-role upsert into `food_cache` → respond `200`:
```jsonc
{ "fdcId": 534358, "description": "...", "dataType": "Branded",
  "nutrition": { "basis": "100g", "serving": { "amount": 28, "unit": "g", "household": "1 ONZ" },
                 "nutrients": { "energyKcal": { "amount": 140, "unit": "kcal" }, "...": "..." } } }
```

---

## 8. Error handling (never leak the key)

**Default tunables** (all configurable in one place): per-user throttle **60 requests / 60 s
window**; search L1 TTL **120 s**; detail L1 TTL **900 s**; L2 refresh window **30 days**; default
search dataTypes **Branded + Foundation + SR Legacy**.

All error responses use `{ "error": { "code": "<CODE>", "message": "<safe text>" } }`.

| Condition | Status | Code |
|---|---|---|
| Unauthenticated | redirect `/login` (page) / `401` (api) | `UNAUTHENTICATED` |
| Invalid params | `400` | `INVALID_REQUEST` |
| Per-user throttle exceeded | `429` | `RATE_LIMITED` |
| FDC over-limit (`OVER_RATE_LIMIT`) | detail: serve **stale cache** `{ "stale": true }` if a row exists, else `429`; search: `429` | `UPSTREAM_RATE_LIMITED` |
| FDC key missing / `403 API_KEY_*` | `503` | `UPSTREAM_UNAVAILABLE` |
| FDC `5xx` / network | `502` | `UPSTREAM_ERROR` |
| `fdcId` not found (`404`) | `404` | `NOT_FOUND` |

- Read `X-RateLimit-Remaining`; when below a threshold, `console.warn` (observability hook for Phase 6).
- `Retry-After` is forwarded to the client **only if** the upstream actually sent it.
- Raw upstream error bodies and the API key are never included in any response.

---

## 9. Testing (TDD, vitest)

| Suite | Cases |
|---|---|
| `nutrients` | per-dataType fixtures (Foundation w/ Atwater 2047, Branded w/ labelNutrients + per-100g, SR Legacy); missing nutrient → `null`; vitD µg vs IU fallback; energy fallback chain; uppercase unit normalization. |
| `client` | mock `fetch`: correct URL + `api_key` + `format=full`; 200 parse; 429 → typed `UpstreamRateLimited`; 403 → typed key error; malformed body → Zod error; key-missing → typed 503 error. |
| `cache` | L2 hit skips `fetch`; L2 miss → fetch + service-role upsert; stale-on-429 path returns cached row with `stale:true`. |
| `rate-limit` | DAL calls `check_and_increment_rate()` (no args); maps `false` → `RateLimitError`; rpc error → throw. |
| routes | unauth → 401; throttled → 429; invalid params → 400; happy search + detail (mocked client). |
| RLS (CI) | `food_cache`: authenticated can SELECT, cannot INSERT directly, and the removed `upsert_food_cache` RPC errors (poisoning closed). `api_rate_limit`: default-deny (seed-then-deny). `check_and_increment_rate()` rejects forged args, returns true≤limit then false, resets after window. |

The existing `tests/api/foods.test.ts` (501 stub) is replaced by real coverage. `FDC_API_KEY` is
**not** required in CI — `fetch` is mocked; the key-missing path is itself a tested branch.

---

## 10. Top risks & mitigations

| Risk | Mitigation |
|---|---|
| FDC schema drift / spec inaccuracies (array-vs-object, misspelled `postassium`, `nutrient.number` string-vs-int across abridged/full). | Lenient Zod parsing (`.passthrough()`/optional), match on `nutrient.id`, store `raw`, fixtures per dataType in tests. |
| Shared 1,000/hr key exhausted by one user. | Per-user durable throttle (`check_and_increment_rate`) + L1/L2 cache minimizing upstream calls. |
| Key leak. | Read only in `lib/fdc/client.ts` + `import 'server-only'`; never in `NEXT_PUBLIC_`, responses, or logs. |
| Cache poisoning by an invited user (a write fn granted to `authenticated`). | No authenticated write path. Cache writes use the service-role client in `lib/` only, after fetching from FDC. (Security-review finding; original DEFINER-upsert design removed.) |
| Throttle bypass via client-tunable limit/window. | `check_and_increment_rate()` takes no arguments; limit + window are SQL constants. (Security-review finding.) |
| Service-role exposure. | Service-role client lives in `lib/supabase/admin.ts` (`import 'server-only'`), used only for the public `food_cache` write (no per-user data → no IDOR); CI greps `SERVICE_ROLE` out of `app/`. |
| `unstable_cache` in-memory not durable across Vercel instances. | Durable layer is Postgres `food_cache`, not the in-memory cache. |
| Caching authed/secret data by accident. | Only public CC0 reference data is cached; no per-user data in `food_cache`; no auth tokens in cache keys. |
| Missing nutrient mis-read as zero. | `null` sentinel enforced + unit-tested. |

---

## 11. Success criteria (Phase 1 done when…)

1. An authenticated user can `GET /api/foods?q=…` and receive a typed search list; an
   unauthenticated request is rejected (401/redirect).
2. `GET /api/foods/{fdcId}` returns the normalized nutrient model; a second call for the same id
   is served from `food_cache` without an FDC request (verified in tests).
3. A single user exceeding the per-user window receives `429 RATE_LIMITED`; the window resets.
4. An FDC `429` degrades gracefully (stale cache or clean `429`), never a `500`, never a leaked key.
5. The FDC key appears nowhere in responses, logs, the client bundle, or the repo.
6. RLS CI proves `food_cache` is authed-read-only and `api_rate_limit` is default-deny.
7. `pnpm lint && pnpm typecheck && pnpm test` is green; the 501 stub and its test are gone.
8. No UI and no Phase-2 features were added — scope held to the backend.

---

## Appendix A — primary sources

- FDC OpenAPI spec: `https://fdc.nal.usda.gov/api-spec/fdc_api.yaml` (and `.json`)
- FDC API Guide (rate limits, license, dataTypes): `https://fdc.nal.usda.gov/api-guide/`
- FDC data documentation: `https://fdc.nal.usda.gov/data-documentation/`
- Branded foods (GBFPD) docs: `https://fdc.nal.usda.gov/GBFPD_Documentation/`
- FDC FAQ (Atwater energy 2047/2048): `https://fdc.nal.usda.gov/faq/`
- api.data.gov rate limits / developer manual: `https://api.data.gov/docs/rate-limits/`, `https://api.data.gov/docs/developer-manual/`
- Nutrient id verification: official `nutrient.csv` (FoodData_Central supporting data, public domain)
- Next.js 16 caching (`unstable_cache`, Data Cache durability caveat): `https://nextjs.org/docs/app/getting-started/caching-and-revalidating`
- License: CC0 1.0 — `https://creativecommons.org/publicdomain/zero/1.0/`
