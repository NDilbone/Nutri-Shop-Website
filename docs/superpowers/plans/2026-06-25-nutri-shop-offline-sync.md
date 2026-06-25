# Phase 5: Offline Shopping List + Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the shopping list fully usable offline — render, add, check, edit, delete, clear with no network — backed by an encrypted on-device store, and sync to the server on reconnect with last-edit-wins.

**Architecture:** `/list` becomes local-first: an encrypted Dexie (IndexedDB) store is the client's source of truth, read reactively via `useLiveQuery`. Mutations write Dexie immediately and mark rows `dirty`. A foreground sync engine pushes dirty rows through one `security invoker` Postgres RPC (last-edit-wins, RLS-gated) and pulls server deltas (including tombstones) in a single Server Action round trip, reconciling into Dexie. The service worker runtime-caches only the **data-free** `/list` shell so the page loads offline without caching any authenticated data. `/today`, `/add`, `/account`, and macro logging are untouched and stay online-only.

**Tech Stack:** Next.js 16 (App Router), TypeScript, Supabase Postgres (RLS), `@supabase/ssr` (cookie sessions), Dexie + dexie-react-hooks (IndexedDB), Web Crypto (AES-GCM), Zod 4, Serwist 9.5.11 (service worker), Vitest (node env), pnpm.

**Spec:** [`docs/superpowers/specs/2026-06-25-nutri-shop-offline-sync-design.md`](../specs/2026-06-25-nutri-shop-offline-sync-design.md)

## Global Constraints

These apply to **every** task; each task's requirements implicitly include them.

- **Identity:** all git/GitHub actions in this repo are authored by **NDilbone**. Before committing, the repo-local `user.email` is `208098727+NDilbone@users.noreply.github.com`. Never use the global `RegEdits` identity here.
- **No AI attribution** in any durable artifact (commits, code comments, docs): no `Co-Authored-By: Claude`, no "Generated with…" footers, no mention of Claude/Anthropic/AI/LLM.
- **Dependencies = latest stable.** Before pinning `dexie` and `dexie-react-hooks`, run `npm view <pkg> version` and pin that exact stable version. No pre-releases.
- **Privacy invariant (load-bearing):** the service worker caches **zero authenticated data** — only static assets, `/~offline`, and the **data-free** `/list` shell. The `/list` page renders **no** list data server-side. Authenticated list data lives **only** in the encrypted, per-user Dexie store.
- **Encryption:** AES-GCM, **content fields only** (`name`, `quantity`, `category`, `fdcId`, `checked`); the key is a **non-extractable** `CryptoKey`. Sync-control fields (`id`, `listId`, timestamps, flags) are stored in clear.
- **Store lifecycle:** per-user DB named `ns-list-<userId>`; deleted on sign-out and user-switch; sign-out is **guarded** (push-first online / explicit confirm offline when dirty rows exist).
- **Server access:** no service-role anywhere in the request/sync path; RLS is the backstop; the sync RPC is `security invoker`; **do not** activate the browser Supabase client — sync rides the existing session cookie via a Server Action.
- **Sync is foreground-only.** No Background Sync API, no Periodic Sync, no SW-side authed replay.
- **Tests:** pure-function unit tests in the existing Vitest **node** env (`tests/**/*.test.ts`). **Do not add** jsdom, Testing Library, `fake-indexeddb`, or any DOM/IndexedDB test infra. Dexie/React/SW wiring is verified by `pnpm typecheck && pnpm lint && pnpm build` and manual e2e; the sync RPC is verified by the `rls.yml` integration suite.
- **Lint every UI/client task:** run `pnpm lint` (not just typecheck/build — Turbopack/webpack skip ESLint; the React-19 set-state-in-effect rule only surfaces via lint). Use **render-time state reset, never `useEffect` for derived state**.
- **Build reality:** production build is `next build --webpack` (Serwist). Local service-worker testing is `pnpm build && pnpm start` (SW is disabled under `next dev`).
- **Commits:** Conventional Commits; commit at the end of each task per the steps.
- **Path alias:** `@/` maps to repo root (configured for both `tsc` and Vitest via `vite-tsconfig-paths`).

**Per-task verification baseline:** unless a task says otherwise, before the commit step run `pnpm typecheck && pnpm lint && pnpm test` and confirm green. Tasks that touch client/Dexie/SW code additionally must pass `pnpm build`.

---

## File Structure

**New — pure logic (unit-tested):**
- `lib/offline/crypto.ts` — AES-GCM content encryption (`generateContentKey`, `encryptContent`, `decryptContent`).
- `lib/offline/reconcile.ts` — pure last-edit-wins resolver (`reconcile`).
- `lib/offline/payload.ts` — pure server-payload shaper + cursor (`toServerItem`, `nextCursor`).
- `lib/offline/signout-decision.ts` — pure sign-out guard (`signOutDecision`).
- `lib/validation/sync.ts` — Zod schema for the sync payload.

**New — wiring (build/e2e-verified):**
- `lib/offline/db.ts` — Dexie database (per-user), key load/generate, DB delete helpers.
- `lib/offline/items.ts` — local CRUD + decrypt-and-group read for display.
- `lib/offline/sync.ts` — foreground sync engine (collect dirty → Server Action → reconcile → advance cursor).
- `lib/offline/useOnlineStatus.ts` — `useSyncExternalStore` over `online`/`offline`.
- `lib/offline/OfflineProvider.tsx` — client provider: owns the DB handle + key + sync state + triggers + `signOutAndWipe`.

**New — server/DB:**
- `supabase/migrations/0005_offline_sync.sql` — `edited_at` columns + `sync_shopping_items` RPC + grants.

**Modified:**
- `lib/dal/shopping-list.ts` — add `getChangesSince(cursor)` (tombstone-inclusive).
- `app/(app)/list/actions.ts` — add `syncShoppingList` Server Action; remove the Phase-3 per-op actions.
- `app/(app)/list/page.tsx` — drop `getItems()`; render the data-free shell.
- `app/(app)/list/ListView.tsx` — read from Dexie via `useLiveQuery`; mutate via `lib/offline/items.ts`; sync-status affordance.
- `app/(app)/list/ItemSheet.tsx` — submit through the local-write helper.
- `app/(app)/layout.tsx` — mount `OfflineProvider`; pass `userId`; wrap sign-out.
- `app/sw.ts` — runtime `NetworkFirst` route for the `/list` shell.
- `package.json` — add `dexie`, `dexie-react-hooks`.
- `tests/integration/rls.test.ts` (or the existing RLS suite file) — exercise `sync_shopping_items` + `getChangesSince` cross-user.
- `README.md` — document the offline list, encrypted store, sync model.

---

## Task 1: Content encryption (`lib/offline/crypto.ts`)

**Files:**
- Create: `lib/offline/crypto.ts`
- Test: `tests/offline/crypto.test.ts`

