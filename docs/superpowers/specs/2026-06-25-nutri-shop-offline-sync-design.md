# Nutri-Shop — Phase 5: offline shopping list + sync (design)

**Date:** 2026-06-25
**Author:** NDilbone
**Status:** Approved design, pending implementation plan
**Predecessor:** [`2026-06-25-nutri-shop-pwa-desktop-design.md`](./2026-06-25-nutri-shop-pwa-desktop-design.md) (Phase 4) · [`2026-06-24-nutri-shop-shopping-list-design.md`](./2026-06-24-nutri-shop-shopping-list-design.md) (Phase 3) · [`2026-06-24-nutri-shop-macro-tracker-design.md`](./2026-06-24-nutri-shop-macro-tracker-design.md) (Phase 2) · [`2026-06-24-nutri-shop-usda-food-search-design.md`](./2026-06-24-nutri-shop-usda-food-search-design.md) (Phase 1) · foundation [`2026-06-23-nutri-shop-foundation-design.md`](./2026-06-23-nutri-shop-foundation-design.md)

**Scope of this spec:** roadmap Phase 5 — the original v1 promise that Phase 4 deferred: *"the shopping list must work OFFLINE in-store, and sync on reconnect."* This phase makes **only the shopping list** a local-first, offline-capable surface backed by an encrypted on-device store, with a foreground sync engine that reconciles with the server using last-edit-wins. **Macro logging stays online-only** (an explicit v1 decision); `/today`, `/add`, and `/account` are untouched.

Phase 4 made the app installable and gave it a privacy-safe service worker that caches **zero authenticated data**. Phase 5 must add a *deliberate* on-device data store without re-opening that hole — so the central design problem is reconciling "the list must render and mutate offline" with "no authed data leaks on the device." The answer (below): the data lives in an **encrypted, per-user IndexedDB store wiped on sign-out**, while the service worker still caches only **data-free** shells and static assets.

---

## 1. Goal & non-goals

### Goal
A logged-in user opens the installed app in a store with no signal, sees their current shopping list, and can **add, check off, edit, delete, and clear** items — all instantly, all persisted locally. When the device regains connectivity (or the app is reopened online), those changes **sync to the server automatically**, and any changes made on the user's other device are pulled in. A change made on two of the user's own devices resolves deterministically (the newer real-world edit wins) with no silent data loss in the common case.

### Non-goals (Phase 5 — deferred)
- **Offline macro logging** — `logged_foods` stays online-only. (Its schema is already offline-ready, so a future phase can extend this engine to it; nothing here pre-empts that. The nutrition-snapshot-needs-a-network-fetch wrinkle is the reason it is out now.)
- **Shared / household lists** — Phase 6. Phase 5 lists remain **per-user, owner-only** (RLS unchanged). This is what keeps conflict resolution simple: the only writer of a given list is its single owner, on at most a few devices.
- **Background Sync API / Periodic Sync** — rejected this phase (Chromium-only → useless on the fiancé's iPhone; and it would pull authed-write replay + the encryption key *into* the service worker, against Phase 4's "SW handles no authed data" invariant). Sync is **foreground-only**.
- **Multiple named lists, reordering, staple presets** — still deferred (Phase 3 non-goals carry forward).
- **CRDTs / operational transforms / field-level merge** — overkill for a single-owner list; last-edit-wins at the row level is sufficient and far simpler to verify.
- **A second encryption factor (passphrase/PIN)** — considered and rejected for UX cost; the local store uses a non-extractable device key (§4).
- **Offline USDA food search** — the "Add to list" path from a USDA result requires a network food lookup; offline, the user adds free-text items (name + optional quantity + aisle), which is the real in-store need. No `fdc_id` is set on offline-created items unless the lookup succeeded online.

---

## 2. Decisions locked

