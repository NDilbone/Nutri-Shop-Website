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

## Household sharing (Phase 6C)

Members can share a shopping list with a household in addition to their personal list.

### Households

- **Create** a household from `/account` → Household → Create. You become the first member.
- **Invite** by entering a member's email on `/account` → Household → Invite. Invites are in-app only — no email is sent. The invitee sees a pending-invite banner on `/list` and `/account` and can accept or decline there.
- **Accept / decline** from the banner or from `/account` → Household.
- **Leave** from `/account` → Household → Leave. The last member to leave dissolves the household.

### List layout

`/list` shows two sections:

- **Personal** — visible only to you; backed by your personal shopping list.
- **Household · \<name>** — shared with all household members; backed by the household list.

Each section has its own inline add-item form, check-off, and **Clear checked** button. Items can be moved between Personal and Household via the item edit sheet. The Household section appears only when you belong to a household.

### Access and conflict resolution

All members have equal read and write access to the household list. Conflicts resolve by **last-edit-wins** using each client's local edit timestamp. When a remote household change supersedes a local one, the sync status quietly transitions to "Synced" — no intrusive modal or data loss. Offline edits queue and push on reconnect.

### Revocation

When a member leaves (or is the last to leave, dissolving the household), the household list is pruned from their local store on the next sync and the Household section disappears from their `/list`. Queued but unsynced household edits on the departing device are discarded on prune.

## Admin (Phase 6A)

Invite management lives in-app at `/admin`, gated to admin users (`profiles.is_admin`).
Admins can add an invite email (allowlist-only — the invitee then self-signs-up),
see each invite's status (pending / joined / banned), revoke a pending invite, and
**disable** (reversibly ban) or **re-enable** a joined user. Disabling keeps the user's
data and leaves their invite intact (they stay listed so they can be re-enabled);
re-entry is already blocked because their account exists and the ban prevents login.
There is no hard delete.

The **Admin** link appears on `/account` only for admins.

### Bootstrapping the first admin

Migration `0006` ships `is_admin` defaulting to `false`, so no one is an admin until
promoted once by hand. In the Supabase dashboard SQL editor (the surface used to apply
migrations), run:

```sql
update public.profiles
set is_admin = true
where id = (select id from auth.users where email = '<your-admin-email>');
```

This is intentionally not committed (keeps the admin email out of the repo). Grant
further admins the same way.

## Multi-factor authentication (MFA)

Nutri-Shop uses TOTP (authenticator-app) two-factor auth:

- **Admins must use MFA.** An admin with no factor is sent to `/mfa` to set one up before reaching the app; every session is challenged for a 6-digit code.
- **Members may opt in** from **Account → Two-factor authentication → Enable MFA**, and can disable it there.
- **Lost device?** An admin opens **Admin**, finds the user, and clicks **Reset MFA** — the user sets up a new authenticator on next sign-in.
- **Last admin locked out (break-glass):** if the only admin loses their device, delete that user's rows from `auth.mfa_factors` in the Supabase dashboard (or use the Auth admin UI); they can then re-enroll. With more than one admin, a second admin resets the first.

Enforcement is app-layer (no migration): `requireStepUp()` gates the `(app)` layout, every mutating Server Action, and the food API. Confirm the Supabase project uses **asymmetric JWT signing keys** so the proxy verifies the `aal` claim locally (no per-request network call).

## Database migrations
Migrations live in `supabase/migrations/`. On merge to `main`, the **Apply DB migrations**
workflow (`.github/workflows/db-migrate.yml`) runs `supabase db push` against the production
database, applying any not-yet-recorded migrations. It needs the `SUPABASE_ACCESS_TOKEN`,
`SUPABASE_DB_PASSWORD`, and `SUPABASE_PROJECT_REF` repo secrets; add required reviewers to the
`production` environment to gate each apply behind a manual approval. To apply locally instead:
`supabase db push` after `supabase link`.

## Security
Secrets live only in `.env` (gitignored) and Vercel env settings — never in the repo. Auth email links are built from `NEXT_PUBLIC_SITE_URL` (a trusted constant), and Supabase's redirect allowlist must list only your real origins (no wildcards). See `SECURITY.md`.