**Interfaces:**
- Consumes: Web Crypto global (`crypto.subtle`, `crypto.getRandomValues`).
- Produces:
  - `type ContentFields = { name: string; quantity: string | null; category: string | null; fdcId: number | null; checked: boolean }`
  - `generateContentKey(): Promise<CryptoKey>`
  - `encryptContent(key: CryptoKey, content: ContentFields): Promise<{ iv: Uint8Array; cipher: ArrayBuffer }>`
  - `decryptContent(key: CryptoKey, iv: Uint8Array, cipher: ArrayBuffer): Promise<ContentFields>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/offline/crypto.test.ts
import { describe, it, expect } from "vitest";
import { generateContentKey, encryptContent, decryptContent } from "@/lib/offline/crypto";

describe("content encryption", () => {
  it("round-trips content through encrypt/decrypt", async () => {
    const key = await generateContentKey();
    const content = { name: "Milk", quantity: "2", category: "dairy", fdcId: null, checked: false };
    const { iv, cipher } = await encryptContent(key, content);
    expect(await decryptContent(key, iv, cipher)).toEqual(content);
  });

  it("uses a distinct IV per write", async () => {
    const key = await generateContentKey();
    const c = { name: "X", quantity: null, category: null, fdcId: 123, checked: true };
    const a = await encryptContent(key, c);
    const b = await encryptContent(key, c);
    expect(Buffer.from(a.iv)).not.toEqual(Buffer.from(b.iv));
  });

  it("fails to decrypt with a different key", async () => {
    const k1 = await generateContentKey();
    const k2 = await generateContentKey();
    const { iv, cipher } = await encryptContent(k1, {
      name: "secret", quantity: null, category: null, fdcId: null, checked: false,
    });
    await expect(decryptContent(k2, iv, cipher)).rejects.toThrow();
  });

  it("produces a non-extractable key", async () => {
    const key = await generateContentKey();
    expect(key.extractable).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/offline/crypto.test.ts` *(note: the trailing path filters files; do NOT add `--` before the path in a way that runs the whole suite — `pnpm test tests/offline/crypto.test.ts` also works. Verify only this file's tests run.)*
Expected: FAIL — `Cannot find module '@/lib/offline/crypto'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/offline/crypto.ts
export type ContentFields = {
  name: string;
  quantity: string | null;
  category: string | null;
  fdcId: number | null;
  checked: boolean;
};

export async function generateContentKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    /* extractable */ false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptContent(
  key: CryptoKey,
  content: ContentFields,
): Promise<{ iv: Uint8Array; cipher: ArrayBuffer }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(content));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  return { iv, cipher };
}

export async function decryptContent(
  key: CryptoKey,
  iv: Uint8Array,
  cipher: ArrayBuffer,
): Promise<ContentFields> {
  const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return JSON.parse(new TextDecoder().decode(data)) as ContentFields;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/offline/crypto.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/offline/crypto.ts tests/offline/crypto.test.ts
git commit -m "feat: add AES-GCM content encryption for the offline store"
```

---

## Task 2: Last-edit-wins reconcile resolver (`lib/offline/reconcile.ts`)

**Files:**
- Create: `lib/offline/reconcile.ts`
- Test: `tests/offline/reconcile.test.ts`

**Interfaces:**
- Produces:
  - `type SyncMeta = { id: string; editedAt: string; deletedAt: string | null }`
  - `type LocalMeta = SyncMeta & { dirty: boolean }`
  - `type ReconcileAction = "insert" | "overwrite" | "keep-local"`
  - `reconcile(local: LocalMeta | null, server: SyncMeta): ReconcileAction`
- Semantics: `insert` = the row is new to us; `overwrite` = take the server row (including a tombstone) and clear dirty; `keep-local` = keep the local dirty row (it will push next sync). Equal `editedAt` ⇒ `keep-local` (strict `>`).

- [ ] **Step 1: Write the failing test**

```ts
// tests/offline/reconcile.test.ts
import { describe, it, expect } from "vitest";
import { reconcile } from "@/lib/offline/reconcile";

const T0 = "2026-06-25T10:00:00.000Z";
const T1 = "2026-06-25T11:00:00.000Z";

describe("reconcile (last-edit-wins)", () => {
  it("inserts when the row is unknown locally", () => {
    expect(reconcile(null, { id: "a", editedAt: T1, deletedAt: null })).toBe("insert");
  });

  it("overwrites a clean local row with the server row", () => {
    expect(
      reconcile({ id: "a", editedAt: T0, deletedAt: null, dirty: false }, { id: "a", editedAt: T0, deletedAt: null }),
    ).toBe("overwrite");
  });

  it("server wins over a dirty local row when strictly newer", () => {
    expect(
      reconcile({ id: "a", editedAt: T0, deletedAt: null, dirty: true }, { id: "a", editedAt: T1, deletedAt: null }),
    ).toBe("overwrite");
  });

  it("local wins over the server row when the dirty local edit is newer", () => {
    expect(
      reconcile({ id: "a", editedAt: T1, deletedAt: null, dirty: true }, { id: "a", editedAt: T0, deletedAt: null }),
    ).toBe("keep-local");
  });

  it("on an exact tie a dirty local row is kept (strict >)", () => {
    expect(
      reconcile({ id: "a", editedAt: T1, deletedAt: null, dirty: true }, { id: "a", editedAt: T1, deletedAt: null }),
    ).toBe("keep-local");
  });

  it("a server tombstone overwrites a clean local row", () => {
    expect(
      reconcile({ id: "a", editedAt: T0, deletedAt: null, dirty: false }, { id: "a", editedAt: T1, deletedAt: T1 }),
    ).toBe("overwrite");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/offline/reconcile.test.ts`
Expected: FAIL — `Cannot find module '@/lib/offline/reconcile'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/offline/reconcile.ts
export type SyncMeta = { id: string; editedAt: string; deletedAt: string | null };
export type LocalMeta = SyncMeta & { dirty: boolean };
export type ReconcileAction = "insert" | "overwrite" | "keep-local";

export function reconcile(local: LocalMeta | null, server: SyncMeta): ReconcileAction {
  if (local === null) return "insert";
  if (!local.dirty) return "overwrite";
  return Date.parse(server.editedAt) > Date.parse(local.editedAt) ? "overwrite" : "keep-local";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/offline/reconcile.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/offline/reconcile.ts tests/offline/reconcile.test.ts
git commit -m "feat: add last-edit-wins reconcile resolver"
```

---

## Task 3: Server payload shaper + cursor (`lib/offline/payload.ts`)

**Files:**
- Create: `lib/offline/payload.ts`
- Test: `tests/offline/payload.test.ts`

**Interfaces:**
- Consumes: `ContentFields` (Task 1).
- Produces:
  - `type DecryptedRow = ContentFields & { id: string; listId: string; editedAt: string; deletedAt: string | null }`
  - `type ServerItem = { id: string; list_id: string; name: string; quantity: string | null; category: string | null; fdc_id: number | null; checked: boolean; deleted_at: string | null; edited_at: string }`
  - `toServerItem(row: DecryptedRow): ServerItem`
  - `nextCursor(serverUpdatedAts: string[], prevCursor: string): string`

- [ ] **Step 1: Write the failing test**

```ts
// tests/offline/payload.test.ts
import { describe, it, expect } from "vitest";
import { toServerItem, nextCursor } from "@/lib/offline/payload";

describe("toServerItem", () => {
  it("maps a decrypted row to the snake_case server payload", () => {
    expect(
      toServerItem({
        id: "i1", listId: "l1", name: "Eggs", quantity: "12", category: "dairy",
        fdcId: 999, checked: true, editedAt: "2026-06-25T10:00:00.000Z", deletedAt: null,
      }),
    ).toEqual({
      id: "i1", list_id: "l1", name: "Eggs", quantity: "12", category: "dairy",
      fdc_id: 999, checked: true, deleted_at: null, edited_at: "2026-06-25T10:00:00.000Z",
    });
  });

  it("preserves nulls for optional fields", () => {
    const out = toServerItem({
      id: "i2", listId: "l1", name: "Bread", quantity: null, category: null,
      fdcId: null, checked: false, editedAt: "2026-06-25T10:00:00.000Z", deletedAt: null,
    });
    expect(out.quantity).toBeNull();
    expect(out.category).toBeNull();
    expect(out.fdc_id).toBeNull();
  });
});

describe("nextCursor", () => {
  const C = "2026-06-25T10:00:00.000Z";
  it("returns the max updated_at seen", () => {
    expect(nextCursor(["2026-06-25T10:30:00.000Z", "2026-06-25T11:00:00.000Z"], C))
      .toBe("2026-06-25T11:00:00.000Z");
  });
  it("returns the previous cursor when nothing changed", () => {
    expect(nextCursor([], C)).toBe(C);
  });
  it("never regresses below the previous cursor", () => {
    expect(nextCursor(["2026-06-25T09:00:00.000Z"], C)).toBe(C);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/offline/payload.test.ts`
Expected: FAIL — `Cannot find module '@/lib/offline/payload'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/offline/payload.ts
import type { ContentFields } from "./crypto";

export type DecryptedRow = ContentFields & {
  id: string;
  listId: string;
  editedAt: string;
  deletedAt: string | null;
};

export type ServerItem = {
  id: string;
  list_id: string;
  name: string;
  quantity: string | null;
  category: string | null;
  fdc_id: number | null;
  checked: boolean;
  deleted_at: string | null;
  edited_at: string;
};

export function toServerItem(row: DecryptedRow): ServerItem {
  return {
    id: row.id,
    list_id: row.listId,
    name: row.name,
    quantity: row.quantity,
    category: row.category,
    fdc_id: row.fdcId,
    checked: row.checked,
    deleted_at: row.deletedAt,
    edited_at: row.editedAt,
  };
}

export function nextCursor(serverUpdatedAts: string[], prevCursor: string): string {
  return serverUpdatedAts.reduce(
    (max, t) => (Date.parse(t) > Date.parse(max) ? t : max),
    prevCursor,
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/offline/payload.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/offline/payload.ts tests/offline/payload.test.ts
git commit -m "feat: add offline sync payload shaper and cursor helper"
```

---

## Task 4: Sign-out guard decision (`lib/offline/signout-decision.ts`)

**Files:**
- Create: `lib/offline/signout-decision.ts`
- Test: `tests/offline/signout-decision.test.ts`

**Interfaces:**
- Produces:
  - `type SignOutAction = "wipe" | "sync-then-wipe" | "confirm-then-wipe"`
  - `signOutDecision(dirtyCount: number, online: boolean): SignOutAction`

- [ ] **Step 1: Write the failing test**

```ts
// tests/offline/signout-decision.test.ts
import { describe, it, expect } from "vitest";
import { signOutDecision } from "@/lib/offline/signout-decision";

describe("signOutDecision", () => {
  it("wipes immediately when nothing is dirty", () => {
    expect(signOutDecision(0, true)).toBe("wipe");
    expect(signOutDecision(0, false)).toBe("wipe");
  });
  it("syncs first when dirty and online", () => {
    expect(signOutDecision(3, true)).toBe("sync-then-wipe");
  });
  it("asks for confirmation when dirty and offline", () => {
    expect(signOutDecision(3, false)).toBe("confirm-then-wipe");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/offline/signout-decision.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/offline/signout-decision.ts
export type SignOutAction = "wipe" | "sync-then-wipe" | "confirm-then-wipe";

export function signOutDecision(dirtyCount: number, online: boolean): SignOutAction {
  if (dirtyCount === 0) return "wipe";
  return online ? "sync-then-wipe" : "confirm-then-wipe";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/offline/signout-decision.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/offline/signout-decision.ts tests/offline/signout-decision.test.ts
git commit -m "feat: add guarded sign-out decision for the offline store"
```

---

## Task 5: Sync payload validation (`lib/validation/sync.ts`)

**Files:**
- Create: `lib/validation/sync.ts`
- Modify: `lib/validation/shopping-list.ts` (export the category enum if it is not already exported, so it is reused here — do NOT redefine the category list)
- Test: `tests/validation/sync.test.ts`

**Interfaces:**
- Consumes: the existing category Zod enum from `lib/validation/shopping-list.ts`.
- Produces:
  - `syncItemSchema` — validates one `ServerItem`-shaped object.
  - `syncInputSchema` — `{ dirtyItems: ServerItem[] (max 500); cursor: string (ISO) }`.
  - `type SyncInput = z.infer<typeof syncInputSchema>`

**Notes:** Open `lib/validation/shopping-list.ts` first. It already validates `category` for `addItemSchema`. Export that enum (e.g. `export const categorySchema = z.enum([...])`) and import it here. Use Zod 4 top-level string formats: `z.uuid()`. Validate timestamps with a `Date.parse` refinement (robust across Zod versions and matches the project's regex-style timestamp validation).

- [ ] **Step 1: Write the failing test**

```ts
// tests/validation/sync.test.ts
import { describe, it, expect } from "vitest";
import { syncInputSchema } from "@/lib/validation/sync";

const validItem = {
  id: "11111111-1111-4111-8111-111111111111",
  list_id: "22222222-2222-4222-8222-222222222222",
  name: "Apples",
  quantity: "3",
  category: "produce",
  fdc_id: null,
  checked: false,
  deleted_at: null,
  edited_at: "2026-06-25T10:00:00.000Z",
};

describe("syncInputSchema", () => {
  it("accepts a valid payload", () => {
    expect(syncInputSchema.parse({ dirtyItems: [validItem], cursor: "1970-01-01T00:00:00.000Z" }).dirtyItems)
      .toHaveLength(1);
  });
  it("rejects a non-UUID id", () => {
    expect(() => syncInputSchema.parse({ dirtyItems: [{ ...validItem, id: "nope" }], cursor: "1970-01-01T00:00:00.000Z" }))
      .toThrow();
  });
  it("rejects an unknown category", () => {
    expect(() => syncInputSchema.parse({ dirtyItems: [{ ...validItem, category: "snacks" }], cursor: "1970-01-01T00:00:00.000Z" }))
      .toThrow();
  });
  it("rejects an over-long name", () => {
    expect(() => syncInputSchema.parse({ dirtyItems: [{ ...validItem, name: "x".repeat(201) }], cursor: "1970-01-01T00:00:00.000Z" }))
      .toThrow();
  });
  it("rejects a non-ISO timestamp", () => {
    expect(() => syncInputSchema.parse({ dirtyItems: [{ ...validItem, edited_at: "not-a-date" }], cursor: "1970-01-01T00:00:00.000Z" }))
      .toThrow();
  });
  it("rejects a non-ISO cursor", () => {
    expect(() => syncInputSchema.parse({ dirtyItems: [], cursor: "yesterday" })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/validation/sync.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/validation/sync.ts
import { z } from "zod";
import { categorySchema } from "./shopping-list"; // export it from shopping-list.ts if not already

const iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "invalid ISO timestamp");

export const syncItemSchema = z.object({
  id: z.uuid(),
  list_id: z.uuid(),
  name: z.string().trim().min(1).max(200),
  quantity: z.string().trim().max(50).nullable(),
  category: categorySchema.nullable(),
  fdc_id: z.number().int().positive().nullable(),
  checked: z.boolean(),
  deleted_at: iso.nullable(),
  edited_at: iso,
});

export const syncInputSchema = z.object({
  dirtyItems: z.array(syncItemSchema).max(500),
  cursor: iso,
});

export type SyncInput = z.infer<typeof syncInputSchema>;
```

If `categorySchema` does not exist in `lib/validation/shopping-list.ts`, add it there (reusing the exact values already used by `addItemSchema`) and import it — do not duplicate the list.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/validation/sync.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/validation/sync.ts lib/validation/shopping-list.ts tests/validation/sync.test.ts
git commit -m "feat: add Zod validation for the offline sync payload"
```

---

## Task 6: Migration 0005 — `edited_at` + `sync_shopping_items` RPC + RLS test

**Files:**
- Create: `supabase/migrations/0005_offline_sync.sql`
- Modify: the existing RLS integration test (find it: `git ls-files | grep -i rls` — likely `tests/integration/rls.test.ts`; it self-skips when Supabase env is absent). Add cross-user cases for the RPC and `getChangesSince`.

**Interfaces:**
- Produces (DB): columns `shopping_lists.edited_at`, `shopping_list_items.edited_at` (`timestamptz not null default now()`); function `public.sync_shopping_items(p_items jsonb) returns void` (security invoker), granted to `authenticated`.

**Verification:** local `pnpm typecheck/lint/test` stay green (SQL is not unit-tested locally). The RPC's behavior + isolation is validated by `rls.yml` in CI (which spins up a real local Supabase and runs the integration suite fail-closed with `REQUIRE_SUPABASE_TESTS=1`). After merge, `db-migrate.yml` applies `0005` to prod (secrets already configured since Phase 2).

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0005_offline_sync.sql
-- Phase 5 offline sync: a client-time "edited_at" clock for last-edit-wins,
-- plus a batched upsert RPC. updated_at (server, trigger now()) stays the pull
-- cursor; edited_at (client) is the conflict tiebreak.

alter table public.shopping_lists
  add column edited_at timestamptz not null default now();

alter table public.shopping_list_items
  add column edited_at timestamptz not null default now();

-- Batched last-edit-wins upsert for shopping list items.
-- SECURITY INVOKER => runs as the calling `authenticated` role, so the existing
-- owner-only RLS policies gate every row (insert WITH CHECK + update USING/WITH
-- CHECK on list ownership). No service-role. A row targeting a list the caller
-- does not own fails RLS and aborts the batch — the only safe outcome.
create or replace function public.sync_shopping_items(p_items jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  insert into public.shopping_list_items
    (id, list_id, name, quantity, category, fdc_id, checked, deleted_at, edited_at)
  select
    (e->>'id')::uuid,
    (e->>'list_id')::uuid,
    e->>'name',
    e->>'quantity',
    e->>'category',
    nullif(e->>'fdc_id', '')::bigint,
    (e->>'checked')::boolean,
    nullif(e->>'deleted_at', '')::timestamptz,
    (e->>'edited_at')::timestamptz
  from jsonb_array_elements(p_items) as e
  on conflict (id) do update set
    name       = excluded.name,
    quantity   = excluded.quantity,
    category   = excluded.category,
    fdc_id     = excluded.fdc_id,
    checked    = excluded.checked,
    deleted_at = excluded.deleted_at,
    edited_at  = excluded.edited_at
  where excluded.edited_at > public.shopping_list_items.edited_at; -- last-edit-wins guard
end;
$$;

grant execute on function public.sync_shopping_items(jsonb) to authenticated;
```

- [ ] **Step 2: Write the failing RLS integration test cases**

Add to the existing RLS suite (it already creates two users A and B and asserts isolation). Mirror its existing helpers/structure; the shape below is illustrative — adapt to the file's existing `makeUser`/client helpers.

```ts
// in the existing RLS integration test file, inside the describe.skipIf(noEnv) block
it("sync_shopping_items: user B cannot upsert into user A's list", async () => {
  const a = await makeUser("alice");
  const b = await makeUser("bob");
  const aList = await getOrCreateDefaultListFor(a);

  const itemForAsList = {
    id: crypto.randomUUID(),
    list_id: aList.id,            // A's list
    name: "intruder", quantity: null, category: null, fdc_id: null,
    checked: false, deleted_at: null, edited_at: new Date().toISOString(),
  };

  const { error } = await b.client.rpc("sync_shopping_items", { p_items: [itemForAsList] });
  expect(error).not.toBeNull(); // RLS WITH CHECK rejects

  // And A never sees it.
  const { data } = await a.client.from("shopping_list_items").select("id").eq("id", itemForAsList.id);
  expect(data ?? []).toHaveLength(0);
});

it("sync_shopping_items applies last-edit-wins for the owner", async () => {
  const a = await makeUser("alice");
  const aList = await getOrCreateDefaultListFor(a);
  const id = crypto.randomUUID();

  await a.client.rpc("sync_shopping_items", { p_items: [{
    id, list_id: aList.id, name: "Milk", quantity: "1", category: "dairy",
    fdc_id: null, checked: false, deleted_at: null, edited_at: "2026-06-25T10:00:00.000Z",
  }]});

  // Older edit must NOT clobber.
  await a.client.rpc("sync_shopping_items", { p_items: [{
    id, list_id: aList.id, name: "STALE", quantity: "1", category: "dairy",
    fdc_id: null, checked: false, deleted_at: null, edited_at: "2026-06-25T09:00:00.000Z",
  }]});

  const { data } = await a.client.from("shopping_list_items").select("name").eq("id", id).single();
  expect(data?.name).toBe("Milk");
});
```

- [ ] **Step 3: Verify intent (cannot run live locally without Supabase)**

Run: `pnpm test` — confirm the new cases are **skipped** offline (the suite's `describe.skipIf` guards on Supabase env) and the rest stays green. Confirm `pnpm typecheck` passes (the test file type-checks even when skipped).
Expected: suite green; new RLS cases reported as skipped locally. (They run for real in `rls.yml`.)

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0005_offline_sync.sql tests
git commit -m "feat: add edited_at columns and last-edit-wins sync_shopping_items RPC"
```

---

## Task 7: Pull DAL + sync Server Action (`lib/dal/shopping-list.ts`, `app/(app)/list/actions.ts`)

**Files:**
- Modify: `lib/dal/shopping-list.ts` — add `getChangesSince`.
- Modify: `app/(app)/list/actions.ts` — add `syncShoppingList`; **remove** `addItemAction`, `editItemAction`, `toggleItemAction`, `deleteItemAction`, `clearCheckedAction` (the list write path is now local-first). Keep the file `"use server"`.

**Interfaces:**
- Consumes: `requireUser` (`lib/dal/session.ts`), `createClient` (`lib/supabase/server.ts`), `syncInputSchema`/`SyncInput` (Task 5), `nextCursor` (Task 3).
- Produces:
  - `type ServerItemRow = { id: string; list_id: string; name: string; quantity: string | null; category: string | null; fdc_id: number | null; checked: boolean; deleted_at: string | null; edited_at: string; updated_at: string }`
  - `getChangesSince(cursor: string): Promise<{ items: ServerItemRow[]; cursor: string }>`
  - `syncShoppingList(raw: unknown): Promise<{ items: ServerItemRow[]; cursor: string }>` (Server Action)

**Notes:** `getChangesSince` must **omit** the `deleted_at IS NULL` filter that `getItems` uses — tombstones must sync. RLS already scopes `shopping_list_items` to lists the user owns. First sync uses `cursor = "1970-01-01T00:00:00.000Z"`.

- [ ] **Step 1: Add `getChangesSince` to the DAL**

```ts
// lib/dal/shopping-list.ts  (add near getItems; reuse the file's existing imports)
import { nextCursor } from "@/lib/offline/payload";

export type ServerItemRow = {
  id: string;
  list_id: string;
  name: string;
  quantity: string | null;
  category: string | null;
  fdc_id: number | null;
  checked: boolean;
  deleted_at: string | null;
  edited_at: string;
  updated_at: string;
};

export async function getChangesSince(
  cursor: string,
): Promise<{ items: ServerItemRow[]; cursor: string }> {
  await requireUser(); // re-verify at the data boundary
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("shopping_list_items")
    .select("id, list_id, name, quantity, category, fdc_id, checked, deleted_at, edited_at, updated_at")
    .gt("updated_at", cursor)
    .order("updated_at", { ascending: true });
  if (error) throw error;
  const items = (data ?? []) as ServerItemRow[];
  return { items, cursor: nextCursor(items.map((r) => r.updated_at), cursor) };
}
```

*(If `requireUser`/`createClient` are not already imported in this file, add them. Match the file's existing import style for the Supabase server client.)*

- [ ] **Step 2: Add the `syncShoppingList` Server Action and remove the per-op actions**

```ts
// app/(app)/list/actions.ts
"use server";

import { requireUser } from "@/lib/dal/session";
import { createClient } from "@/lib/supabase/server";
import { syncInputSchema } from "@/lib/validation/sync";
import { getChangesSince, type ServerItemRow } from "@/lib/dal/shopping-list";

export async function syncShoppingList(
  raw: unknown,
): Promise<{ items: ServerItemRow[]; cursor: string }> {
  await requireUser();
  const input = syncInputSchema.parse(raw);

  if (input.dirtyItems.length > 0) {
    const supabase = await createClient();
    const { error } = await supabase.rpc("sync_shopping_items", { p_items: input.dirtyItems });
    if (error) throw new Error("sync push failed");
  }

  return getChangesSince(input.cursor);
}
```

Delete the Phase-3 per-op action exports from this file. Then run `pnpm typecheck` and follow the errors: anything still importing the removed actions is updated in Task 9/10 (Dexie path). If a typecheck error references them *before* those tasks land, comment the import at the call site with a `// replaced by local-first path (Task 9)` marker — but prefer ordering execution so Task 7 lands with Tasks 9–11.

- [ ] **Step 3: Verify**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: green. (`getChangesSince`/`syncShoppingList` live behavior is covered by `rls.yml` + e2e, not local unit tests.)

- [ ] **Step 4: Commit**

```bash
git add lib/dal/shopping-list.ts "app/(app)/list/actions.ts"
git commit -m "feat: add getChangesSince DAL and syncShoppingList server action"
```

---

## Task 8: Dexie store (`lib/offline/db.ts`) + dependencies

**Files:**
- Modify: `package.json` — add `dexie`, `dexie-react-hooks`.
- Create: `lib/offline/db.ts`

**Interfaces:**
- Consumes: `ContentFields` (Task 1).
- Produces:
  - `type StoredItem = { id: string; listId: string; updatedAt: string; editedAt: string; deletedAt: string | null; dirty: 0 | 1; serverKnown: 0 | 1; iv: Uint8Array; cipher: ArrayBuffer }`
  - `class ListDb extends Dexie` with tables `items`, `meta`, `keyv`.
  - `openListDb(userId: string): ListDb`
  - `loadOrCreateKey(db: ListDb): Promise<CryptoKey>`
  - `deleteListDb(userId: string): Promise<void>`
  - `deleteForeignDbs(currentUserId: string): Promise<void>` (best-effort; no-op where `indexedDB.databases()` is unavailable)
  - constant `EPOCH_CURSOR = "1970-01-01T00:00:00.000Z"`

**Verification:** `pnpm typecheck && pnpm lint && pnpm build` (Dexie is not unit-tested per the spec's no-IndexedDB-infra rule).

- [ ] **Step 1: Pin the latest stable dependencies**

```bash
npm view dexie version          # record the printed stable version, e.g. X.Y.Z
npm view dexie-react-hooks version
pnpm add dexie@<X.Y.Z> dexie-react-hooks@<A.B.C>
```

Confirm `package.json` shows exact stable versions (no `^`-to-prerelease, no betas). `pnpm install` must succeed; Dexie has no native build step (no `pnpm-workspace.yaml allowBuilds` entry needed).

- [ ] **Step 2: Write the Dexie store**

```ts
// lib/offline/db.ts
"use client";
import Dexie, { type Table } from "dexie";
import { generateContentKey } from "./crypto";

export const EPOCH_CURSOR = "1970-01-01T00:00:00.000Z";

export type StoredItem = {
  id: string;
  listId: string;
  updatedAt: string;     // server time — pull high-water mark
  editedAt: string;      // client time — LWW tiebreak
  deletedAt: string | null;
  dirty: 0 | 1;          // numeric so Dexie can index it
  serverKnown: 0 | 1;
  iv: Uint8Array;
  cipher: ArrayBuffer;
};

type MetaRow = { key: string; value: string };
type KeyRow = { id: string; key: CryptoKey };

export class ListDb extends Dexie {
  items!: Table<StoredItem, string>;
  meta!: Table<MetaRow, string>;
  keyv!: Table<KeyRow, string>;

  constructor(userId: string) {
    super(`ns-list-${userId}`);
    this.version(1).stores({
      items: "id, listId, dirty, updatedAt",
      meta: "key",
      keyv: "id",
    });
  }
}

export function openListDb(userId: string): ListDb {
  return new ListDb(userId);
}

export async function loadOrCreateKey(db: ListDb): Promise<CryptoKey> {
  const existing = await db.keyv.get("aes");
  if (existing) return existing.key;
  const key = await generateContentKey();
  await db.keyv.put({ id: "aes", key }); // non-extractable CryptoKey stored structured-clone
  return key;
}

export async function deleteListDb(userId: string): Promise<void> {
  await Dexie.delete(`ns-list-${userId}`);
}

export async function deleteForeignDbs(currentUserId: string): Promise<void> {
  // Best-effort: indexedDB.databases() is unavailable in some browsers (notably
  // older iOS Safari). Skip cleanup there; the per-user DB name keeps users isolated.
  const idb = indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> };
  if (typeof idb.databases !== "function") return;
  const dbs = await idb.databases();
  const keep = `ns-list-${currentUserId}`;
  await Promise.all(
    dbs
      .map((d) => d.name)
      .filter((n): n is string => !!n && n.startsWith("ns-list-") && n !== keep)
      .map((n) => Dexie.delete(n)),
  );
}
```

- [ ] **Step 3: Verify**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml lib/offline/db.ts
git commit -m "feat: add per-user encrypted Dexie store for the offline list"
```

---

## Task 9: Local item operations (`lib/offline/items.ts`)

**Files:**
- Create: `lib/offline/items.ts`

**Interfaces:**
- Consumes: `ListDb`, `StoredItem` (Task 8); `ContentFields`, `encryptContent`, `decryptContent` (Task 1); `groupItems` (`lib/shopping/group.ts`); `ShoppingListItem`, `Category` (`lib/shopping/types.ts`).
- Produces:
  - `type AddInput = { name: string; quantity: string | null; category: Category | null; fdcId: number | null }`
  - `addLocalItem(db, key, listId, input): Promise<void>`
  - `toggleLocalItem(db, key, id, checked): Promise<void>`
  - `editLocalItem(db, key, id, patch): Promise<void>`
  - `deleteLocalItem(db, id): Promise<void>`
  - `clearCheckedLocal(db, key): Promise<void>`
  - `displayItems(db, key): Promise<ShoppingListItem[]>` (decrypted, non-deleted, used by `useLiveQuery`)

**Notes:** Every write sets `editedAt = new Date().toISOString()` and `dirty = 1`. Re-encrypt the full content blob on every content change (read-modify-write the decrypted content, then `encryptContent`). Deletes set `deletedAt` + `dirty = 1` (soft-delete; do NOT remove the row — the tombstone must sync). `displayItems` filters `deletedAt == null`. Verification: `pnpm typecheck && pnpm lint && pnpm build` (behavior covered by e2e; the encrypt/decrypt and grouping pieces are already unit-tested).

- [ ] **Step 1: Write the local item operations**

```ts
// lib/offline/items.ts
"use client";
import type { ListDb, StoredItem } from "./db";
import { encryptContent, decryptContent, type ContentFields } from "./crypto";
import type { ShoppingListItem, Category } from "@/lib/shopping/types";

export type AddInput = {
  name: string;
  quantity: string | null;
  category: Category | null;
  fdcId: number | null;
};

function nowIso() {
  return new Date().toISOString();
}

async function writeContent(
  db: ListDb,
  key: CryptoKey,
  base: Pick<StoredItem, "id" | "listId" | "serverKnown" | "updatedAt">,
  content: ContentFields,
  deletedAt: string | null,
): Promise<void> {
  const { iv, cipher } = await encryptContent(key, content);
  const row: StoredItem = {
    ...base,
    editedAt: nowIso(),
    deletedAt,
    dirty: 1,
    iv,
    cipher,
  };
  await db.items.put(row);
}

export async function addLocalItem(
  db: ListDb,
  key: CryptoKey,
  listId: string,
  input: AddInput,
): Promise<void> {
  await writeContent(
    db,
    key,
    { id: crypto.randomUUID(), listId, serverKnown: 0, updatedAt: "1970-01-01T00:00:00.000Z" },
    { name: input.name, quantity: input.quantity, category: input.category, fdcId: input.fdcId, checked: false },
    null,
  );
}

async function mutateContent(
  db: ListDb,
  key: CryptoKey,
  id: string,
  apply: (c: ContentFields) => ContentFields,
  deletedAt?: string | null,
): Promise<void> {
  const row = await db.items.get(id);
  if (!row) return;
  const content = await decryptContent(key, row.iv, row.cipher);
  await writeContent(
    db,
    key,
    { id: row.id, listId: row.listId, serverKnown: row.serverKnown, updatedAt: row.updatedAt },
    apply(content),
    deletedAt === undefined ? row.deletedAt : deletedAt,
  );
}

export function toggleLocalItem(db: ListDb, key: CryptoKey, id: string, checked: boolean) {
  return mutateContent(db, key, id, (c) => ({ ...c, checked }));
}

export function editLocalItem(
  db: ListDb,
  key: CryptoKey,
  id: string,
  patch: Partial<Pick<ContentFields, "name" | "quantity" | "category">>,
) {
  return mutateContent(db, key, id, (c) => ({ ...c, ...patch }));
}

export function deleteLocalItem(db: ListDb, key: CryptoKey, id: string) {
  return mutateContent(db, key, id, (c) => c, nowIso());
}

export async function clearCheckedLocal(db: ListDb, key: CryptoKey): Promise<void> {
  const rows = await db.items.where("deletedAt").equals(null as never).toArray()
    .catch(async () => (await db.items.toArray()).filter((r) => r.deletedAt === null));
  for (const row of rows) {
    const content = await decryptContent(key, row.iv, row.cipher);
    if (content.checked) await deleteLocalItem(db, key, row.id);
  }
}

export async function displayItems(db: ListDb, key: CryptoKey): Promise<ShoppingListItem[]> {
  const rows = (await db.items.toArray()).filter((r) => r.deletedAt === null);
  const out: ShoppingListItem[] = [];
  for (const row of rows) {
    try {
      const c = await decryptContent(key, row.iv, row.cipher);
      out.push({
        id: row.id,
        name: c.name,
        quantity: c.quantity,
        category: c.category as Category | null,
        fdcId: c.fdcId,
        checked: c.checked,
        createdAt: row.editedAt, // local rows order by edit recency; server seeds carry their own
      });
    } catch {
      // fail closed: a row that won't decrypt is dropped and will be re-pulled
      await db.items.delete(row.id);
    }
  }
  return out;
}
```

*(Confirm the exact `ShoppingListItem` field names against `lib/shopping/types.ts` — adjust `createdAt` if the type differs. `clearCheckedLocal`'s `.where("deletedAt").equals(null)` falls back to a full-scan filter because Dexie cannot index `null`; keep the fallback.)*

- [ ] **Step 2: Verify**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: green.

- [ ] **Step 3: Commit**

```bash
git add lib/offline/items.ts
git commit -m "feat: add local-first item operations over the encrypted store"
```

---

## Task 10: Sync engine (`lib/offline/sync.ts`)

**Files:**
- Create: `lib/offline/sync.ts`

**Interfaces:**
- Consumes: `ListDb`, `StoredItem`, `EPOCH_CURSOR` (Task 8); `decryptContent` (Task 1); `encryptContent` (Task 1); `toServerItem` (Task 3); `reconcile` (Task 2); `syncShoppingList` action + `ServerItemRow` (Task 7).
- Produces:
  - `runSync(db: ListDb, key: CryptoKey): Promise<void>` — idempotent, single-flight; collects dirty rows, calls `syncShoppingList`, reconciles, advances the cursor.
  - `getDirtyCount(db: ListDb): Promise<number>`

**Notes:** Single in-flight guard (module-scoped boolean). On a successful push, the pull echoes the pushed rows with server-stamped `updated_at`, so reconcile naturally clears their `dirty` flag (they come back `dirty:false` locally only after we mark them — so: after a successful push, set the pushed rows' `serverKnown=1`; reconcile then overwrites them from the echo and sets `dirty=0`). Verification: typecheck/lint/build + e2e.

- [ ] **Step 1: Write the sync engine**

```ts
// lib/offline/sync.ts
"use client";
import type { ListDb, StoredItem } from "./db";
import { EPOCH_CURSOR } from "./db";
import { decryptContent, encryptContent } from "./crypto";
import { toServerItem } from "./payload";
import { reconcile } from "./reconcile";
import { syncShoppingList } from "@/app/(app)/list/actions";
import type { ServerItemRow } from "@/lib/dal/shopping-list";

let inFlight = false;

export async function getDirtyCount(db: ListDb): Promise<number> {
  return db.items.where("dirty").equals(1).count();
}

async function readCursor(db: ListDb): Promise<string> {
  return (await db.meta.get("pullCursor"))?.value ?? EPOCH_CURSOR;
}

export async function runSync(db: ListDb, key: CryptoKey): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    // 1. Collect + decrypt dirty rows.
    const dirty = await db.items.where("dirty").equals(1).toArray();
    const dirtyItems = await Promise.all(
      dirty.map(async (r) => {
        const c = await decryptContent(key, r.iv, r.cipher);
        return toServerItem({
          id: r.id, listId: r.listId, editedAt: r.editedAt, deletedAt: r.deletedAt,
          name: c.name, quantity: c.quantity, category: c.category, fdcId: c.fdcId, checked: c.checked,
        });
      }),
    );

    // 2. Push + pull in one round trip.
    const cursor = await readCursor(db);
    const result = await syncShoppingList({ dirtyItems, cursor });

    // 3. Mark pushed rows known (the echo below clears their dirty flag).
    await db.transaction("rw", db.items, async () => {
      for (const r of dirty) {
        await db.items.update(r.id, { serverKnown: 1 });
      }
    });

    // 4. Reconcile pulled rows.
    await applyServerChanges(db, key, result.items);

    // 5. Advance cursor.
    await db.meta.put({ key: "pullCursor", value: result.cursor });
  } finally {
    inFlight = false;
  }
}

async function applyServerChanges(db: ListDb, key: CryptoKey, items: ServerItemRow[]): Promise<void> {
  for (const s of items) {
    const local = await db.items.get(s.id);
    const action = reconcile(
      local ? { id: local.id, editedAt: local.editedAt, deletedAt: local.deletedAt, dirty: local.dirty === 1 } : null,
      { id: s.id, editedAt: s.edited_at, deletedAt: s.deleted_at },
    );
    if (action === "keep-local") continue;
    const { iv, cipher } = await encryptContent(key, {
      name: s.name, quantity: s.quantity, category: s.category, fdcId: s.fdc_id, checked: s.checked,
    });
    const row: StoredItem = {
      id: s.id, listId: s.list_id, updatedAt: s.updated_at, editedAt: s.edited_at,
      deletedAt: s.deleted_at, dirty: 0, serverKnown: 1, iv, cipher,
    };
    await db.items.put(row);
  }
}
```

- [ ] **Step 2: Verify**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: green.

- [ ] **Step 3: Commit**

```bash
git add lib/offline/sync.ts
git commit -m "feat: add foreground sync engine for the offline list"
```

---

## Task 11: Online status + offline provider (`lib/offline/useOnlineStatus.ts`, `lib/offline/OfflineProvider.tsx`)

**Files:**
- Create: `lib/offline/useOnlineStatus.ts`
- Create: `lib/offline/OfflineProvider.tsx`
- Modify: `app/(app)/layout.tsx` — wrap children in `<OfflineProvider userId={...}>`; pass the current user id (the layout already calls `requireUser()` — use its returned `userId`).

**Interfaces:**
- Consumes: `openListDb`, `loadOrCreateKey`, `deleteListDb`, `deleteForeignDbs`, `ListDb` (Task 8); `runSync`, `getDirtyCount` (Task 10); `signOutDecision` (Task 4); `useOnlineStatus`.
- Produces:
  - `useOnlineStatus(): boolean`
  - `OfflineProvider({ userId, children })` — React client provider.
  - `useOffline(): { db: ListDb; cryptoKey: CryptoKey; online: boolean; syncing: boolean; pending: number; sync: () => void; signOutAndWipe: () => Promise<void> }` (context hook; throws if used outside the provider).

**Notes:** The provider opens the per-user DB once, loads/creates the key, runs `deleteForeignDbs(userId)` on mount, wires foreground triggers (initial-when-online, `online` event, `visibilitychange`→visible), and runs `runSync` debounced after local changes (expose `sync()` that components call after a mutation). `signOutAndWipe` reads `getDirtyCount` + `useOnlineStatus`, applies `signOutDecision`, and for `sync-then-wipe`/`confirm-then-wipe`/`wipe` performs: (sync) → (confirm via `window.confirm`) → `deleteListDb(userId)` → navigate to `/auth/signout`. Use **render-time** state only; the trigger wiring belongs in event listeners registered imperatively (allowed — these are real browser events, not derived state). Verification: typecheck/lint/build + e2e.

- [ ] **Step 1: Write the online-status hook**

```ts
// lib/offline/useOnlineStatus.ts
"use client";
import { useSyncExternalStore } from "react";

function subscribe(cb: () => void): () => void {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
}

export function useOnlineStatus(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true, // SSR: assume online
  );
}
```

- [ ] **Step 2: Write the provider**

```tsx
// lib/offline/OfflineProvider.tsx
"use client";
import { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import { openListDb, loadOrCreateKey, deleteListDb, deleteForeignDbs, type ListDb } from "./db";
import { runSync, getDirtyCount } from "./sync";
import { signOutDecision } from "./signout-decision";
import { useOnlineStatus } from "./useOnlineStatus";

type OfflineCtx = {
  db: ListDb;
  cryptoKey: CryptoKey;
  online: boolean;
  syncing: boolean;
  pending: number;
  sync: () => void;
  signOutAndWipe: () => Promise<void>;
};

const Ctx = createContext<OfflineCtx | null>(null);

export function useOffline(): OfflineCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useOffline must be used within OfflineProvider");
  return v;
}

export function OfflineProvider({ userId, children }: { userId: string; children: React.ReactNode }) {
  const online = useOnlineStatus();
  const [ready, setReady] = useState<{ db: ListDb; cryptoKey: CryptoKey } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [pending, setPending] = useState(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // One-time setup: open DB, load key, purge foreign DBs. (Imperative browser
  // setup — not derived state. Cleanup on unmount/user change.)
  useEffect(() => {
    let cancelled = false;
    const db = openListDb(userId);
    (async () => {
      await deleteForeignDbs(userId);
      const cryptoKey = await loadOrCreateKey(db);
      if (!cancelled) setReady({ db, cryptoKey });
    })();
    return () => {
      cancelled = true;
      db.close();
    };
  }, [userId]);

  const doSync = useCallback(async () => {
    if (!ready || !navigator.onLine) return;
    setSyncing(true);
    try {
      await runSync(ready.db, ready.cryptoKey);
    } finally {
      setSyncing(false);
      setPending(await getDirtyCount(ready.db));
    }
  }, [ready]);

  const sync = useCallback(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void doSync(), 400);
  }, [doSync]);

  // Foreground triggers: initial-when-ready-online, online event, tab visible.
  useEffect(() => {
    if (!ready) return;
    void doSync();
    const onOnline = () => void doSync();
    const onVisible = () => { if (document.visibilityState === "visible") void doSync(); };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    void getDirtyCount(ready.db).then(setPending);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ready, doSync]);

  const signOutAndWipe = useCallback(async () => {
    if (!ready) { window.location.assign("/auth/signout"); return; }
    const dirty = await getDirtyCount(ready.db);
    const decision = signOutDecision(dirty, navigator.onLine);
    if (decision === "sync-then-wipe") await doSync();
    if (decision === "confirm-then-wipe") {
      const ok = window.confirm(`${dirty} unsynced change(s) will be lost. Sign out anyway?`);
      if (!ok) return;
    }
    await deleteListDb(userId);
    window.location.assign("/auth/signout");
  }, [ready, doSync, userId]);

  if (!ready) return null; // brief: DB opening + key load
  return (
    <Ctx.Provider value={{ db: ready.db, cryptoKey: ready.cryptoKey, online, syncing, pending, sync, signOutAndWipe }}>
      {children}
    </Ctx.Provider>
  );
}
```

*(`eslint-plugin-react-hooks` may flag the imperative `useEffect`s — these are legitimate subscription/setup effects, not derived-state effects, so they comply with the project's "no `useEffect` for derived state" rule. If lint objects to a specific line, address the real issue; do not blanket-disable.)*

- [ ] **Step 3: Mount in the app layout**

Modify `app/(app)/layout.tsx`: capture the user id from the existing `requireUser()` call and wrap the existing children:

```tsx
// inside app/(app)/layout.tsx, after the requireUser() gate
const { userId } = await requireUser(); // if it already destructures, reuse it
// ...
return (
  <OfflineProvider userId={userId}>
    {/* existing shell/children */}
  </OfflineProvider>
);
```

Confirm `requireUser()`'s return shape in `lib/dal/session.ts`; if it returns `{ userId }` use it, otherwise read the id from `verifySession()`. **Do not** render the user's email/name into the shell (privacy invariant — the cached `/list` shell must stay PII-free).

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add lib/offline/useOnlineStatus.ts lib/offline/OfflineProvider.tsx "app/(app)/layout.tsx"
git commit -m "feat: add offline provider with foreground sync triggers and guarded sign-out"
```