| # | Decision | Rationale |
|---|----------|-----------|
| Offline scope | **Shopping list only.** Macro logging stays online. | Original v1 decision; smallest correct surface; matches the actual in-store use case. |
| Source of truth (client) | **Local-first:** an encrypted IndexedDB store (Dexie) is the client's source of truth for the list. The server is a sync peer. | The only way `/list` renders and mutates with no network. Online users get near-instant local reads. |
| Local store engine | **`dexie` + `dexie-react-hooks`** (both pinned to latest stable at install — verify on npm). | The phase was planned around Dexie; a maintained IndexedDB wrapper with a reactive `useLiveQuery` fits "minimize custom code." Raw IndexedDB rejected (more hand-rolled glue). |
| Encryption | **AES-GCM, content fields encrypted at rest**; key is a **non-extractable `CryptoKey`** generated via Web Crypto, stored in the DB's keyval store. | Owner chose encrypt-at-rest; non-extractable key defends against casual inspection, other extensions/origins, profile-backup leakage, and forensic-lite recovery — at zero UX cost. (No client scheme defends against malware running as the user; that is out of scope for any browser app.) |
| Store lifecycle | **Per-user DB** (`ns-list-<userId>`); **deleted on sign-out and on user-switch**. | Keeps one user's list off another's session on the same device; bounds the blast radius of the local store. |
| Sign-out safety | **Warn / sync-first on sign-out with unsynced edits:** push pending changes when online, or require an explicit confirm when offline, before wiping. | The local store is wiped on sign-out; unsynced edits must never vanish silently. |
| Conflict resolution | **Last-edit-wins by client `edited_at`.** | Owner's pick. Respects real edit order even when a stale edit syncs later. Adds never conflict (client-minted UUID). |
| Two timestamps | **`updated_at` = server time (pull cursor); `edited_at` = client time (conflict tiebreak).** | Server-time cursor is immune to device clock skew (reliable "what changed since I pulled"); client-time `edited_at` honors the real-world edit order the user cares about. |
| Sync mechanism | **One `security invoker` RPC** does the batched last-edit-wins upsert; a Server Action wraps push (RPC) + pull (`getChangesSince`) in one round trip. | Atomic LWW, minimal client branching, **RLS still gates every row** (no privilege escalation, no service-role). |
| Sync triggers | **Foreground:** app launch (online), `online` event, `visibilitychange` → visible, and debounced after each local change when online. | Works identically on iPhone and Android/desktop; keeps the SW dumb. |
| Re-auth for sync | **Reuse the existing session cookie** via the Server Action (no browser Supabase client activated). On expiry: keep the queue, prompt re-login, resume. | Minimal new security surface; the cookie-authed Server Action already re-verifies with `getUser()` at the DAL boundary. |
| `/list` shell | **Data-free client shell**, runtime-cached by the SW so it loads offline. Data comes from Dexie at runtime, never from server-rendered HTML. | Lets the SW cache the shell for offline navigation **without** caching any authed data — the invariant holds because the shell contains none. |

---

## 3. Architecture

### 3.1 The shape, end to end
```
        ┌─────────────────────────── client (browser / installed PWA) ───────────────────────────┐
        │                                                                                          │
  /list shell (data-free, SW-cached) ──mounts──▶ ListView (client)                                 │
        │                                          │  reads  ▲ writes                              │
        │                                   useLiveQuery     │                                     │
        │                                          ▼          │                                    │
        │                              ┌───── Dexie: ns-list-<userId> (encrypted) ─────┐           │
        │                              │  items · meta(cursor,listId) · key(CryptoKey) │           │
        │                              └───────────────┬───────────────────────────────┘          │
        │                                              │ dirty rows ▲ pulled rows                  │
        │                                       sync engine (foreground triggers)                  │
        └──────────────────────────────────────────────┼──────────────────────────────────────────┘
                                                        │  syncShoppingList() Server Action (cookie auth)
                                                        ▼
                                   push: rpc sync_shopping_items(dirty)   ── LWW upsert, RLS-gated
                                   pull: getChangesSince(cursor)          ── rows incl. tombstones
                                                        │
                                              Supabase Postgres (RLS owner-only)
```
`/today`, `/add`, `/account` keep their existing server-rendered, online-only flow. Nothing in this diagram touches them.

