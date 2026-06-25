# Nutri-Shop

Private, invite-only nutrition tracker and shopping-list app. Not e-commerce; no payments.

## Stack
Next.js 16 (App Router) · Supabase (Postgres + Auth, Row Level Security) · TypeScript · Tailwind 4 · Vercel.

## Local setup
1. Install Node 24 LTS and enable pnpm: `corepack enable && corepack prepare pnpm@11.9.0 --activate`
2. `pnpm install`
3. Copy env: `cp .env.example .env` and fill in values from your Supabase project (Settings → API). Set `NEXT_PUBLIC_SITE_URL` to your origin (e.g. `http://localhost:3000` locally).
4. Start Supabase locally (for tests): `supabase start`
5. `pnpm dev` → http://localhost:3000

## Scripts
- `pnpm dev` / `pnpm build` / `pnpm start`
- `pnpm lint` · `pnpm typecheck` · `pnpm test`

## Food API (Phase 1)

Authenticated JSON endpoints backed by USDA FoodData Central (FDC), cached and rate-limited.

- `GET /api/foods?q=<query>&dataType=<csv>&page=<n>` — search (defaults to Branded + Foundation + SR Legacy).
- `GET /api/foods/{fdcId}` — normalized nutrient detail for one food.

Both require a signed-in session and apply a per-user request throttle. Set `FDC_API_KEY`
(see `.env.example`) for live data; without it the endpoints return `503`.

Data source: **USDA FoodData Central** (public domain, CC0 1.0).

## Tracker (Phase 2)

The macro/micro tracker UI, built on the Phase 1 food API. Phone-first, with a bottom tab bar.

- `/today?date=<YYYY-MM-DD>` — day view: entries grouped by meal with per-meal subtotals, headline calories + protein/carbs/fat, and a collapsible full-nutrition panel (all 14 nutrients; `*` marks days where a food didn't report a nutrient). Defaults to the local current day; navigate days with the date control.
- `/add` — search USDA foods and log an entry through a quick-add sheet (amount in grams or servings, assigned to a meal). Reached from the tab bar's “+”.
- `/account` — profile and sign out.

Logged entries live in `logged_foods` (per-user, Row Level Security). Each row **snapshots** the food's per-100g nutrition at log time, so a logged day stays accurate even if the upstream USDA data later changes. The former `/dashboard` route is now `/today`.

## Shopping list (Phase 3)

Per-user shopping list built on the Phase 1/2 foundation.

- `/list` — items grouped by aisle category, with check-off (checked items move to a struck-through "Checked" section) and a one-tap **Clear checked** button. Items add three ways: inline on `/list`, via the center **＋** chooser, or from a USDA food's detail sheet (the last carries the food's `fdc_id` and name). Free-text items support an optional quantity and category.

Edit and single-item delete work; removed items are soft-deleted (`deleted_at`). The list lives in `shopping_lists` and `shopping_list_items` (per-user, Row Level Security); it is built to go offline in a later phase.

## Database migrations
Migrations live in `supabase/migrations/`. On merge to `main`, the **Apply DB migrations**
workflow (`.github/workflows/db-migrate.yml`) runs `supabase db push` against the production
database, applying any not-yet-recorded migrations. It needs the `SUPABASE_ACCESS_TOKEN`,
`SUPABASE_DB_PASSWORD`, and `SUPABASE_PROJECT_REF` repo secrets; add required reviewers to the
`production` environment to gate each apply behind a manual approval. To apply locally instead:
`supabase db push` after `supabase link`.

## Security
Secrets live only in `.env` (gitignored) and Vercel env settings — never in the repo. Auth email links are built from `NEXT_PUBLIC_SITE_URL` (a trusted constant), and Supabase's redirect allowlist must list only your real origins (no wildcards). See `SECURITY.md`.