---

## Task 12: `/list` becomes a local-first, data-free screen

**Files:**
- Modify: `app/(app)/list/page.tsx` — render the data-free shell (no `getItems()`).
- Modify: `app/(app)/list/ListView.tsx` — read from Dexie via `useLiveQuery`; mutate via `lib/offline/items.ts`; trigger `sync()` after each change; render the sync-status affordance.
- Modify: `app/(app)/list/ItemSheet.tsx` — submit through the local-write helper (keep its existing render-time-reset UI).

**Interfaces:**
- Consumes: `useOffline` (Task 11); `useLiveQuery` (`dexie-react-hooks`); `displayItems`, `addLocalItem`, `toggleLocalItem`, `editLocalItem`, `deleteLocalItem`, `clearCheckedLocal` (Task 9); `groupItems` (`lib/shopping/group.ts`); the default `listId`.

**Notes on the default list id:** offline, the client needs a `listId` for new items. On first online sync, `getChangesSince` returns the user's items (each carries `list_id`); persist that into `meta` (`defaultListId`). If the store is empty and offline with no known list id, mint a client UUID for the default list and store it in `meta` — the server's `getOrCreateDefaultList` idempotency + the unique index reconcile it on first sync. (Implementation detail: add `defaultListId` handling to `OfflineProvider`/`items` — fold a tiny helper `getOrInitListId(db)` into `lib/offline/db.ts` returning a stored or freshly-minted-and-stored UUID.)

