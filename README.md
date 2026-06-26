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

## PWA (Phase 4)

Nutri-Shop is an installable Progressive Web App.

- **Android / desktop Chromium (Chrome, Edge, Brave):** an install button appears in the app shell when the browser fires `beforeinstallprompt`. Click it to install natively. The URL-bar install icon works as usual.
- **iOS Safari:** a hint prompts you to use Share → "Add to Home Screen". (iOS does not support `beforeinstallprompt`.)
- **Offline fallback:** when a document navigation fails offline the service worker serves a branded `/~offline` page. The SW caches **only static build assets and `/~offline`** — no authenticated HTML, RSC payloads, or API responses are ever stored.

### Icons

Icons live in `public/icons/` and are generated from a single master file:

```bash
pnpm gen:icons          # regenerates public/icons/* from assets/icon-master.svg
```

To rebrand: replace `assets/icon-master.svg` with your own 512×512 SVG and re-run `pnpm gen:icons`. Commit the generated PNGs.

## Scripts
- `pnpm dev` — development server (Turbopack; service worker disabled in dev)
- `pnpm build` — production build (`next build --webpack`; **webpack is required** — Serwist's SW plugin does not run under Next 16's default Turbopack bundler). Emits `public/sw.js`.
- `pnpm start` — serve the production build locally (SW active; use this to test offline behaviour)
- `pnpm gen:icons` — regenerate PWA icons from `assets/icon-master.svg`
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

Edit and single-item delete work; removed items are soft-deleted (`deleted_at`). The list lives in `shopping_lists` and `shopping_list_items` (per-user, Row Level Security).

## Offline shopping list (Phase 5)

The shopping list works fully offline and syncs on reconnect. See [`docs/superpowers/specs/2026-06-25-nutri-shop-offline-sync-design.md`](docs/superpowers/specs/2026-06-25-nutri-shop-offline-sync-design.md) for the full design.

### Storage & encryption

- **Local-first:** `/list` is backed by a per-user **encrypted IndexedDB store** (Dexie, named `ns-list-<userId>`), which is the client's source of truth. Sync is read-reactive via `useLiveQuery`.
- **Encryption:** item content fields (name, quantity, category, fdcId, checked) are encrypted at rest with AES-GCM. The encryption key is a non-extractable Web Crypto `CryptoKey`, stored in the database's `keyv` table.
- **Lifecycle:** the store is created on sign-in and **wiped on sign-out**. When you switch accounts on the same device, any unmatched store is purged on app boot.
- **Safety on sign-out:** if you have unsynced edits when signing out, the app pushes them to the server when online, or asks you to confirm before wiping when offline.

### Sync

- **Trigger:** sync runs in the **foreground only** — on app launch, when connectivity returns, when the app comes to the foreground, and automatically (debounced) after each local change while online.
- **Engine:** one Server Action (authenticated with the session cookie) batches push + pull in a single round trip: first push unsynced edits via a `sync_shopping_items` RPC (last-edit-wins upsert, RLS-gated), then pull changes since the last `updated_at` cursor.
- **Conflict resolution:** conflicts resolve via **last-edit-wins**, using the client's `edited_at` timestamp (real edit time). The server's `updated_at` is the pull cursor.
- **Scope:** **only the shopping list is offline-capable**; macro logging (`/today`, `/add`) stays online-only.

### Local testing

The service worker (including the offline `/list` shell) only activates in a **production build**. To test offline behavior locally:

```bash
pnpm build && pnpm start
```

Do **not** test offline with `pnpm dev` — the SW is disabled in development.

### Related changes

- Migration `0005` adds the sync RPC and timestamp fields.
- The `.github/workflows/db-migrate.yml` and `rls.yml` workflows run on migration or DAL changes to keep RLS in sync.

## Database migrations
Migrations live in `supabase/migrations/`. On merge to `main`, the **Apply DB migrations**
workflow (`.github/workflows/db-migrate.yml`) runs `supabase db push` against the production
database, applying any not-yet-recorded migrations. It needs the `SUPABASE_ACCESS_TOKEN`,
`SUPABASE_DB_PASSWORD`, and `SUPABASE_PROJECT_REF` repo secrets; add required reviewers to the
`production` environment to gate each apply behind a manual approval. To apply locally instead:
`supabase db push` after `supabase link`.

## Security
Secrets live only in `.env` (gitignored) and Vercel env settings — never in the repo. Auth email links are built from `NEXT_PUBLIC_SITE_URL` (a trusted constant), and Supabase's redirect allowlist must list only your real origins (no wildcards). See `SECURITY.md`.