### 3.2 Local store — Dexie (`lib/offline/db.ts`)
One Dexie database **named per user** so a sign-out/user-switch can't cross data:
```ts
// db name: `ns-list-${userId}`
db.version(1).stores({
  items: "id, listId, dirty, updatedAt",  // dirty stored as 0/1 (Dexie can't index booleans)
  meta:  "key",                            // pullCursor, defaultListId, ownerId
  keyv:  "id",                             // the non-extractable CryptoKey (id: "aes")
});
```
A stored `items` row keeps **sync-control fields in clear** (non-sensitive) and the **user-content fields encrypted**:
```ts
type StoredItem = {
  id: string;            // UUID PK (server or client-minted)   — clear
  listId: string;        // FK to the default list (a UUID)     — clear
  updatedAt: string;     // server time, the pull high-water mark — clear
  editedAt: string;      // client edit time, LWW tiebreak       — clear
  deletedAt: string | null; // tombstone                         — clear
  dirty: 0 | 1;          // needs push                           — clear
  serverKnown: 0 | 1;    // has been confirmed on the server     — clear
  iv: Uint8Array;        // AES-GCM nonce (per write)            — clear
  cipher: ArrayBuffer;   // AES-GCM( {name,quantity,category,fdcId,checked} ) — ENCRYPTED
};
```
Timestamps, flags, and opaque UUIDs are not sensitive; the item's **name/quantity/category/fdcId/checked** (the actual list content) are encrypted. Sync bookkeeping (find dirty rows, compare timestamps, advance the cursor) runs without decrypting; only **display** decrypts.

### 3.3 Encryption (`lib/offline/crypto.ts`)
- On first use of a user's DB, generate `crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, /*extractable*/ false, ["encrypt","decrypt"])` and store the resulting `CryptoKey` object in `keyv` (`id: "aes"`). A non-extractable `CryptoKey` is structured-cloneable into IndexedDB **without** its raw bytes ever being exposed to JS or written in readable form.
- `encryptContent(obj)` → `{ iv, cipher }` with a fresh 12-byte random IV per write; `decryptContent(iv, cipher)` → the content object. Failure to decrypt (corrupt/foreign blob) drops the row and forces a re-pull rather than throwing into the UI.
- The key dies with the DB on sign-out (§3.7), so there is no key-rotation or key-persistence problem; a fresh login mints a new key and re-pulls.