- [ ] **Step 1: Data-free `page.tsx`**

```tsx
// app/(app)/list/page.tsx
import { ListView } from "./ListView";

// No getItems(): the page renders no list data server-side so its shell is
// cacheable for offline use without storing any authenticated data.
export default function ListPage() {
  return <ListView />;
}
```

- [ ] **Step 2: `ListView.tsx` reads Dexie + mutates locally**

Rewrite the data source and handlers (keep the existing presentational structure — grouping, rows, inline-add, ItemSheet, Clear-checked, plus the desktop reflow from Phase 4):

```tsx
// app/(app)/list/ListView.tsx (key parts)
"use client";
import { useLiveQuery } from "dexie-react-hooks";
import { useOffline } from "@/lib/offline/OfflineProvider";
import { getOrInitListId } from "@/lib/offline/db";
import {
  displayItems, addLocalItem, toggleLocalItem, editLocalItem, deleteLocalItem, clearCheckedLocal,
} from "@/lib/offline/items";
import { groupItems } from "@/lib/shopping/group";

export function ListView() {
  const { db, cryptoKey, online, syncing, pending, sync } = useOffline();
  const items = useLiveQuery(() => displayItems(db, cryptoKey), [db, cryptoKey], []);
  const groups = groupItems(items ?? []);

  async function withSync(fn: () => Promise<void>) {
    await fn();
    sync();
  }

  const onAdd = (input: Parameters<typeof addLocalItem>[3]) =>
    withSync(async () => addLocalItem(db, cryptoKey, await getOrInitListId(db), input));
  const onToggle = (id: string, checked: boolean) => withSync(() => toggleLocalItem(db, cryptoKey, id, checked));
  const onEdit = (id: string, patch: Parameters<typeof editLocalItem>[3]) =>
    withSync(() => editLocalItem(db, cryptoKey, id, patch));
  const onDelete = (id: string) => withSync(() => deleteLocalItem(db, cryptoKey, id));
  const onClearChecked = () => withSync(() => clearCheckedLocal(db, cryptoKey));

  return (
    <>
      <SyncStatus online={online} syncing={syncing} pending={pending} />
      {/* existing groups / inline-add / ItemSheet / Clear-checked UI, wired to the handlers above */}
    </>
  );
}
```

Add a small presentational `SyncStatus` (offline · syncing · synced · `N pending`) — a few spans with the dark-editorial tokens; no new dependency. Remove the old `useState(initialItems)` mirror, the render-time reset, and all calls to the deleted Phase-3 server actions.

- [ ] **Step 3: `ItemSheet.tsx` submits via the local helper**

Change `ItemSheet`'s `onSubmit` to call the `onAdd`/`onEdit` handlers passed from `ListView` (it already takes a submit callback — keep the signature, just point it at the local-write path). No `revalidatePath`, no server action import remains in this file.

- [ ] **Step 4: Add `getOrInitListId` to `lib/offline/db.ts`**

```ts
// lib/offline/db.ts (add)
export async function getOrInitListId(db: ListDb): Promise<string> {
  const existing = await db.meta.get("defaultListId");
  if (existing) return existing.value;
  const id = crypto.randomUUID();
  await db.meta.put({ key: "defaultListId", value: id });
  return id;
}
```

When `applyServerChanges` (Task 10) writes pulled items, also persist their `list_id` into `meta.defaultListId` if not set, so the client converges on the server's real default list id. Add that one-liner to `applyServerChanges`.

- [ ] **Step 5: Verify**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: green. Confirm no remaining import of the removed Phase-3 actions anywhere (`git grep -nE "addItemAction|editItemAction|toggleItemAction|deleteItemAction|clearCheckedAction"` returns nothing).