### 3.4 Read path — `/list` becomes a data-free client shell
- `app/(app)/list/page.tsx` renders `<ListView />` **with no item props** and makes **no `getItems()` call**. The server emits only the chrome/skeleton; the document carries **no list data**. (The `(app)` layout's `requireUser()` gate stays — online, an unauthenticated user is still redirected by the proxy/layout; offline, the SW serves the cached shell and the per-user encrypted Dexie is the only data source, so a signed-out user simply has nothing.)
- `ListView` (client) reads the list reactively with `useLiveQuery(() => listItemsForDisplay())`, which decrypts and returns the live items; Dexie pushes updates to the component on every local write, so optimistic UI is automatic and **durable** (survives refresh) — replacing the Phase 3 ephemeral `useState` mirror.
- Grouping by aisle category and the checked/unchecked split (the existing `lib/shopping/group.ts`) run client-side on the decrypted items, unchanged.
- **First run (empty Dexie, online):** the shell mounts, the sync engine pulls the full list from the server and populates Dexie; a brief skeleton shows until the first liveQuery resolves. **Warm store:** the list paints from local IndexedDB near-instantly. (Tradeoff: online users lose server-side-rendered initial list HTML in exchange for offline capability and instant warm reads — accepted with the local-first decision.)

### 3.5 Write path — local-first, durable, queued
Every mutation (inline add, ItemSheet add/edit, toggle check, delete, clear-checked) performs a **single local transaction**:
1. Apply the change to the Dexie `items` row (encrypting content), set `editedAt = new Date().toISOString()`, set `dirty = 1`. Deletes set `deletedAt` (soft-delete, mirroring the server). Offline-created items get a **client-minted `crypto.randomUUID()`** and `serverKnown = 0`.
2. `useLiveQuery` re-renders `ListView` from Dexie immediately.
3. If online, the post-change debounced trigger kicks the sync engine (§3.6); if offline, the row simply stays `dirty` until a trigger fires.

There is **no `revalidatePath('/list')`** anymore — the list no longer round-trips the server to repaint. The three Phase 3 add entry points (inline row, ＋ chooser → ItemSheet, USDA "Add to list") all funnel through the same local-write helper; only the USDA path may set `fdcId`, and only when its online lookup succeeded.

### 3.6 Sync engine (`lib/offline/sync.ts`)
Triggered (all foreground) by: app launch when `navigator.onLine`, the `online` event, `visibilitychange`→visible, and a debounced call after each local mutation when online. A single in-flight guard prevents overlapping runs; runs are idempotent so a missed/duplicated trigger is harmless. Each run:

1. **Collect** dirty rows from Dexie (`where dirty = 1`), decrypt their content, and shape them as the server item payload (snake_case columns, including `id`, `list_id`, `edited_at`, `deleted_at`).
2. **Push + pull in one Server Action call**, `syncShoppingList({ dirtyItems, cursor })`:
   - **Push:** `supabase.rpc("sync_shopping_items", { p_items })` — the batched last-edit-wins upsert (§3.8). RLS gates every row.
   - **Pull:** `getChangesSince(cursor)` returns all of the user's list + item rows with `updated_at > cursor`, **including tombstones** (`deleted_at` set), plus a new cursor.
3. **Reconcile** the pulled rows into Dexie with last-edit-wins:
   - local missing → insert (encrypt, `dirty = 0`, `serverKnown = 1`).
   - local exists and `dirty = 0` → take server (server is authority for rows the user hasn't locally touched).
   - local exists and `dirty = 1` → compare: `server.edited_at > local.edited_at` ⇒ **server wins** (overwrite, clear `dirty`; the local edit was superseded — optional quiet toast); else **local wins** (keep `dirty`; it pushes next run).
   - server tombstone wins per the same rule → the row is dropped from display.
4. **Mark pushed rows** `serverKnown = 1`, `dirty = 0` on a successful push (the pull in the same call returns their now-server-stamped `updated_at`, advancing the cursor correctly).
5. **Advance** `meta.pullCursor` to the server-returned cursor.

**Connectivity** is exposed to the UI via a `useOnlineStatus()` hook built on `useSyncExternalStore` over the `online`/`offline` events (consistent with the project's existing `useSyncExternalStore` usage in `DateNav`).

**Re-auth:** `syncShoppingList` calls `requireUser()` at the boundary; the cookie rides along automatically. If the session has expired, the action throws an auth error → the engine stops, leaves all rows `dirty` (nothing lost), and the UI surfaces a "sign in to sync" affordance. After re-login a trigger fires and the queue drains.

### 3.7 Sign-out & user-switch (wipe the local store — safely)
Server sign-out cannot clear client IndexedDB, so sign-out is a **client-wrapped** flow that guards unsynced work first:
1. **No `dirty` rows** → wipe and sign out immediately (no friction — the common case).
2. **Dirty rows + online** → run one sync (push) first; on success, wipe and sign out.
3. **Dirty rows + offline (or the push failed)** → warn *"N unsynced change(s) will be lost"* and require an explicit confirm; confirm → wipe and sign out, cancel → stay signed in.

The wipe itself is `await db.delete()` (drops the entire `ns-list-<userId>` DB, encryption key included), **then** navigation to the existing `/auth/signout` route. On app boot the shell also deletes any `ns-list-*` database **whose name does not match the current user** (defense against an interrupted sign-out and against user-switch on a shared device) — isolation relies on the per-user DB name, not a separately persisted `ownerId` field. The current `userId` is passed from the `(app)` layout (the user's own id from their session — not sensitive) into the client provider that owns the DB handle. The pure decision — `(dirtyCount, online)` → `wipe | sync-then-wipe | confirm-then-wipe` — is unit-tested (§7).

### 3.8 Server / DB changes — migration `0005_offline_sync.sql`
Additive, safe, and the **first schema change since Phase 3** (so `db-migrate.yml` and `rls.yml` run this phase — they were path-skipped in Phase 4):
```sql
-- Two clocks: updated_at (server, trigger now()) is the pull cursor;
-- edited_at (client) is the last-edit-wins tiebreak.
alter table public.shopping_lists      add column edited_at timestamptz not null default now();
alter table public.shopping_list_items add column edited_at timestamptz not null default now();

-- Batched last-edit-wins upsert. SECURITY INVOKER => runs as the calling
-- `authenticated` role, so the existing RLS policies gate every row
-- (insert WITH CHECK + update USING/WITH CHECK on list ownership). No service-role.
create or replace function public.sync_shopping_items(p_items jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  insert into public.shopping_list_items
    (id, list_id, name, quantity, category, fdc_id, checked, deleted_at, edited_at)
  select (e->>'id')::uuid, (e->>'list_id')::uuid, e->>'name', e->>'quantity',
         e->>'category', nullif(e->>'fdc_id','')::bigint, (e->>'checked')::boolean,
         nullif(e->>'deleted_at','')::timestamptz, (e->>'edited_at')::timestamptz
  from jsonb_array_elements(p_items) as e
  on conflict (id) do update set
    name = excluded.name, quantity = excluded.quantity, category = excluded.category,
    fdc_id = excluded.fdc_id, checked = excluded.checked,
    deleted_at = excluded.deleted_at, edited_at = excluded.edited_at
  where excluded.edited_at > public.shopping_list_items.edited_at;  -- LWW guard
end;
$$;

grant execute on function public.sync_shopping_items(jsonb) to authenticated;
```
- The existing `set_updated_at()` BEFORE-UPDATE trigger still bumps `updated_at = now()` on every applied update (the cursor stays server-authoritative); inserts take the `updated_at` default. The LWW guard lives on the `DO UPDATE … WHERE` clause, so a stale incoming edit is silently skipped (server's newer value kept).
- A crafted row pointing at another user's `list_id` fails the insert/update `WITH CHECK` (RLS) and aborts the batch — the only safe outcome; clients only ever send their own list's rows.
- **Pull** is a new DAL function `getChangesSince(cursor)` (`lib/dal/shopping-list.ts`): selects `shopping_lists` + `shopping_list_items` where `updated_at > cursor` ordered ascending, **without** the `deleted_at IS NULL` filter that `getItems()` uses (tombstones must sync). RLS scopes both to the owner. The new cursor is the max `updated_at` returned (or the prior cursor if nothing changed).
- `getItems()` (the `deleted_at IS NULL`, render-time read) is no longer used to render `/list`; it remains for any server-side need and for tests. No other DAL signatures change.

---

## 4. Security plumbing (load-bearing)

| Invariant | How Phase 5 holds it |
|-----------|----------------------|
| **SW caches zero authed *data*.** | The SW still uses `NetworkOnly` for authed navigations and caches no `/api`/RSC/JSON. The one addition is runtime-caching the **`/list` shell**, which is deliberately **data-free** (no `getItems()` server call) — so the cached HTML contains no list content. The invariant tightens to *"no authed data in any cache; the `/list` shell is data-free precisely so it can be cached for offline."* |
| **Authed data lives only in the encrypted, per-user Dexie store.** | AES-GCM content encryption with a non-extractable device key; DB named per user; wiped on sign-out and user-switch (§3.3, §3.7). |
| **RLS remains the server backstop.** | The sync RPC is `security invoker`; push and pull run as the `authenticated` role through the cookie-authed server client. No service-role anywhere in the sync path. Cross-user isolation is enforced by the unchanged owner-only policies and re-validated by an `rls.yml` test exercising the RPC (§7). |
| **CSP unchanged.** | IndexedDB/Web Crypto need no CSP directive (there is no `indexed-db-src`/`crypto-src`); `connect-src` already allows the Supabase origin the Server Action talks to. No new external origins. |
| **Service worker stays "dumb."** | No authed replay, no keys, no Background Sync in the SW (§1 non-goals) — it only serves shells and the offline page. |

### Service worker change (`app/sw.ts`)
Add a navigation route + fallback so an **offline** document navigation to `/list` serves the cached data-free `/list` shell, while every other authed route keeps falling back to `/~offline`:
- A `NetworkFirst` runtime route scoped to `url.pathname === "/list"` document requests: online → network (fresh shell, revalidated into the cache); offline → the cached shell; never cached yet → the `/~offline` fallback. Online responses are still data-free, so caching them is privacy-safe.
- All other navigations remain `NetworkOnly` → `/~offline` offline (unchanged from Phase 4).
- A test asserts the cached `/list` response carries no item markers (it structurally cannot — the page renders no data server-side), guarding the invariant.
- **Audit the `(app)` layout / `SideNav` chrome before caching the shell:** the cached `/list` HTML must render **no user-identifying content** (email, display name). The shell currently renders only the brand wordmark + nav links + Install/collapse affordances (no PII), which is safe; if any user identity is ever added to the layout, it must be excluded from the cached shell (rendered client-side from Dexie/session instead) so the cached document stays data-free.

---

## 5. Components & files

**New**
- `lib/offline/db.ts` — Dexie database (per-user name), schema, open/delete helpers, `ownerId` guard.
- `lib/offline/crypto.ts` — `getOrCreateKey()`, `encryptContent()`, `decryptContent()` (AES-GCM, non-extractable key).
- `lib/offline/items.ts` — local CRUD helpers (add/toggle/edit/delete/clear) that write Dexie + mark `dirty`/`editedAt`; the decrypt-and-group read for `useLiveQuery`.
- `lib/offline/sync.ts` — the foreground sync engine (collect dirty → `syncShoppingList` → reconcile → advance cursor; in-flight guard).
- `lib/offline/useOnlineStatus.ts` — `useSyncExternalStore` over `online`/`offline`.
- `lib/offline/provider.tsx` — client provider holding the per-user DB handle + `userId`; wires triggers; exposes sync state (offline/syncing/synced/pending count) and a `signOutAndWipe()`.
- `app/(app)/list/actions.ts` — **add** `syncShoppingList(input)` Server Action (Zod-validated at the boundary; `requireUser()`; `rpc` push + `getChangesSince` pull). The Phase 3 per-op actions are removed from the `/list` write path (the list is now local-first); kept only if still referenced elsewhere.
- `lib/validation/sync.ts` — Zod schema for the sync payload (array of items with bounded lengths, enum category, ISO timestamps, UUID ids).
- `supabase/migrations/0005_offline_sync.sql` — `edited_at` columns + `sync_shopping_items` RPC + grant (§3.8).

**Modified**
- `app/(app)/list/page.tsx` — drop the `getItems()` server fetch; render the data-free `<ListView />` shell.
- `app/(app)/list/ListView.tsx` — read from Dexie via `useLiveQuery` instead of `initialItems` props; route every mutation through `lib/offline/items.ts`; show the sync-status affordance.
- `app/(app)/list/ItemSheet.tsx` — submit through the local-write helper (unchanged UI).
- `lib/dal/shopping-list.ts` — add `getChangesSince(cursor)` (tombstone-inclusive); leave `getItems()` and the mutation DAL in place.
- `app/sw.ts` — add the `/list` `NetworkFirst` shell route + fallback (§4).
- `next.config.ts` — add `/list` to `additionalPrecacheEntries` only if a build-time prerender of the data-free shell is viable; otherwise rely on runtime caching (§4). (Implementation plan resolves which; runtime caching is the safe default.)
- `app/auth/signout/route.ts` **+ the sign-out control** — sign-out wrapped client-side to `db.delete()` before hitting the route.
- `package.json` — add `dexie`, `dexie-react-hooks` (latest stable, verified at install).
- `README.md` — document the offline list, the encrypted local store, the sync model, and that macro logging is online-only.

---

## 6. Sync-status UX
A small, quiet status surface (in the `/list` header on phone; in the sidebar rail on desktop):
- **States:** `offline` (cloud-off glyph) · `syncing` (spinner) · `synced` (check, transient) · `N pending` (count of `dirty` rows when offline or mid-retry).
- **Per-item:** an unsynced row shows a subtle "pending" dot; it clears when the row reaches `serverKnown = 1`.
- **Conflicts:** auto-resolved by last-edit-wins, silent by default; if one of *your* local edits was superseded by a newer edit from your other device, an optional brief toast ("Updated from your other device") — no modal, no decision asked.
- **Auth-expired:** an inline "Sign in to sync — your changes are saved" affordance; never blocks local editing.
- **Sign-out with pending:** if unsynced edits exist, sign-out pushes them first (online) or warns and asks to confirm (offline) before clearing — never a silent loss (§3.7).

(The visual treatment of this status surface is the one genuinely visual question in the phase; it can be mocked in the browser companion during planning if the owner wants to refine it.)

---

## 7. Testing

**Automated (Vitest, `node` env, pure functions — no DOM/render infra added, per project norm):**
- `lib/offline/crypto.ts`: encrypt→decrypt round-trips to the original content; a wrong/foreign key fails closed; each write uses a distinct IV.
- the **LWW reconcile resolver** (pure function extracted from `sync.ts`): server-newer-vs-local-newer, dirty-vs-clean, tombstone-wins, missing-local — every branch, including the equal-timestamp case (**strict `>` on both the client resolver and the RPC guard, symmetric: on an exact tie each side keeps its own value** — deterministic, and impossible to hit in practice since `edited_at` is per-edit).
- the **dirty-row collector / payload shaper**: maps Dexie rows → server payload (snake_case, nulls, ISO timestamps) correctly.
- **cursor advance**: monotonic; never regresses on an empty pull; handles same-millisecond rows idempotently.
- `lib/validation/sync.ts`: rejects oversized names/quantities, bad category enum, non-UUID ids, non-ISO timestamps.
- the **sign-out guard** decision (pure): `(dirtyCount, online)` → `wipe` (none dirty) · `sync-then-wipe` (dirty + online) · `confirm-then-wipe` (dirty + offline); a cancelled confirm leaves the user signed in.
- SW shape (`tests/pwa/…`): the `/list` runtime route is `NetworkFirst` and scoped to `/list`; other navigations stay `NetworkOnly`; the cached-`/list` invariant assertion (no item markers).

**RLS integration (`rls.yml`, live local Supabase):** extend the existing isolation suite to drive `sync_shopping_items` and `getChangesSince` **as two different users** — user B cannot upsert into user A's list (RLS rejects), cannot pull A's rows, and a tombstone from A never appears for B. Confirms the RPC introduces no cross-user path. (Restores/extends the fail-closed `REQUIRE_SUPABASE_TESTS=1` path.)

**Manual e2e (owner, deployed app):**
- **Airplane mode:** open the installed app offline → `/list` renders the current list (warm store); add / check / edit / delete / clear all work and persist across an app relaunch while still offline.
- **Reconnect:** turn the network on → within a trigger the list syncs; the server (and the user's other device) reflects every change; `pending` clears.
- **Two-device LWW:** edit the same item on phone (offline) and desktop (online); on the phone's reconnect, the newer real-world edit wins; the superseded side shows the quiet toast; no item is silently lost.
- **Privacy:** DevTools → Application → IndexedDB shows the `items` content as ciphertext (no plaintext names); Cache Storage shows only static assets, `/~offline`, and the data-free `/list` shell — no authed JSON. Sign out → the `ns-list-<userId>` DB is gone.
- **Sign-out with pending:** make an offline edit, then sign out → warned that N unsynced change(s) will be lost; cancel keeps you signed in with the edit intact; confirm wipes and signs out. Online sign-out with pending pushes first, then wipes.
- **Auth-expired:** let the session lapse offline, make edits, reconnect → the "sign in to sync" affordance appears, edits are retained, and they sync after re-login.

---

## 8. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| The encrypted local store re-opens the "authed data on device" hole Phase 4 closed. | Data is AES-GCM-encrypted with a non-extractable key, scoped to a per-user DB, **wiped on sign-out/user-switch**; the SW still caches no authed data (only the data-free `/list` shell). The privacy e2e asserts ciphertext-at-rest and a clean Cache Storage. **This is the phase's primary invariant.** |
| Caching the `/list` shell leaks list contents. | The shell is structurally **data-free** (no `getItems()` server call); a test asserts the cached response carries no item markers. |
| Client clock skew poisons last-edit-wins. | The **pull cursor uses server time** (`updated_at`), so "what changed" is never missed regardless of device clock; only the *conflict tiebreak* uses client `edited_at`, an accepted limitation for a single-owner list. |
| `security invoker` RPC becomes a cross-user write path. | RLS policies apply inside the function (caller runs as `authenticated`); an `rls.yml` test drives the RPC as two users and asserts rejection. No service-role in the path. |
| Partial sync (network drops mid-run) leaves inconsistent state. | The push is one atomic RPC; the run is idempotent (rows stay `dirty` until confirmed); the next trigger re-drains. No op-log ordering to corrupt (dirty-row model coalesces). |
| Duplicate add on retry (UUID already inserted). | `ON CONFLICT (id) DO UPDATE` with the LWW guard makes re-pushing an already-inserted row a no-op/no-harm. |
| Online users lose server-rendered initial list HTML (empty flash on cold first load). | Warm store paints instantly from IndexedDB; first-ever load shows a brief skeleton then the pulled list. Accepted with the local-first decision; skeleton keeps it graceful. |
| Dexie/`dexie-react-hooks` version drift from "latest stable." | Pin both to the current stable at install (verify on npm); they are mature, App-Router-compatible libraries. |
| iOS Safari PWA storage eviction (IndexedDB can be cleared under storage pressure). | Acceptable: the server is the durable source; an evicted store simply re-pulls on next online launch. No unsynced data is uniquely held once `dirty` rows have pushed; document the "sync before clearing space" reality. |
| Encryption corruption / key loss makes a row unreadable. | `decryptContent` fails closed → drop the row and re-pull from the server (authoritative). No crash into the UI. |
| Sign-out wipes unsynced edits silently. | Sign-out is guarded: push-first when online, explicit confirm when offline, immediate only when nothing is `dirty` (§3.7); unit-tested decision + e2e. |

---

## 9. Open items (non-blocking)
- **Sync-status visual treatment** — mock in the browser companion during planning if the owner wants to refine glyphs/placement; the states themselves are fixed (§6).
- **`additionalPrecacheEntries` for `/list`** vs runtime caching — the implementation plan picks based on whether the data-free shell prerenders cleanly under the `(app)` `requireUser()` layout; **runtime `NetworkFirst` caching is the safe default** and the spec assumes it.
- **Extending the engine to macro logging** later — the two-clock + RPC pattern generalizes to `logged_foods`; out of scope now (the nutrition-snapshot fetch is the blocker).
- **Tombstone retention / compaction** — soft-deleted rows accumulate server-side; a future cleanup job can hard-delete tombstones older than a window. Not needed at family scale; noted so it isn't forgotten.