- [ ] **Step 6: Commit**

```bash
git add "app/(app)/list/page.tsx" "app/(app)/list/ListView.tsx" "app/(app)/list/ItemSheet.tsx" lib/offline/db.ts lib/offline/sync.ts
git commit -m "feat: make the shopping list local-first over the encrypted store"
```

---

## Task 13: Guarded sign-out control

**Files:**
- Modify: the sign-out UI control (find it: `git grep -nE "signout|Sign out|/auth/signout"` — likely in `components/ui/SideNav.tsx` and/or an account menu). Replace its direct navigation/form-post to `/auth/signout` with a button that calls `useOffline().signOutAndWipe()`.

**Interfaces:**
- Consumes: `useOffline().signOutAndWipe` (Task 11).

**Notes:** The existing sign-out is a server route (`app/auth/signout/route.ts`) reached by a link/form. The new control must run client-side first (wipe/sync/confirm) and then hit that route — `signOutAndWipe` already navigates to `/auth/signout` at the end, so the server sign-out still happens. Keep `app/auth/signout/route.ts` unchanged. If the control lives in a server component, extract a tiny `"use client"` `SignOutButton` that calls `signOutAndWipe`.

- [ ] **Step 1: Wire the control to `signOutAndWipe`**

```tsx
// e.g. components/ui/SignOutButton.tsx
"use client";
import { useOffline } from "@/lib/offline/OfflineProvider";

export function SignOutButton({ className }: { className?: string }) {
  const { signOutAndWipe } = useOffline();
  return (
    <button type="button" className={className} onClick={() => void signOutAndWipe()}>
      Sign out
    </button>
  );
}
```

Replace the existing sign-out link/form usage with `<SignOutButton />`. Ensure it renders inside the `OfflineProvider` subtree (it is — the provider wraps the `(app)` shell).

- [ ] **Step 2: Verify**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: green.

- [ ] **Step 3: Commit**

```bash
git add components app
git commit -m "feat: guard sign-out to flush or confirm unsynced offline edits"
```

---

## Task 14: Service worker — offline `/list` shell route

**Files:**
- Modify: `app/sw.ts` — add a `NetworkFirst` runtime route scoped to the `/list` document so it loads offline from cache; keep all other navigations `NetworkOnly` → `/~offline`.

**Interfaces:**
- Consumes: `serwist` (`NetworkFirst`, already-imported `NetworkOnly`).

**Notes:** The `/list` shell is data-free (Task 12), so caching its HTML stores no authenticated data — the privacy invariant holds. Online, `NetworkFirst` serves the fresh shell and revalidates the cache; offline, it serves the cached shell; if `/list` was never visited online, the existing document fallback serves `/~offline`. Verification: `pnpm build` emits `/sw.js`; manual e2e canary confirms offline `/list` loads.

- [ ] **Step 1: Add the `/list` runtime route**

```ts
// app/sw.ts — extend the runtimeCaching array (import NetworkFirst alongside NetworkOnly)
import { Serwist, NetworkOnly, NetworkFirst } from "serwist";
// ...
runtimeCaching: [
  {
    // Data-free /list shell: cache it so the page loads offline. It contains no
    // authenticated data (the page renders none server-side); list data comes
    // from the encrypted IndexedDB store at runtime.
    matcher: ({ request, url }) => request.mode === "navigate" && url.pathname === "/list",
    handler: new NetworkFirst({ cacheName: "list-shell" }),
  },
  {
    // All other navigations: never cached; offline falls back to /~offline.
    matcher: ({ request, url }) => request.mode === "navigate" && url.pathname !== "/list",
    handler: new NetworkOnly(),
  },
],
// fallbacks: keep the existing /~offline document fallback unchanged.
```

- [ ] **Step 2: Build and verify the SW emits**

Run: `pnpm build`
Expected: build succeeds under webpack; `public/sw.js` is generated and references the `list-shell` cache + `/~offline` fallback. (`git status` should show `public/sw.js` ignored.)

- [ ] **Step 3: Manual SW smoke (local)**

Run: `pnpm build && pnpm start`, open the app, visit `/list` online once, then DevTools → Network → Offline → reload `/list`.
Expected: `/list` loads its shell offline (not `/~offline`); other authed routes show `/~offline`.

- [ ] **Step 4: Commit**

```bash
git add app/sw.ts
git commit -m "feat: serve the data-free list shell offline via the service worker"
```

---

## Task 15: Documentation

**Files:**
- Modify: `README.md` — add an "Offline shopping list" section.

**Notes:** Document, in the project's existing README voice (no AI attribution): that the shopping list works offline; the encrypted per-user IndexedDB store (content-encrypted, non-extractable key, wiped on sign-out); the foreground sync model (last-edit-wins, `edited_at`/`updated_at` two-clock); that macro logging is online-only; and the local SW-testing reminder (`pnpm build && pnpm start`, not `pnpm dev`). Note migration `0005` and that `db-migrate`/`rls.yml` run on changes to migrations/DAL.

- [ ] **Step 1: Write the README section**

Add a concise section covering the points above. Keep it factual and short; link the spec.

- [ ] **Step 2: Verify**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Expected: all green (full suite + build, as the final gate of the phase).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document the offline shopping list and sync model"
```

---

## Self-Review (completed by the plan author)

- **Spec coverage:** §2 decisions → Tasks 1–14; §3.2 store → Task 8; §3.3 crypto → Task 1; §3.4 read path → Task 12; §3.5 write path → Tasks 9, 12; §3.6 sync engine → Tasks 10, 11; §3.7 sign-out → Tasks 4, 11, 13; §3.8 migration/RPC/DAL → Tasks 6, 7; §4 SW change → Task 14; §6 status UX → Task 12; §7 tests → Tasks 1–6 (unit) + Task 6 (RLS) + e2e notes; §9 README → Task 15. No uncovered requirement.
- **Placeholder scan:** every code step shows real code; the only deferred specifics are exact upstream dependency versions (Task 8, by the latest-stable rule) and adapting to the repo's exact existing identifiers (`ShoppingListItem` fields, `requireUser` return shape, the RLS test helpers, the sign-out control location) — each flagged with how to resolve at that step.
- **Type consistency:** `ContentFields`, `StoredItem`, `ServerItem`/`ServerItemRow`, `SyncMeta`/`LocalMeta`, `ReconcileAction`, `SignOutAction` are defined once and consumed with matching names; `toServerItem`/`reconcile`/`nextCursor`/`syncShoppingList`/`runSync`/`getDirtyCount`/`displayItems` signatures match across producer and consumer tasks.

---

## Known adaptation points (resolve against the live code during execution)

These are intentionally not guessed — confirm at the step that uses them:
1. `lib/shopping/types.ts` exact `ShoppingListItem` field names (esp. `createdAt`) — Task 9 maps to them.
2. `requireUser()` return shape in `lib/dal/session.ts` (`{ userId }` vs reading `verifySession()`) — Task 11.
3. The category Zod enum export name in `lib/validation/shopping-list.ts` — Task 5.
4. The RLS integration test file path + its `makeUser`/default-list helpers — Task 6.
5. The sign-out control's current location (SideNav / account menu) — Task 13.
6. Whether `app/(app)/layout.tsx` already destructures `requireUser()` — Task 11.
