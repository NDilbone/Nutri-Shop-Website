# Phase 6C — Shared Household List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let invited users share one shopping list inside a self-service household (create/invite/accept/leave) while keeping a private personal list, delivered as an RLS broaden plus client multi-list handling — not a sync or crypto rewrite.

**Architecture:** Three new tables (`households`, `household_members`, `household_invites`) and a nullable `shopping_lists.household_id` carry the relationship. Two SECURITY DEFINER predicates — `can_access_list(list_id)` and `is_household_member(household_id)` — broaden the existing item/list RLS from owner-only to "owner OR household member"; four self-gating SECURITY DEFINER RPCs run the lifecycle. The Phase-5 `sync_shopping_items` RPC and `getChangesSince` ship unchanged (no `list_id` filter; SECURITY INVOKER). The client's Dexie store gains a `lists` table and the sync engine gains a pre-push accessible-filter + prune-on-revocation; `/list` renders two labelled sections from local data.

**Tech Stack:** Next.js 16 App Router (Server Actions, RSC), Supabase Postgres + RLS, Dexie 4 (IndexedDB) + dexie-react-hooks, Web Crypto (AES-GCM, unchanged), Zod 4, Vitest (node env), TypeScript strict.

## Global Constraints

- **Dependencies — latest stable, verified at install.** No new runtime dependency is required (Dexie + dexie-react-hooks already present). Do not add one without verifying it is the current non-pre-release on npm. If any touched dependency is behind latest stable, flag it — do not silently upgrade in this phase.
- **No attribution.** Commit messages, code comments, and docs are authored by the repo owner. Never add `Co-Authored-By`, "Generated with…", or any AI/Claude/Anthropic mention to any commit, PR, comment, or file. Conventional-commit subjects, no trailers.
- **Migration is additive.** `0007_household_sharing.sql` only adds tables/columns/indexes/policies/functions and `drop policy`+`create policy` to broaden existing item/list RLS. No destructive change to existing data; existing personal lists keep working.
- **RLS = backstop, never bypassed for the list path.** `sync_shopping_items` stays `SECURITY INVOKER`; household writes go only through self-gating `SECURITY DEFINER` RPCs; household tables grant `authenticated` SELECT-only. No service-role in the list/sync/household-write path.
- **MFA gate inherited.** Every Server Action in `app/(app)/**` calls `requireStepUp()` (or `requireUser()` where step-up is not yet required) at its boundary — the 6B pattern. Do not add a new auth surface.
- **`/list` shell stays data-free.** `app/(app)/list/page.tsx` must never fetch authed data server-side. Pending-invite data reaches `/list` only via a client-side fetch after mount, never server-rendered into the cached shell.
- **Testing convention (matches the repo).** Pure functions get a full TDD cycle in `tests/**` (Vitest, node env): write the failing test, run it red, implement, run it green. Dexie/IndexedDB and React-component glue are **not** unit-tested (the repo keeps node-env pure tests only); they are verified by `pnpm typecheck` + `pnpm lint` + the explicit **Manual E2E** checklist in the final task. RLS/RPC behavior is verified by integration tests in `tests/rls/**` against a live local Supabase (gated by `HAS_SUPABASE_TEST_ENV`; CI runs them via `rls.yml` with `REQUIRE_SUPABASE_TESTS=1`).
- **Commands.** `pnpm test <path>` runs one file; `pnpm typecheck`, `pnpm lint`, `pnpm build` as usual. RLS tests need the local stack: `supabase db reset` (applies all migrations) then `REQUIRE_SUPABASE_TESTS=1 pnpm test tests/rls/<file>`.
- **Commit after every task.** Each task ends green and committed.

---

## File Structure

**Created**
- `lib/validation/household.ts` — Zod boundary schemas for household actions.
- `lib/dal/household.ts` — `server-only` DAL: RPC wrappers + member/household/invite reads.
- `lib/shopping/list-routing.ts` — pure `remapUnknownListIds` (server-side push remap).
- `lib/offline/lists.ts` — pure multi-list helpers (derive meta, accessible ids, prune plan, push filter, partition).
- `app/(app)/account/household-actions.ts` — Server Actions for the lifecycle.
- `app/(app)/account/HouseholdSection.tsx` — household management UI.
- `app/(app)/list/PendingInviteBanner.tsx` — client-fetched invite banner for `/list`.
- `supabase/migrations/0007_household_sharing.sql` — schema + RLS + RPCs.
- Tests: `tests/validation/household.test.ts`, `tests/rls/household.test.ts`, `tests/shopping/list-routing.test.ts`, `tests/offline/lists.test.ts`.

**Modified**
- `lib/dal/shopping-list.ts` — add `ListMeta` type + `getMyLists()`.
- `app/(app)/list/actions.ts` — `syncShoppingList` returns `{ items, cursor, lists }`, remaps only unknown `list_id`s; add `getPendingInvitesForBanner` action.
- `lib/offline/db.ts` — Dexie `version(2)` + `lists` store + `ListRow` + helpers.
- `lib/offline/sync.ts` — pre-push filter, upsert lists, prune-on-revocation, drop single-list convergence.
- `lib/offline/items.ts` — `displayItems` returns `DisplayItem` (adds `listId`); add `moveLocalItem`; `addLocalItem`/`clearCheckedLocal` already accept a list id (addLocalItem does; clearChecked becomes list-scoped).
- `app/(app)/list/ListView.tsx` — two-section render, lists from Dexie, add-target, move action, banner.
- `app/(app)/list/ItemSheet.tsx` — add-mode target toggle; edit-mode move control.
- `app/(app)/account/page.tsx` — load household data, render `HouseholdSection`.
- `README.md` — document households, the shared list, invites, the equal-write/LWW model.

---

## Task 1: Household validation schemas

**Files:**
- Create: `lib/validation/household.ts`
- Test: `tests/validation/household.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `householdNameSchema` (`z.ZodString`), `inviteEmailSchema` (`z.ZodString`), `respondInviteSchema` (`{ inviteId: string; accept: boolean }`). These are imported by Task 10's actions.

- [ ] **Step 1: Write the failing test**

```ts
// tests/validation/household.test.ts
import { describe, it, expect } from "vitest";
import {
  householdNameSchema,
  inviteEmailSchema,
  respondInviteSchema,
} from "@/lib/validation/household";

describe("household validation", () => {
  it("accepts a trimmed household name 1..100 chars", () => {
    expect(householdNameSchema.parse("  Smith family  ")).toBe("Smith family");
  });
  it("rejects an empty or oversized household name", () => {
    expect(householdNameSchema.safeParse("").success).toBe(false);
    expect(householdNameSchema.safeParse("x".repeat(101)).success).toBe(false);
  });
  it("normalizes invite email to trimmed lowercase", () => {
    expect(inviteEmailSchema.parse("  Foo@Example.COM ")).toBe("foo@example.com");
  });
  it("rejects a non-email", () => {
    expect(inviteEmailSchema.safeParse("not-an-email").success).toBe(false);
  });
  it("parses a respond payload with a uuid and boolean", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    expect(respondInviteSchema.parse({ inviteId: id, accept: true })).toEqual({ inviteId: id, accept: true });
    expect(respondInviteSchema.safeParse({ inviteId: "x", accept: true }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `pnpm test tests/validation/household.test.ts`
Expected: FAIL — `Cannot find module '@/lib/validation/household'`.

- [ ] **Step 3: Implement the schemas**

```ts
// lib/validation/household.ts
import { z } from "zod";

export const householdNameSchema = z.string().trim().min(1).max(100);

export const inviteEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email());

export const respondInviteSchema = z.object({
  inviteId: z.uuid(),
  accept: z.boolean(),
});
export type RespondInviteInput = z.infer<typeof respondInviteSchema>;
```

> Note: this repo is on Zod 4 — `z.email()` / `z.uuid()` are top-level (see `lib/validation/sync.ts`), not `z.string().email()`.

- [ ] **Step 4: Run the test; verify it passes**

Run: `pnpm test tests/validation/household.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add lib/validation/household.ts tests/validation/household.test.ts
git commit -m "feat(6c): household validation schemas"
```

---

## Task 2: Migration — schema + access RLS (`can_access_list`, `is_household_member`)

This task writes the **first half** of `0007`: the tables, the nullable column, indexes, grants, the two SECURITY DEFINER predicates, the broadened item/list policies, and SELECT-only RLS on the household tables. Lifecycle RPCs come in Task 3 (appended to the same file). Membership state for this task's tests is seeded directly via the service-role client.

**Files:**
- Create: `supabase/migrations/0007_household_sharing.sql`
- Test: `tests/rls/household.test.ts`

**Interfaces:**
- Consumes: existing `shopping_lists`, `shopping_list_items` (0004), `auth.users`, `is_admin()` pattern (0006).
- Produces (DB): tables `public.households`, `public.household_members`, `public.household_invites`; column `public.shopping_lists.household_id`; functions `public.is_household_member(uuid) → boolean`, `public.can_access_list(uuid) → boolean`. Task 4's `getMyLists` and Task 3's RPCs rely on these.

- [ ] **Step 1: Write the failing RLS test (access half)**

```ts
// tests/rls/household.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { HAS_SUPABASE_TEST_ENV, makeUser, admin } from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

if (process.env.REQUIRE_SUPABASE_TESTS === "1" && !HAS_SUPABASE_TEST_ENV) {
  throw new Error("REQUIRE_SUPABASE_TESTS=1 but SUPABASE_TEST_* env is missing");
}

let userA: SupabaseClient, userB: SupabaseClient, userC: SupabaseClient;
let aId: string, bId: string, cId: string;
let householdId: string, sharedListId: string;

describe.skipIf(!HAS_SUPABASE_TEST_ENV)("household sharing — access RLS", () => {
  beforeAll(async () => {
    userA = await makeUser("hh-a@example.com", "HhA-pw-1234!");
    userB = await makeUser("hh-b@example.com", "HhB-pw-1234!");
    userC = await makeUser("hh-c@example.com", "HhC-pw-1234!");
    aId = (await userA.auth.getUser()).data.user!.id;
    bId = (await userB.auth.getUser()).data.user!.id;
    cId = (await userC.auth.getUser()).data.user!.id;

    // Seed a household with A + B as members and a shared list, via service role.
    const svc = admin();
    const { data: hh, error: hhErr } = await svc
      .from("households").insert({ name: "Test household", created_by: aId }).select("id").single();
    if (hhErr) throw hhErr;
    householdId = hh!.id;
    const { error: mErr } = await svc.from("household_members")
      .insert([{ household_id: householdId, user_id: aId }, { household_id: householdId, user_id: bId }]);
    if (mErr) throw mErr;
    const { data: list, error: lErr } = await svc.from("shopping_lists")
      .insert({ owner_id: aId, is_default: false, household_id: householdId, name: "Household list" })
      .select("id").single();
    if (lErr) throw lErr;
    sharedListId = list!.id;
  });

  it("a member (B) can read the shared list row", async () => {
    const { data } = await userB.from("shopping_lists").select("id").eq("id", sharedListId);
    expect(data).toHaveLength(1);
  });

  it("a member (B) can insert an item into the shared list", async () => {
    const { error } = await userB.from("shopping_list_items").insert({ list_id: sharedListId, name: "Shared milk" });
    expect(error).toBeNull();
  });

  it("a member (B) can read items the other member (A) added", async () => {
    await userA.from("shopping_list_items").insert({ list_id: sharedListId, name: "From A" });
    const { data } = await userB.from("shopping_list_items").select("name").eq("list_id", sharedListId);
    expect((data ?? []).map((r) => r.name)).toContain("From A");
  });

  it("a non-member (C) CANNOT read the shared list or its items", async () => {
    const list = await userC.from("shopping_lists").select("id").eq("id", sharedListId);
    expect(list.data).toHaveLength(0);
    const items = await userC.from("shopping_list_items").select("id").eq("list_id", sharedListId);
    expect(items.data).toHaveLength(0);
  });

  it("a non-member (C) CANNOT insert into the shared list", async () => {
    const { error } = await userC.from("shopping_list_items").insert({ list_id: sharedListId, name: "spoof" });
    expect(error).not.toBeNull();
  });

  it("a member (B) CANNOT update or delete the shared LIST row (owner-only)", async () => {
    const upd = await userB.from("shopping_lists").update({ name: "renamed" }).eq("id", sharedListId).select();
    expect(upd.data ?? []).toHaveLength(0); // RLS denies silently
    const del = await userB.from("shopping_lists").delete().eq("id", sharedListId).select();
    expect(del.data ?? []).toHaveLength(0);
  });

  it("a member (B) can read the household and its member roster, a non-member (C) cannot", async () => {
    expect((await userB.from("households").select("id").eq("id", householdId)).data).toHaveLength(1);
    expect((await userB.from("household_members").select("user_id").eq("household_id", householdId)).data?.length).toBe(2);
    expect((await userC.from("households").select("id").eq("id", householdId)).data).toHaveLength(0);
    expect((await userC.from("household_members").select("user_id").eq("household_id", householdId)).data).toHaveLength(0);
  });

  it("personal lists remain isolated (regression): C cannot see A's personal list items", async () => {
    const { data: pl } = await admin().from("shopping_lists")
      .insert({ owner_id: aId, is_default: true }).select("id").single();
    await userA.from("shopping_list_items").insert({ list_id: pl!.id, name: "A personal" });
    const { data } = await userC.from("shopping_list_items").select("id").eq("list_id", pl!.id);
    expect(data).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `supabase db reset && REQUIRE_SUPABASE_TESTS=1 pnpm test tests/rls/household.test.ts`
Expected: FAIL in `beforeAll` — relation `public.households` does not exist.

- [ ] **Step 3: Write the migration (schema + grants + predicates + broadened RLS)**

```sql
-- supabase/migrations/0007_household_sharing.sql — Phase 6C: shared household list.
-- Sharing = an RLS broaden over the Phase-3 owner-only model. Items already derive
-- ownership through their list (no user_id on items), so only the list-access
-- predicate changes. sync_shopping_items (0005) and getChangesSince are unchanged.

-- ============ tables ============
create table public.households (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 100),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id      uuid not null references auth.users(id)        on delete cascade,
  joined_at    timestamptz not null default now(),
  primary key (household_id, user_id),
  unique (user_id)                       -- ≤1 household per user
);

create table public.household_invites (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references public.households(id) on delete cascade,
  invitee_user_id uuid not null references auth.users(id)        on delete cascade,
  invited_by      uuid not null references auth.users(id)        on delete cascade,
  status          text not null default 'pending'
                    check (status in ('pending','accepted','declined','revoked')),
  created_at      timestamptz not null default now()
);
create unique index household_invites_one_pending
  on public.household_invites (household_id, invitee_user_id) where status = 'pending';

-- shared-list seam on the existing table
alter table public.shopping_lists
  add column household_id uuid references public.households(id) on delete cascade;
create unique index shopping_lists_one_shared
  on public.shopping_lists (household_id)
  where household_id is not null and deleted_at is null;

-- ============ grants (RLS is the real gate; authenticated is SELECT-only on hh tables) ============
grant all on public.households        to service_role;
grant all on public.household_members to service_role;
grant all on public.household_invites to service_role;
grant select on public.households        to authenticated;
grant select on public.household_members to authenticated;
grant select on public.household_invites to authenticated;

-- ============ access predicates (SECURITY DEFINER, the 0006 is_admin() pattern) ============
-- is_household_member is its own function because the household_members SELECT policy
-- must check membership of household_members WITHOUT recursing into its own RLS.
create or replace function public.is_household_member(p_household_id uuid)
returns boolean language sql security definer set search_path = '' stable as $$
  select exists (
    select 1 from public.household_members m
    where m.household_id = p_household_id and m.user_id = (select auth.uid())
  );
$$;

create or replace function public.can_access_list(p_list_id uuid)
returns boolean language sql security definer set search_path = '' stable as $$
  select exists (
    select 1 from public.shopping_lists l
    where l.id = p_list_id and l.deleted_at is null and (
      l.owner_id = (select auth.uid())
      or public.is_household_member(l.household_id)
    )
  );
$$;

grant execute on function public.is_household_member(uuid) to authenticated;
grant execute on function public.can_access_list(uuid)     to authenticated;

-- ============ broaden shopping_list_items RLS: owner-only → can_access_list ============
drop policy "shopping_list_items_select_own" on public.shopping_list_items;
drop policy "shopping_list_items_insert_own" on public.shopping_list_items;
drop policy "shopping_list_items_update_own" on public.shopping_list_items;
drop policy "shopping_list_items_delete_own" on public.shopping_list_items;

create policy "shopping_list_items_select_member" on public.shopping_list_items
  for select using ( public.can_access_list(list_id) );
create policy "shopping_list_items_insert_member" on public.shopping_list_items
  for insert with check ( public.can_access_list(list_id) );
create policy "shopping_list_items_update_member" on public.shopping_list_items
  for update using ( public.can_access_list(list_id) )
             with check ( public.can_access_list(list_id) );
create policy "shopping_list_items_delete_member" on public.shopping_list_items
  for delete using ( public.can_access_list(list_id) );

-- ============ broaden shopping_lists SELECT only; writes stay owner-only ============
drop policy "shopping_lists_select_own" on public.shopping_lists;
create policy "shopping_lists_select_accessible" on public.shopping_lists
  for select using ( (select auth.uid()) = owner_id or public.can_access_list(id) );
-- insert/update/delete policies from 0004 are unchanged (owner-only).

-- ============ household-table RLS: SELECT-only, recursion-safe via the helper ============
alter table public.households        enable row level security;
alter table public.household_members enable row level security;
alter table public.household_invites enable row level security;

create policy "households_select_member" on public.households
  for select using ( public.is_household_member(id) );

create policy "household_members_select_same" on public.household_members
  for select using ( public.is_household_member(household_id) );

create policy "household_invites_select_mine" on public.household_invites
  for select using (
    invitee_user_id = (select auth.uid()) or invited_by = (select auth.uid()) );
-- No INSERT/UPDATE/DELETE policies for `authenticated` ⇒ writes are RPC-only (Task 3).
```

- [ ] **Step 4: Apply + run the access test green; confirm the personal-list suite still passes**

Run:
```bash
supabase db reset
REQUIRE_SUPABASE_TESTS=1 pnpm test tests/rls/household.test.ts
REQUIRE_SUPABASE_TESTS=1 pnpm test tests/rls/shopping-list.test.ts
```
Expected: household access suite PASS; the existing `shopping-list` isolation suite still PASS (the `can_access_list` owner branch preserves personal-list behavior).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0007_household_sharing.sql tests/rls/household.test.ts
git commit -m "feat(6c): household tables + can_access_list RLS broaden"
```

---

## Task 3: Migration — lifecycle RPCs (create / invite / respond / leave)

Appends the four self-gating RPCs to `0007` and extends the RLS test to drive the **real** lifecycle as three users.

**Files:**
- Modify: `supabase/migrations/0007_household_sharing.sql` (append RPCs)
- Modify: `tests/rls/household.test.ts` (add a lifecycle describe block)

**Interfaces:**
- Consumes: tables + predicates from Task 2; `auth.users` (email lookup; `grant select on auth.users to postgres` already exists from 0006).
- Produces (DB RPCs): `create_household(p_name text) → uuid`, `invite_to_household(p_email text) → void`, `respond_to_invite(p_invite_id uuid, p_accept boolean) → void`, `leave_household() → void`. Task 10's DAL calls these.

- [ ] **Step 1: Write the failing lifecycle test**

```ts
// append to tests/rls/household.test.ts
describe.skipIf(!HAS_SUPABASE_TEST_ENV)("household sharing — lifecycle RPCs", () => {
  let uA: SupabaseClient, uB: SupabaseClient, uC: SupabaseClient;
  let bEmail: string, cEmail: string, hhId: string, listId: string;

  beforeAll(async () => {
    bEmail = "life-b@example.com"; cEmail = "life-c@example.com";
    uA = await makeUser("life-a@example.com", "LifeA-pw-1234!");
    uB = await makeUser(bEmail, "LifeB-pw-1234!");
    uC = await makeUser(cEmail, "LifeC-pw-1234!");
  });

  it("create_household creates a household, membership, and exactly one shared list", async () => {
    const { data, error } = await uA.rpc("create_household", { p_name: "Lifecycle home" });
    expect(error).toBeNull();
    hhId = data as string;
    const { data: list } = await uA.from("shopping_lists").select("id, household_id").eq("household_id", hhId);
    expect(list).toHaveLength(1);
    listId = list![0].id;
  });

  it("create_household a second time for the same user fails closed", async () => {
    const { error } = await uA.rpc("create_household", { p_name: "Second" });
    expect(error).not.toBeNull();
  });

  it("invite_to_household for an unknown email is a silent no-op (no error, no invite)", async () => {
    const { error } = await uA.rpc("invite_to_household", { p_email: "nobody@example.com" });
    expect(error).toBeNull();
    const { data } = await admin().from("household_invites").select("id").eq("household_id", hhId);
    expect(data).toHaveLength(0);
  });

  it("invite_to_household creates exactly one pending invite for an eligible user; repeat is idempotent", async () => {
    expect((await uA.rpc("invite_to_household", { p_email: bEmail })).error).toBeNull();
    expect((await uA.rpc("invite_to_household", { p_email: bEmail })).error).toBeNull();
    const { data } = await admin().from("household_invites").select("id, status").eq("household_id", hhId);
    expect(data).toHaveLength(1);
    expect(data![0].status).toBe("pending");
  });

  it("a non-member cannot invite", async () => {
    const { error } = await uC.rpc("invite_to_household", { p_email: bEmail });
    expect(error).not.toBeNull(); // uC is in no household
  });

  it("invitee B sees the pending invite and accepts; B becomes a member and can use the shared list", async () => {
    const { data: invites } = await uB.from("household_invites").select("id").eq("invitee_user_id",
      (await uB.auth.getUser()).data.user!.id);
    expect(invites!.length).toBe(1);
    const { error } = await uB.rpc("respond_to_invite", { p_invite_id: invites![0].id, p_accept: true });
    expect(error).toBeNull();
    const { error: insErr } = await uB.from("shopping_list_items").insert({ list_id: listId, name: "B joined item" });
    expect(insErr).toBeNull();
  });

  it("after B leaves, B can no longer read or write the shared list", async () => {
    expect((await uB.rpc("leave_household")).error).toBeNull();
    expect((await uB.from("shopping_lists").select("id").eq("id", listId)).data).toHaveLength(0);
    const { error } = await uB.from("shopping_list_items").insert({ list_id: listId, name: "after leave" });
    expect(error).not.toBeNull();
  });

  it("when the last member (A) leaves, the household and its shared list are deleted", async () => {
    expect((await uA.rpc("leave_household")).error).toBeNull();
    const { data } = await admin().from("households").select("id").eq("id", hhId);
    expect(data).toHaveLength(0);
    const { data: list } = await admin().from("shopping_lists").select("id").eq("household_id", hhId);
    expect(list).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `REQUIRE_SUPABASE_TESTS=1 pnpm test tests/rls/household.test.ts`
Expected: FAIL — `function public.create_household(...) does not exist`.

- [ ] **Step 3: Append the RPCs to `0007_household_sharing.sql`**

```sql
-- ============ lifecycle RPCs (self-gating SECURITY DEFINER, the 0006 admin_* pattern) ============

create or replace function public.create_household(p_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_hh uuid;
begin
  if v_uid is null then raise exception 'forbidden' using errcode = 'insufficient_privilege'; end if;
  if exists (select 1 from public.household_members where user_id = v_uid) then
    raise exception 'already in a household' using errcode = 'insufficient_privilege';
  end if;
  insert into public.households (name, created_by) values (trim(p_name), v_uid) returning id into v_hh;
  insert into public.household_members (household_id, user_id) values (v_hh, v_uid);
  insert into public.shopping_lists (owner_id, is_default, household_id, name)
    values (v_uid, false, v_hh, 'Household list');
  return v_hh;
end;
$$;

create or replace function public.invite_to_household(p_email text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid    uuid := (select auth.uid());
  v_hh     uuid;
  v_target uuid;
begin
  select household_id into v_hh from public.household_members where user_id = v_uid;
  if v_hh is null then raise exception 'forbidden' using errcode = 'insufficient_privilege'; end if;

  select id into v_target from auth.users where lower(email) = lower(trim(p_email));
  -- Silent no-op on every ineligible case — no account-enumeration oracle.
  if v_target is null then return; end if;
  if exists (select 1 from public.household_members where user_id = v_target) then return; end if;
  if exists (select 1 from public.household_invites
             where household_id = v_hh and invitee_user_id = v_target and status = 'pending') then
    return;
  end if;

  insert into public.household_invites (household_id, invitee_user_id, invited_by)
    values (v_hh, v_target, v_uid);
end;
$$;

create or replace function public.respond_to_invite(p_invite_id uuid, p_accept boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_hh uuid;
begin
  select household_id into v_hh from public.household_invites
    where id = p_invite_id and invitee_user_id = v_uid and status = 'pending';
  if v_hh is null then raise exception 'forbidden' using errcode = 'insufficient_privilege'; end if;

  if p_accept then
    if exists (select 1 from public.household_members where user_id = v_uid) then
      raise exception 'already in a household' using errcode = 'insufficient_privilege';
    end if;
    insert into public.household_members (household_id, user_id) values (v_hh, v_uid);
    update public.household_invites set status = 'accepted' where id = p_invite_id;
  else
    update public.household_invites set status = 'declined' where id = p_invite_id;
  end if;
end;
$$;

create or replace function public.leave_household()
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_hh uuid; v_left int;
begin
  select household_id into v_hh from public.household_members where user_id = v_uid;
  if v_hh is null then raise exception 'forbidden' using errcode = 'insufficient_privilege'; end if;
  delete from public.household_members where household_id = v_hh and user_id = v_uid;
  select count(*) into v_left from public.household_members where household_id = v_hh;
  if v_left = 0 then
    delete from public.households where id = v_hh;  -- cascades shared list + items + invites
  end if;
end;
$$;

grant execute on function public.create_household(text)            to authenticated;
grant execute on function public.invite_to_household(text)         to authenticated;
grant execute on function public.respond_to_invite(uuid, boolean)  to authenticated;
grant execute on function public.leave_household()                 to authenticated;
```

- [ ] **Step 4: Apply + run the lifecycle test green**

Run: `supabase db reset && REQUIRE_SUPABASE_TESTS=1 pnpm test tests/rls/household.test.ts`
Expected: both describe blocks PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0007_household_sharing.sql tests/rls/household.test.ts
git commit -m "feat(6c): household lifecycle RPCs (create/invite/respond/leave)"
```

---

## Task 4: Push remap helper + `getMyLists` + `syncShoppingList` returns lists

**Files:**
- Create: `lib/shopping/list-routing.ts`
- Test: `tests/shopping/list-routing.test.ts`
- Modify: `lib/dal/shopping-list.ts` (add `ListMeta` + `getMyLists`)
- Modify: `app/(app)/list/actions.ts`

**Interfaces:**
- Consumes: `ServerItem` shape (`lib/offline/payload.ts`), `getOrCreateDefaultList` + `getChangesSince` (`lib/dal/shopping-list.ts`).
- Produces:
  - `remapUnknownListIds(items: {list_id: string}[], knownListIds: Set<string>, fallbackListId: string): T[]` — pure.
  - `ListMeta = { id: string; householdId: string | null; name: string; isDefault: boolean }` and `getMyLists(): Promise<ListMeta[]>`.
  - `syncShoppingList(raw) → { items: ServerItemRow[]; cursor: string; lists: ListMeta[] }`. The client (Task 7) consumes `lists`.

- [ ] **Step 1: Write the failing test for the remap helper**

```ts
// tests/shopping/list-routing.test.ts
import { describe, it, expect } from "vitest";
import { remapUnknownListIds } from "@/lib/shopping/list-routing";

const PERSONAL = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const HOUSEHOLD = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

describe("remapUnknownListIds", () => {
  const known = new Set([PERSONAL, HOUSEHOLD]);

  it("passes through items whose list_id is a known real list", () => {
    const items = [{ list_id: PERSONAL, name: "a" }, { list_id: HOUSEHOLD, name: "b" }];
    expect(remapUnknownListIds(items, known, PERSONAL)).toEqual(items);
  });

  it("rewrites an unknown (client-minted placeholder) list_id to the fallback personal list", () => {
    const items = [{ list_id: "ffffffff-ffff-ffff-ffff-ffffffffffff", name: "x" }];
    expect(remapUnknownListIds(items, known, PERSONAL)).toEqual([{ list_id: PERSONAL, name: "x" }]);
  });

  it("does not mutate the input array or its items", () => {
    const items = [{ list_id: "unknown", name: "x" }];
    const out = remapUnknownListIds(items, known, PERSONAL);
    expect(items[0].list_id).toBe("unknown");
    expect(out[0]).not.toBe(items[0]);
  });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `pnpm test tests/shopping/list-routing.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

```ts
// lib/shopping/list-routing.ts
/** Push-time routing: a brand-new user may mint a placeholder list_id offline before
 *  the server list exists (Phase 5). Items already pointing at a real accessible list
 *  (personal OR household) pass through untouched; only an unknown placeholder is
 *  rewritten to the caller's real personal default list. RLS still gates every row. */
export function remapUnknownListIds<T extends { list_id: string }>(
  items: T[],
  knownListIds: Set<string>,
  fallbackListId: string,
): T[] {
  return items.map((i) => (knownListIds.has(i.list_id) ? i : { ...i, list_id: fallbackListId }));
}
```

- [ ] **Step 4: Run the test; verify it passes**

Run: `pnpm test tests/shopping/list-routing.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add `ListMeta` + `getMyLists` to the DAL**

Append to `lib/dal/shopping-list.ts`:

```ts
export type ListMeta = { id: string; householdId: string | null; name: string; isDefault: boolean };

/** Every list the caller can access (personal default + the household shared list, if a
 *  member). RLS (shopping_lists_select_accessible) scopes the result; no list_id filter. */
export async function getMyLists(): Promise<ListMeta[]> {
  await requireUser();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("shopping_lists")
    .select("id, household_id, name, is_default")
    .is("deleted_at", null);
  if (error) throw new Error(`getMyLists failed: ${error.message}`);
  return (data ?? []).map((r: { id: string; household_id: string | null; name: string; is_default: boolean }) => ({
    id: r.id, householdId: r.household_id, name: r.name, isDefault: r.is_default,
  }));
}
```

- [ ] **Step 6: Update `syncShoppingList` to return lists + remap only unknown ids**

Replace the body of `app/(app)/list/actions.ts`'s `syncShoppingList`:

```ts
"use server";

import {
  getChangesSince,
  getMyLists,
  getOrCreateDefaultList,
  type ListMeta,
  type ServerItemRow,
} from "@/lib/dal/shopping-list";
import { requireStepUp } from "@/lib/dal/session";
import { createClient } from "@/lib/supabase/server";
import { syncInputSchema } from "@/lib/validation/sync";
import { remapUnknownListIds } from "@/lib/shopping/list-routing";

export async function syncShoppingList(
  raw: unknown,
): Promise<{ items: ServerItemRow[]; cursor: string; lists: ListMeta[] }> {
  await requireStepUp();
  const input = syncInputSchema.parse(raw);

  // Resolve the caller's real lists. getOrCreateDefaultList guarantees a personal list
  // exists (a brand-new user has none yet); getMyLists then returns personal + (if a
  // member) the household shared list.
  const { id: personalListId } = await getOrCreateDefaultList();
  const lists = await getMyLists();
  const knownIds = new Set(lists.map((l) => l.id));

  if (input.dirtyItems.length > 0) {
    // Pass real personal/household ids through; rewrite only client-minted placeholders.
    const items = remapUnknownListIds(input.dirtyItems, knownIds, personalListId);
    const supabase = await createClient();
    const { error } = await supabase.rpc("sync_shopping_items", { p_items: items });
    if (error) throw new Error("sync push failed");
  }

  const changes = await getChangesSince(input.cursor);
  return { ...changes, lists };
}
```

- [ ] **Step 7: Verify the push contract still holds at the DB level**

Run: `REQUIRE_SUPABASE_TESTS=1 pnpm test tests/rls/shopping-list.test.ts`
Expected: PASS — the existing "real owned default list lands" and "rejects orphan list_id" tests still pass (a placeholder now maps to `personalListId`; a real household id, when present, is in `knownIds` and passes through).

- [ ] **Step 8: Typecheck + commit**

```bash
pnpm typecheck
pnpm test tests/shopping/list-routing.test.ts
git add lib/shopping/list-routing.ts tests/shopping/list-routing.test.ts lib/dal/shopping-list.ts app/(app)/list/actions.ts
git commit -m "feat(6c): syncShoppingList returns accessible lists; remap only placeholder ids"
```

---

## Task 5: Pure offline multi-list helpers

The heart of prune-on-revocation and the pre-push filter — all pure, all unit-tested.

**Files:**
- Create: `lib/offline/lists.ts`
- Test: `tests/offline/lists.test.ts`

**Interfaces:**
- Consumes: `ListMeta` (`lib/dal/shopping-list.ts`).
- Produces:
  - `type LocalListMeta = { id: string; householdId: string | null; name: string; kind: "personal" | "household" }`
  - `toLocalListMeta(lists: ListMeta[]): LocalListMeta[]`
  - `accessibleListIds(lists: { id: string }[]): Set<string>`
  - `listsToPrune(localIds: string[], accessible: Set<string>): string[]`
  - `partitionPushable<T extends { listId: string }>(dirty: T[], accessible: Set<string>): { push: T[]; drop: T[] }`
  - `personalListId(lists: LocalListMeta[]): string | null` / `householdList(lists: LocalListMeta[]): LocalListMeta | null`
  Task 7 (sync) and Task 8 (display) consume these.

- [ ] **Step 1: Write the failing test**

```ts
// tests/offline/lists.test.ts
import { describe, it, expect } from "vitest";
import {
  toLocalListMeta, accessibleListIds, listsToPrune, partitionPushable,
  personalListId, householdList,
} from "@/lib/offline/lists";

const P = "11111111-1111-1111-1111-111111111111";
const H = "22222222-2222-2222-2222-222222222222";

describe("offline list helpers", () => {
  const lists = [
    { id: P, householdId: null, name: "Shopping list", isDefault: true },
    { id: H, householdId: "hh1", name: "Household list", isDefault: false },
  ];

  it("derives kind from householdId", () => {
    const local = toLocalListMeta(lists);
    expect(local.find((l) => l.id === P)!.kind).toBe("personal");
    expect(local.find((l) => l.id === H)!.kind).toBe("household");
  });

  it("accessibleListIds is the set of returned list ids", () => {
    expect(accessibleListIds(lists)).toEqual(new Set([P, H]));
  });

  it("listsToPrune returns local ids no longer accessible", () => {
    expect(listsToPrune([P, H], new Set([P]))).toEqual([H]); // household revoked
    expect(listsToPrune([P], new Set([P, H]))).toEqual([]);  // nothing to prune
  });

  it("partitionPushable splits dirty rows by current access", () => {
    const dirty = [{ listId: P, id: "a" }, { listId: H, id: "b" }, { listId: "gone", id: "c" }];
    const { push, drop } = partitionPushable(dirty, new Set([P, H]));
    expect(push.map((r) => r.id)).toEqual(["a", "b"]);
    expect(drop.map((r) => r.id)).toEqual(["c"]);
  });

  it("personalListId / householdList select by kind", () => {
    const local = toLocalListMeta(lists);
    expect(personalListId(local)).toBe(P);
    expect(householdList(local)!.id).toBe(H);
    expect(householdList(toLocalListMeta([lists[0]]))).toBeNull();
  });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `pnpm test tests/offline/lists.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helpers**

```ts
// lib/offline/lists.ts
import type { ListMeta } from "@/lib/dal/shopping-list";

export type ListKind = "personal" | "household";
export type LocalListMeta = { id: string; householdId: string | null; name: string; kind: ListKind };

export function toLocalListMeta(lists: ListMeta[]): LocalListMeta[] {
  return lists.map((l) => ({
    id: l.id,
    householdId: l.householdId,
    name: l.name,
    kind: l.householdId ? "household" : "personal",
  }));
}

export function accessibleListIds(lists: { id: string }[]): Set<string> {
  return new Set(lists.map((l) => l.id));
}

export function listsToPrune(localIds: string[], accessible: Set<string>): string[] {
  return localIds.filter((id) => !accessible.has(id));
}

export function partitionPushable<T extends { listId: string }>(
  dirty: T[],
  accessible: Set<string>,
): { push: T[]; drop: T[] } {
  const push: T[] = [];
  const drop: T[] = [];
  for (const row of dirty) (accessible.has(row.listId) ? push : drop).push(row);
  return { push, drop };
}

export function personalListId(lists: LocalListMeta[]): string | null {
  return lists.find((l) => l.kind === "personal")?.id ?? null;
}

export function householdList(lists: LocalListMeta[]): LocalListMeta | null {
  return lists.find((l) => l.kind === "household") ?? null;
}
```

- [ ] **Step 4: Run the test; verify it passes**

Run: `pnpm test tests/offline/lists.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/offline/lists.ts tests/offline/lists.test.ts
git commit -m "feat(6c): pure offline multi-list helpers (prune, push-filter, partition)"
```

---

## Task 6: Dexie `version(2)` + `lists` store

**Files:**
- Modify: `lib/offline/db.ts`

**Interfaces:**
- Consumes: `LocalListMeta` (`lib/offline/lists.ts`).
- Produces: `ListRow` type; `db.lists` table; `upsertLocalLists(db, rows)`, `readLocalLists(db)`, `deleteListAndItems(db, listId)`. Task 7 (sync) and Task 8 (ListView) consume these.

- [ ] **Step 1: Add the `lists` store, type, and helpers**

In `lib/offline/db.ts`, add the import and type, bump the Dexie version, and add helpers:

```ts
import type { LocalListMeta } from "./lists";

export type ListRow = LocalListMeta; // { id, householdId, name, kind }
```

Add `lists` to the class (declare the table and a `version(2)` upgrade that keeps `version(1)` intact):

```ts
export class ListDb extends Dexie {
  items!: Table<StoredItem, string>;
  meta!: Table<MetaRow, string>;
  keyv!: Table<KeyRow, string>;
  lists!: Table<ListRow, string>;

  constructor(userId: string) {
    super(`ns-list-${userId}`);
    this.version(1).stores({
      items: "id, listId, dirty, updatedAt",
      meta: "key",
      keyv: "id",
    });
    // v2: add the lists store (additive — no data migration; it backfills from the
    // next sync's getMyLists). `kind` is indexed so personal/household reads are cheap.
    this.version(2).stores({
      items: "id, listId, dirty, updatedAt",
      meta: "key",
      keyv: "id",
      lists: "id, kind",
    });
  }
}
```

Add the helper functions at the end of the file:

```ts
export async function upsertLocalLists(db: ListDb, rows: ListRow[]): Promise<void> {
  await db.lists.bulkPut(rows);
}

export async function readLocalLists(db: ListDb): Promise<ListRow[]> {
  return db.lists.toArray();
}

/** Drop a list and every item belonging to it (prune-on-revocation). */
export async function deleteListAndItems(db: ListDb, listId: string): Promise<void> {
  await db.transaction("rw", db.items, db.lists, async () => {
    await db.items.where("listId").equals(listId).delete();
    await db.lists.delete(listId);
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (no type errors; `ListRow` resolves, `db.lists` typed).

- [ ] **Step 3: Commit**

```bash
git add lib/offline/db.ts
git commit -m "feat(6c): Dexie v2 lists store + list helpers"
```

---

## Task 7: Sync engine — pre-push filter, list upsert, prune-on-revocation

**Files:**
- Modify: `lib/offline/sync.ts`

**Interfaces:**
- Consumes: `partitionPushable`, `toLocalListMeta`, `accessibleListIds`, `listsToPrune` (`lib/offline/lists.ts`); `upsertLocalLists`, `deleteListAndItems` (`lib/offline/db.ts`); `syncShoppingList` returning `{ items, cursor, lists }` (Task 4).
- Produces: `runSync` populates `db.lists`, drops revoked lists+items, never pushes inaccessible rows. Behavior is otherwise the Phase-5 contract.

- [ ] **Step 1: Rework `runSync` for multi-list**

Replace `lib/offline/sync.ts` with:

```ts
// lib/offline/sync.ts
"use client";
import type { ListDb, StoredItem } from "./db";
import { EPOCH_CURSOR, upsertLocalLists, readLocalLists, deleteListAndItems } from "./db";
import { decryptContent, encryptContent } from "./crypto";
import { toServerItem } from "./payload";
import { reconcile } from "./reconcile";
import { toLocalListMeta, accessibleListIds, listsToPrune, partitionPushable } from "./lists";
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
    // 1. Collect + decrypt dirty rows, but only those whose list is still accessible.
    //    A list we lost access to (left/removed) must not poison the push batch — its
    //    dirty rows are dropped here and pruned below.
    const accessibleLocal = accessibleListIds(await readLocalLists(db));
    const dirtyAll = await db.items.where("dirty").equals(1).toArray();
    // On a brand-new client the lists store is empty (no sync yet); allow all so the
    // first push still works (the server remaps a placeholder id to the personal list).
    const { push: dirty } =
      accessibleLocal.size === 0
        ? { push: dirtyAll }
        : partitionPushable(dirtyAll.map((r) => ({ ...r, listId: r.listId })), accessibleLocal);

    const dirtyItems = await Promise.all(
      dirty.map(async (r) => {
        const c = await decryptContent(key, r.iv, r.cipher);
        return toServerItem({
          id: r.id, listId: r.listId, editedAt: r.editedAt, deletedAt: r.deletedAt,
          name: c.name, quantity: c.quantity, category: c.category, fdcId: c.fdcId, checked: c.checked,
        });
      }),
    );

    // 2. Push + pull + accessible lists in one round trip.
    const cursor = await readCursor(db);
    const result = await syncShoppingList({ dirtyItems, cursor });

    // 3. Persist the accessible lists, then prune any local list (and its items) no
    //    longer returned — this is how leave/remove clears a device.
    const localMeta = toLocalListMeta(result.lists);
    await upsertLocalLists(db, localMeta);
    const accessibleServer = accessibleListIds(result.lists);
    const localIds = (await readLocalLists(db)).map((l) => l.id);
    for (const goneId of listsToPrune(localIds, accessibleServer)) {
      await deleteListAndItems(db, goneId);
    }

    // 4. Clear dirty on pushed rows whose editedAt is unchanged since the snapshot
    //    (Phase-5 invariant — flips reconcile to "overwrite" so the echo can stamp
    //    the server updated_at). Rows dropped in step 1 are skipped naturally.
    await db.transaction("rw", db.items, async () => {
      for (const r of dirty) {
        const cur = await db.items.get(r.id);
        if (cur && cur.editedAt === r.editedAt) {
          await db.items.update(r.id, { dirty: 0, serverKnown: 1 });
        }
      }
    });

    // 5. Reconcile pulled rows (incl. the echo of just-pushed rows).
    await applyServerChanges(db, key, result.items);

    // 6. Advance cursor.
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
  // NOTE: the Phase-5 `meta.defaultListId = items[0].list_id` convergence is removed —
  // the lists store (step 3) is now the source of truth for list ids, and items[0] may
  // belong to the shared list, which would have mis-set the personal default.
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. (The pure logic in steps 1/3 is already covered by `tests/offline/lists.test.ts`; Dexie wiring is verified in the final Manual E2E.)

- [ ] **Step 3: Confirm the existing pure offline suite is still green**

Run: `pnpm test tests/offline/`
Expected: PASS — `crypto`, `payload`, `reconcile`, `signout-decision`, and the new `lists` tests all pass (no behavior change to those modules).

- [ ] **Step 4: Commit**

```bash
git add lib/offline/sync.ts
git commit -m "feat(6c): multi-list sync — push filter, list upsert, prune-on-revocation"
```

---

## Task 8: `displayItems` carries `listId`; ListView renders two sections

**Files:**
- Modify: `lib/offline/items.ts` (`displayItems` → `DisplayItem[]`)
- Modify: `app/(app)/list/ListView.tsx`
- Test: extend `tests/offline/lists.test.ts` with a pure `splitByList` helper test
- Modify: `lib/offline/lists.ts` (add `splitByList`)

**Interfaces:**
- Consumes: `groupItems` (`lib/shopping/group.ts`), `LocalListMeta`, `personalListId`, `householdList` (`lib/offline/lists.ts`), `readLocalLists` (`lib/offline/db.ts`).
- Produces: `DisplayItem = ShoppingListItem & { listId: string }`; `splitByList(items, personalId, householdId)`; a two-section ListView.

- [ ] **Step 1: Write the failing `splitByList` test**

Append to `tests/offline/lists.test.ts`:

```ts
import { splitByList } from "@/lib/offline/lists";

describe("splitByList", () => {
  const item = (id: string, listId: string) => ({
    id, listId, name: id, quantity: null, category: null, fdcId: null, checked: false, createdAt: "t",
  });
  it("partitions display items into personal vs household by listId", () => {
    const items = [item("a", "P"), item("b", "H"), item("c", "P")];
    const { personal, household } = splitByList(items, "P", "H");
    expect(personal.map((i) => i.id)).toEqual(["a", "c"]);
    expect(household.map((i) => i.id)).toEqual(["b"]);
  });
  it("returns empty household when there is no household list id", () => {
    const items = [item("a", "P")];
    const { personal, household } = splitByList(items, "P", null);
    expect(personal).toHaveLength(1);
    expect(household).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `pnpm test tests/offline/lists.test.ts`
Expected: FAIL — `splitByList` is not exported.

- [ ] **Step 3: Add `splitByList` and the `DisplayItem` type**

Append to `lib/offline/lists.ts`:

```ts
import type { ShoppingListItem } from "@/lib/shopping/types";

export type DisplayItem = ShoppingListItem & { listId: string };

export function splitByList(
  items: DisplayItem[],
  personalId: string | null,
  householdId: string | null,
): { personal: DisplayItem[]; household: DisplayItem[] } {
  const personal = items.filter((i) => i.listId === personalId);
  const household = householdId ? items.filter((i) => i.listId === householdId) : [];
  return { personal, household };
}
```

- [ ] **Step 4: Run the test; verify it passes**

Run: `pnpm test tests/offline/lists.test.ts`
Expected: PASS (all blocks).

- [ ] **Step 5: Make `displayItems` return `DisplayItem[]`**

In `lib/offline/items.ts`, change the return type and push `listId`:

```ts
import type { ShoppingListItem, Category } from "@/lib/shopping/types";
import type { DisplayItem } from "./lists";
```

```ts
export async function displayItems(db: ListDb, key: CryptoKey): Promise<DisplayItem[]> {
  const rows = (await db.items.toArray()).filter((r) => r.deletedAt === null);
  const out: DisplayItem[] = [];
  for (const row of rows) {
    try {
      const c = await decryptContent(key, row.iv, row.cipher);
      out.push({
        id: row.id,
        listId: row.listId,
        name: c.name,
        quantity: c.quantity,
        category: c.category as Category | null,
        fdcId: c.fdcId,
        checked: c.checked,
        createdAt: row.editedAt,
      });
    } catch {
      await db.items.delete(row.id);
    }
  }
  return out;
}
```

- [ ] **Step 6: Render two sections in `ListView.tsx`**

Rework `app/(app)/list/ListView.tsx`. Read the `lists` store reactively, split items, and render a reusable `ListSection` per list. Full file:

```tsx
"use client";

import { useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useOffline } from "@/lib/offline/OfflineProvider";
import { getOrInitListId, readLocalLists } from "@/lib/offline/db";
import {
  displayItems, addLocalItem, toggleLocalItem, editLocalItem, deleteLocalItem,
  clearCheckedLocal, moveLocalItem,
} from "@/lib/offline/items";
import { personalListId as pickPersonalId, householdList as pickHousehold, splitByList, type DisplayItem } from "@/lib/offline/lists";
import { groupItems } from "@/lib/shopping/group";
import { CATEGORY_LABEL } from "@/lib/shopping/types";
import { ItemSheet, type ItemDraft } from "./ItemSheet";
import { SyncStatus } from "./SyncStatus";
import { PendingInviteBanner } from "./PendingInviteBanner";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

export function ListView() {
  const off = useOffline();
  const ready = off.status === "ready" ? off : null;
  const items = useLiveQuery(
    () => (ready ? displayItems(ready.db, ready.cryptoKey) : Promise.resolve([] as DisplayItem[])),
    [ready],
    [] as DisplayItem[],
  );
  const lists = useLiveQuery(() => (ready ? readLocalLists(ready.db) : Promise.resolve([])), [ready], []);

  const [editing, setEditing] = useState<DisplayItem | null>(null);

  if (off.status !== "ready") {
    return (
      <main className="p-4">
        <SyncStatus online={off.online} syncing={false} pending={0} error={off.status === "error" ? off.error : undefined} />
      </main>
    );
  }

  const { db, cryptoKey, online, syncing, pending, sync } = off;
  const personalId = pickPersonalId(lists ?? []);
  const household = pickHousehold(lists ?? []);
  const { personal, household: householdItems } = splitByList(items ?? [], personalId, household?.id ?? null);

  const withSync = async (fn: () => Promise<void>) => { await fn(); sync(); };

  const addTo = (listIdPromise: Promise<string> | string, draft: { name: string; quantity: string; category: string }) =>
    withSync(async () =>
      addLocalItem(db, cryptoKey, await listIdPromise, {
        name: draft.name, quantity: draft.quantity.trim() || null,
        category: (draft.category || null) as DisplayItem["category"], fdcId: null,
      }),
    );

  const onToggle = (id: string, checked: boolean) => withSync(() => toggleLocalItem(db, cryptoKey, id, checked));
  const onClear = (listId: string) => withSync(() => clearCheckedLocal(db, cryptoKey, listId));
  const onMove = (id: string, listId: string) => withSync(() => moveLocalItem(db, cryptoKey, id, listId));

  async function saveEdit(draft: ItemDraft) {
    if (!editing) return;
    await withSync(() => editLocalItem(db, cryptoKey, editing.id, {
      name: draft.name, quantity: draft.quantity.trim() || null, category: draft.category || null,
    }));
  }
  async function removeEditing() {
    if (!editing) return;
    await withSync(() => deleteLocalItem(db, cryptoKey, editing.id));
  }

  return (
    <main className="p-4">
      <div className="mb-3 flex items-start justify-between">
        <h1 className="text-lg font-semibold">Shopping list</h1>
        <SyncStatus online={online} syncing={syncing} pending={pending} />
      </div>

      <PendingInviteBanner online={online} />

      <ListSection
        title="Personal"
        items={personal}
        onAddName={(name) => addTo(getOrInitListId(db), { name, quantity: "", category: "" })}
        onToggle={onToggle}
        onClear={() => onClear(personalId ?? "")}
        onOpen={setEditing}
      />

      {household ? (
        <ListSection
          title={`Household · ${household.name}`}
          items={householdItems}
          onAddName={(name) => addTo(household.id, { name, quantity: "", category: "" })}
          onToggle={onToggle}
          onClear={() => onClear(household.id)}
          onOpen={setEditing}
        />
      ) : null}

      <ItemSheet
        open={editing !== null}
        onClose={() => setEditing(null)}
        mode="edit"
        item={editing}
        onSubmit={saveEdit}
        onDelete={removeEditing}
        canMove={household !== null}
        moveTargetLabel={editing && editing.listId === household?.id ? "Move to Personal" : "Move to Household"}
        onMove={editing ? () => onMove(editing.id, editing.listId === household?.id ? (personalId ?? "") : (household?.id ?? "")) : undefined}
      />
    </main>
  );
}

function ListSection({
  title, items, onAddName, onToggle, onClear, onOpen,
}: {
  title: string;
  items: DisplayItem[];
  onAddName: (name: string) => Promise<void> | void;
  onToggle: (id: string, checked: boolean) => Promise<void> | void;
  onClear: () => Promise<void> | void;
  onOpen: (item: DisplayItem) => void;
}) {
  const [newName, setNewName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { groups, checked } = groupItems(items);

  function addInline(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setNewName("");
    inputRef.current?.focus();
    void onAddName(name);
  }

  return (
    <section className="mb-6">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{title}</h2>

      <form onSubmit={addInline} className="mb-3 flex gap-2">
        <Input ref={inputRef} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Add item…" aria-label={`Add item to ${title}`} />
        <button type="submit" aria-label="Add" className="shrink-0 rounded-md bg-brand px-4 text-lg font-light text-[#08130b]">+</button>
      </form>

      {groups.length === 0 && checked.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">Nothing here yet.</p>
      ) : null}

      {groups.map((group) => (
        <div key={group.category} className="mb-3">
          <h3 className="mb-1 text-[11px] uppercase tracking-wide text-muted">{CATEGORY_LABEL[group.category]}</h3>
          <ul className="divide-y divide-border/50">
            {group.items.map((item) => (
              <li key={item.id} className="flex items-center gap-3 py-2.5">
                <Checkbox checked={item.checked} onChange={() => void onToggle(item.id, !item.checked)} label={`Check ${item.name}`} />
                <button type="button" onClick={() => onOpen(item)} className="flex flex-1 justify-between text-left text-sm">
                  <span>{item.name}</span>
                  {item.quantity ? <span className="text-muted">{item.quantity}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {checked.length > 0 ? (
        <div className="mb-2">
          <h3 className="mb-1 text-[11px] uppercase tracking-wide text-muted">Checked</h3>
          <ul className="divide-y divide-border/50">
            {checked.map((item) => (
              <li key={item.id} className="flex items-center gap-3 py-2.5">
                <Checkbox checked={item.checked} onChange={() => void onToggle(item.id, !item.checked)} label={`Uncheck ${item.name}`} />
                <button type="button" onClick={() => onOpen(item)} className="flex flex-1 justify-between text-left text-sm text-muted line-through">
                  <span>{item.name}</span>
                  {item.quantity ? <span>{item.quantity}</span> : null}
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-3">
            <Button variant="ghost" onClick={() => void onClear()}>Clear checked</Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
```

> `clearCheckedLocal` and `moveLocalItem` are added in Task 9; `PendingInviteBanner` in Task 12. This task's typecheck will fail until those land — that is expected; Task 9 and Task 12 close it. Sequence the commit AFTER Task 9 if executing strictly green per step (or land Tasks 8-9-12 together). See Step 8.

- [ ] **Step 7: Run the pure tests**

Run: `pnpm test tests/offline/lists.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit (after Task 9 + Task 12 land, for a green typecheck)**

Because `ListView` references `clearCheckedLocal(listId)`, `moveLocalItem`, and `PendingInviteBanner` (Tasks 9 + 12), do the ListView commit together with Task 9, and add `PendingInviteBanner` as a no-op stub now if you want this task to typecheck independently:

```tsx
// app/(app)/list/PendingInviteBanner.tsx  (temporary stub — replaced in Task 12)
"use client";
export function PendingInviteBanner(_props: { online: boolean }) { return null; }
```

```bash
pnpm typecheck   # green with the stub + Task 9 changes
git add lib/offline/items.ts lib/offline/lists.ts tests/offline/lists.test.ts app/(app)/list/ListView.tsx app/(app)/list/PendingInviteBanner.tsx
git commit -m "feat(6c): two-section ListView with per-list add/clear; displayItems carries listId"
```

---

## Task 9: `clearCheckedLocal` list-scoped + `moveLocalItem`

**Files:**
- Modify: `lib/offline/items.ts`

**Interfaces:**
- Consumes: existing local-write helpers in `items.ts`.
- Produces: `clearCheckedLocal(db, key, listId)` (now scoped to one list); `moveLocalItem(db, key, id, targetListId)`.

- [ ] **Step 1: Scope `clearCheckedLocal` to a single list**

Replace `clearCheckedLocal` in `lib/offline/items.ts` (it must clear only the checked items of the given list, so each section's "Clear checked" affects only that section):

```ts
export async function clearCheckedLocal(db: ListDb, key: CryptoKey, listId: string): Promise<void> {
  const rows = (await db.items.toArray()).filter((r) => r.deletedAt === null && r.listId === listId);
  for (const row of rows) {
    try {
      const content = await decryptContent(key, row.iv, row.cipher);
      if (content.checked) await deleteLocalItem(db, key, row.id);
    } catch {
      await db.items.delete(row.id);
    }
  }
}
```

- [ ] **Step 2: Add `moveLocalItem`**

Append to `lib/offline/items.ts`. Re-targeting is a content-preserving write that changes `listId` and bumps `editedAt`/`dirty` so it syncs as an LWW edit:

```ts
export async function moveLocalItem(db: ListDb, key: CryptoKey, id: string, targetListId: string): Promise<void> {
  const row = await db.items.get(id);
  if (!row) return;
  const content = await decryptContent(key, row.iv, row.cipher);
  await writeContent(
    db,
    key,
    { id: row.id, listId: targetListId, serverKnown: row.serverKnown, updatedAt: row.updatedAt },
    content,
    row.deletedAt,
  );
}
```

> `writeContent` already sets `editedAt = now()` and `dirty = 1`; passing the new `listId` in `base` re-targets the row. On sync, the server upserts the same `id` with the new `list_id` (RLS allows it because the user is a member of both lists), so the item appears in the destination list.

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS together with Task 8's `ListView`.

- [ ] **Step 4: Confirm pure offline suite green + commit (paired with Task 8)**

Run: `pnpm test tests/offline/`
Expected: PASS. Commit alongside Task 8 (Step 8) so the tree stays green, or:

```bash
git add lib/offline/items.ts
git commit -m "feat(6c): list-scoped clearChecked + moveLocalItem (re-target list)"
```

---

## Task 10: ItemSheet — add-mode target toggle + edit-mode move control

**Files:**
- Modify: `app/(app)/list/ItemSheet.tsx`

**Interfaces:**
- Consumes: `Segmented` (`components/ui/Segmented.tsx`), `DisplayItem`.
- Produces: `ItemSheet` accepts `item?: DisplayItem | null`, optional `canMove`, `moveTargetLabel`, `onMove`, and (add-mode) `target`/`onTarget` props. (ListView in Task 8 already passes the edit-mode move props; the add-mode toggle is used when the ＋-chooser opens the sheet in add mode — wired here.)

- [ ] **Step 1: Add the move control (edit) and target toggle (add)**

Update `app/(app)/list/ItemSheet.tsx`. Change the `item` type to `DisplayItem`, add the new optional props, and render: in edit mode a "Move" ghost button when `canMove`; in add mode a `[Personal | Household]` `Segmented` when `target`/`onTarget` are provided.

```tsx
"use client";

import { useState } from "react";
import type { Category } from "@/lib/shopping/types";
import { CATEGORIES, CATEGORY_LABEL } from "@/lib/shopping/types";
import type { DisplayItem } from "@/lib/offline/lists";
import { Sheet } from "@/components/ui/Sheet";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";

export type ItemDraft = { name: string; quantity: string; category: Category | "" };
export type AddTarget = "personal" | "household";

export function ItemSheet({
  open, onClose, mode, item, onSubmit, onDelete,
  canMove, moveTargetLabel, onMove,
  target, onTarget, householdAvailable,
}: {
  open: boolean;
  onClose: () => void;
  mode: "add" | "edit";
  item?: DisplayItem | null;
  onSubmit: (draft: ItemDraft) => Promise<void>;
  onDelete?: () => Promise<void>;
  canMove?: boolean;
  moveTargetLabel?: string;
  onMove?: () => Promise<void> | void;
  target?: AddTarget;
  onTarget?: (t: AddTarget) => void;
  householdAvailable?: boolean;
}) {
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState("");
  const [category, setCategory] = useState<Category | "">("");
  const [pending, setPending] = useState(false);

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
        {mode === "add" && householdAvailable && target && onTarget ? (
          <Field label="List">
            <Segmented
              value={target}
              onChange={onTarget}
              options={[{ value: "personal", label: "Personal" }, { value: "household", label: "Household" }]}
            />
          </Field>
        ) : null}
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
        {mode === "edit" && canMove && onMove ? (
          <Button variant="ghost" onClick={async () => { setPending(true); try { await onMove(); onClose(); } finally { setPending(false); } }}>
            {moveTargetLabel ?? "Move"}
          </Button>
        ) : null}
        {mode === "edit" && onDelete ? (
          <Button variant="danger" onClick={async () => { setPending(true); try { await onDelete(); onClose(); } finally { setPending(false); } }}>
            Delete item
          </Button>
        ) : null}
      </div>
    </Sheet>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS (ListView already passes `canMove`/`moveTargetLabel`/`onMove`).

- [ ] **Step 3: Commit**

```bash
git add app/(app)/list/ItemSheet.tsx
git commit -m "feat(6c): ItemSheet add-target toggle + move-between-lists control"
```

---

## Task 11: Household DAL + Server Actions

**Files:**
- Create: `lib/dal/household.ts`
- Create: `app/(app)/account/household-actions.ts`

**Interfaces:**
- Consumes: `createClient` (`lib/supabase/server`), `requireStepUp`/`verifySession` (`lib/dal/session`), validation schemas (Task 1), RPCs (Task 3).
- Produces:
  - DAL: `getMyHousehold()`, `getMembers(householdId)`, `getPendingInvites()`, `createHousehold(name)`, `inviteToHousehold(email)`, `respondToInvite(inviteId, accept)`, `leaveHousehold()`.
  - Actions (`ActionResult = { ok: true } | { error: string }`): `createHouseholdAction`, `inviteAction`, `respondInviteAction`, `leaveHouseholdAction`, `getPendingInvitesAction`. Tasks 12 + 13 consume the actions.

- [ ] **Step 1: Implement the DAL**

```ts
// lib/dal/household.ts
import "server-only";
import { verifySession } from "@/lib/dal/session";
import { createClient } from "@/lib/supabase/server";

export type Household = { id: string; name: string };
export type Member = { userId: string; displayName: string | null };
export type PendingInvite = { id: string; householdName: string };

async function authed() {
  const session = await verifySession();
  if (!session) throw new Error("Unauthenticated");
  return { session, supabase: await createClient() };
}

/** The caller's household (RLS returns only their own), or null. */
export async function getMyHousehold(): Promise<Household | null> {
  const { supabase } = await authed();
  const { data, error } = await supabase.from("households").select("id, name").maybeSingle();
  if (error) throw new Error(`getMyHousehold failed: ${error.message}`);
  return data ? { id: data.id, name: data.name } : null;
}

/** Member roster of the caller's household (RLS scopes to the same household). */
export async function getMembers(householdId: string): Promise<Member[]> {
  const { supabase } = await authed();
  const { data, error } = await supabase
    .from("household_members")
    .select("user_id, profiles(display_name)")
    .eq("household_id", householdId);
  if (error) throw new Error(`getMembers failed: ${error.message}`);
  return (data ?? []).map((r: { user_id: string; profiles: { display_name: string | null } | null }) => ({
    userId: r.user_id, displayName: r.profiles?.display_name ?? null,
  }));
}

/** Pending invites addressed to the caller, with the inviting household's name. */
export async function getPendingInvites(): Promise<PendingInvite[]> {
  const { session, supabase } = await authed();
  const { data, error } = await supabase
    .from("household_invites")
    .select("id, households(name)")
    .eq("invitee_user_id", session.userId)
    .eq("status", "pending");
  if (error) throw new Error(`getPendingInvites failed: ${error.message}`);
  return (data ?? []).map((r: { id: string; households: { name: string } | null }) => ({
    id: r.id, householdName: r.households?.name ?? "a household",
  }));
}

export async function createHousehold(name: string): Promise<void> {
  const { supabase } = await authed();
  const { error } = await supabase.rpc("create_household", { p_name: name });
  if (error) throw new Error("could not create household");
}
export async function inviteToHousehold(email: string): Promise<void> {
  const { supabase } = await authed();
  const { error } = await supabase.rpc("invite_to_household", { p_email: email });
  if (error) throw new Error("could not send invite");
}
export async function respondToInvite(inviteId: string, accept: boolean): Promise<void> {
  const { supabase } = await authed();
  const { error } = await supabase.rpc("respond_to_invite", { p_invite_id: inviteId, p_accept: accept });
  if (error) throw new Error("could not respond to invite");
}
export async function leaveHousehold(): Promise<void> {
  const { supabase } = await authed();
  const { error } = await supabase.rpc("leave_household");
  if (error) throw new Error("could not leave household");
}
```

> The `profiles(display_name)` and `households(name)` embedded selects rely on the FK relationships Postgres exposes to PostgREST. `household_members.user_id → auth.users` and `profiles.id = auth.users.id`; if the embed on `profiles` does not resolve (no direct FK from `household_members` to `profiles`), fall back to a second query: select `user_id`s, then `profiles` where `id in (...)`. The implementation step verifies which works against the live stack; prefer the single embedded query if it resolves.

- [ ] **Step 2: Implement the Server Actions**

```ts
// app/(app)/account/household-actions.ts
"use server";

import { requireStepUp } from "@/lib/dal/session";
import {
  createHousehold, inviteToHousehold, respondToInvite, leaveHousehold, getPendingInvites,
  type PendingInvite,
} from "@/lib/dal/household";
import { householdNameSchema, inviteEmailSchema, respondInviteSchema } from "@/lib/validation/household";

export type ActionResult = { ok: true } | { error: string };

export async function createHouseholdAction(name: string): Promise<ActionResult> {
  await requireStepUp();
  const parsed = householdNameSchema.safeParse(name);
  if (!parsed.success) return { error: "Enter a household name (1–100 characters)." };
  try { await createHousehold(parsed.data); return { ok: true }; }
  catch { return { error: "Could not create the household. Are you already in one?" }; }
}

export async function inviteAction(email: string): Promise<ActionResult> {
  await requireStepUp();
  const parsed = inviteEmailSchema.safeParse(email);
  if (!parsed.success) return { error: "Enter a valid email address." };
  // Always returns ok on a valid email — the RPC is a silent no-op for ineligible
  // targets, so the UI must not reveal whether the address exists.
  try { await inviteToHousehold(parsed.data); return { ok: true }; }
  catch { return { error: "Could not send the invite." }; }
}

export async function respondInviteAction(inviteId: string, accept: boolean): Promise<ActionResult> {
  await requireStepUp();
  const parsed = respondInviteSchema.safeParse({ inviteId, accept });
  if (!parsed.success) return { error: "Invalid invite." };
  try { await respondToInvite(parsed.data.inviteId, parsed.data.accept); return { ok: true }; }
  catch { return { error: "Could not respond to the invite." }; }
}

export async function leaveHouseholdAction(): Promise<ActionResult> {
  await requireStepUp();
  try { await leaveHousehold(); return { ok: true }; }
  catch { return { error: "Could not leave the household." }; }
}

/** Read-only fetch for the /list client banner (Task 12). */
export async function getPendingInvitesAction(): Promise<PendingInvite[]> {
  await requireStepUp();
  return getPendingInvites();
}
```

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/dal/household.ts app/(app)/account/household-actions.ts
git commit -m "feat(6c): household DAL + server actions"
```

---

## Task 12: HouseholdSection UI + account page wiring + PendingInviteBanner

**Files:**
- Create: `app/(app)/account/HouseholdSection.tsx`
- Replace stub: `app/(app)/list/PendingInviteBanner.tsx`
- Modify: `app/(app)/account/page.tsx`

**Interfaces:**
- Consumes: actions (Task 11), `getMyHousehold`/`getMembers`/`getPendingInvites` (Task 11 DAL), `Card`/`Button`/`Input`/`Segmented` primitives.
- Produces: a `HouseholdSection` rendered on `/account`; a working `PendingInviteBanner` on `/list`.

- [ ] **Step 1: Build `HouseholdSection` (client)**

```tsx
// app/(app)/account/HouseholdSection.tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import type { Household, Member, PendingInvite } from "@/lib/dal/household";
import {
  createHouseholdAction, inviteAction, respondInviteAction, leaveHouseholdAction,
} from "./household-actions";

export function HouseholdSection({
  household, members, invites, memberCount,
}: {
  household: Household | null;
  members: Member[];
  invites: PendingInvite[];
  memberCount: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  const run = (fn: () => Promise<{ ok: true } | { error: string }>, after?: () => void) =>
    startTransition(async () => {
      setError(null); setNote(null);
      const res = await fn();
      if ("error" in res) { setError(res.error); return; }
      after?.();
      router.refresh();
    });

  return (
    <Card className="mt-4 p-4 text-sm">
      <p className="mb-2 font-medium">Household</p>

      {invites.length > 0 && (
        <div className="mb-3 space-y-2">
          {invites.map((inv) => (
            <div key={inv.id} className="rounded-md border border-border/60 bg-surface p-3">
              <p className="mb-2">You've been invited to <span className="font-medium">{inv.householdName}</span>.</p>
              <div className="flex gap-2">
                <Button type="button" disabled={pending} onClick={() => run(() => respondInviteAction(inv.id, true))}>Accept</Button>
                <Button type="button" variant="ghost" disabled={pending} onClick={() => run(() => respondInviteAction(inv.id, false))}>Decline</Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {!household ? (
        <div className="space-y-3">
          <p className="text-muted">Create a household to share one shopping list with someone you invite.</p>
          <div className="flex gap-2">
            <div className="min-w-0 flex-1">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Household name" aria-label="Household name" />
            </div>
            <div className="shrink-0">
              <Button type="button" disabled={pending} onClick={() => run(() => createHouseholdAction(name), () => setName(""))}>Create</Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <p className="text-muted">Name</p>
            <p>{household.name}</p>
          </div>
          <div>
            <p className="mb-1 text-muted">Members</p>
            <ul className="space-y-1">
              {members.map((m) => <li key={m.userId} className="break-all">{m.displayName ?? m.userId}</li>)}
            </ul>
          </div>
          <div>
            <p className="mb-1 text-muted">Invite by email</p>
            <div className="flex gap-2">
              <div className="min-w-0 flex-1">
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="member@example.com" aria-label="Invite email" />
              </div>
              <div className="shrink-0">
                <Button
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => inviteAction(email), () => { setEmail(""); setNote("If that address belongs to a member, they'll see an invite."); })}
                >
                  Invite
                </Button>
              </div>
            </div>
          </div>
          <Button
            type="button"
            variant="danger"
            disabled={pending}
            onClick={() => {
              const msg = memberCount <= 1
                ? "You're the last member — leaving deletes this household and its shared list. Continue?"
                : "Leave this household? You'll lose access to the shared list.";
              if (window.confirm(msg)) run(() => leaveHouseholdAction());
            }}
          >
            Leave household
          </Button>
        </div>
      )}

      {note && <p className="mt-2 text-xs text-muted">{note}</p>}
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </Card>
  );
}
```

- [ ] **Step 2: Replace the `PendingInviteBanner` stub with a client-fetched banner**

The `/list` shell stays data-free: the banner is a client component that fetches **after mount**, only when online. The cached HTML contains an empty banner.

```tsx
// app/(app)/list/PendingInviteBanner.tsx
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getPendingInvitesAction } from "@/app/(app)/account/household-actions";

export function PendingInviteBanner({ online }: { online: boolean }) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!online) return;
    let cancelled = false;
    getPendingInvitesAction()
      .then((invites) => { if (!cancelled) setCount(invites.length); })
      .catch(() => { /* offline / auth — silently show nothing */ });
    return () => { cancelled = true; };
  }, [online]);

  if (count === 0) return null;
  return (
    <Link href="/account" className="mb-3 block rounded-md border border-brand/40 bg-[#16341f] px-3 py-2 text-xs text-protein">
      You have {count} pending household invite{count > 1 ? "s" : ""} — review on Account.
    </Link>
  );
}
```

- [ ] **Step 3: Wire `HouseholdSection` into the account page**

Update `app/(app)/account/page.tsx` to load household data and render the section. Add after the existing imports + data loads:

```tsx
import { getMyHousehold, getMembers, getPendingInvites } from "@/lib/dal/household";
import { HouseholdSection } from "./HouseholdSection";
```

Inside `AccountPage`, after the `profile` query:

```tsx
  const household = await getMyHousehold();
  const members = household ? await getMembers(household.id) : [];
  const invites = await getPendingInvites();
```

And render it after `<MfaSection .../>`:

```tsx
      <HouseholdSection household={household} members={members} invites={invites} memberCount={members.length} />
```

- [ ] **Step 4: Typecheck, lint, build**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: PASS. The build confirms `/list` still prerenders as a static/data-free shell (no server data fetch in `page.tsx`).

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/account/HouseholdSection.tsx" "app/(app)/list/PendingInviteBanner.tsx" "app/(app)/account/page.tsx"
git commit -m "feat(6c): household management UI + client-fetched /list invite banner"
```

---

## Task 13: Data-free shell guard, README, full-suite green

**Files:**
- Modify: `tests/pwa/sw-routes.test.ts` (assert the `/list` shell guard still holds — only if the file already encodes the data-free assertion; otherwise skip)
- Modify: `README.md`

**Interfaces:**
- Consumes: everything prior.
- Produces: passing full suite + documented behavior.

- [ ] **Step 1: Confirm the `/list` shell is still data-free**

`app/(app)/list/page.tsx` is unchanged (still renders `<ListView />` with no fetch); the invite banner is client-fetched. Confirm the existing PWA invariant test still passes:

Run: `pnpm test tests/pwa/sw-routes.test.ts`
Expected: PASS (no item/PII markers in the cached `/list` shell).

- [ ] **Step 2: Update the README**

Add a "Household sharing (Phase 6C)" subsection under the shopping-list docs describing: self-service households (create/invite/accept/leave), in-app invites (no email), one shared list per household alongside each member's personal list, equal read+write for members, last-edit-wins conflict resolution with a quiet "updated from your household" notice, and prune-on-revocation when a member leaves. Keep it factual; no attribution.

- [ ] **Step 3: Run the entire suite**

Run:
```bash
pnpm lint && pnpm typecheck && pnpm build
pnpm test
supabase db reset && REQUIRE_SUPABASE_TESTS=1 pnpm test tests/rls
```
Expected: lint/typecheck/build PASS; the full unit suite PASS; all RLS suites (household + shopping-list + admin + mfa + logged-foods + food-cache) PASS.

- [ ] **Step 4: Manual E2E (two real accounts on the deployed/preview build)**

Walk the spec §10 manual checklist and confirm each:
- [ ] A creates a household on `/account`; invites B by email; B sees the pending banner on `/list` and `/account`; B accepts → both see an empty **Household** section on `/list`.
- [ ] Both add/check/edit items in the Household section; one device offline → on reconnect they converge; a superseded edit shows the quiet "updated from your household" notice; nothing silently lost.
- [ ] Add-target toggle routes a new item to Personal vs Household; "Move to Household/Personal" re-targets an item and it relocates after sync.
- [ ] B leaves (or A as last member) → the Household section disappears on the other device on next sync; a dirty unsynced shared edit on the leaving device surfaces nothing stuck (dropped on prune).
- [ ] DevTools: shared item content is ciphertext at rest; Cache Storage holds only static assets, `/~offline`, and the data-free `/list` shell; sign-out wipes the `ns-list-<userId>` DB.

- [ ] **Step 5: Final commit**

```bash
git add README.md tests/pwa/sw-routes.test.ts
git commit -m "docs(6c): document household sharing; finalize Phase 6C"
```

---

## Self-Review

**1. Spec coverage** (each spec section → task):
- §3 tables/column/indexes/grants → Task 2.
- §4 `can_access_list` + broadened item/list RLS + household RLS → Task 2 (`is_household_member` baked in as the recursion-safe primary, per the spec §4/§13 contingency).
- §5 lifecycle RPCs → Task 3.
- §6.1 `getMyLists` + sync returns lists → Task 4; §6.2 Dexie `lists` store → Task 6; §6.3 reconcile/prune/push-filter → Tasks 5 (pure) + 7 (wiring); §6.4 add-target/move → Tasks 8–10.
- §7.1 merged two-section `/list` → Task 8; §7.2 HouseholdSection → Task 12; §7.3 `/list` banner (client-fetched) → Task 12; §7.4 conflict notice text → covered by the existing SyncStatus + Manual E2E (LWW unchanged; the "household" wording is surfaced in the Manual E2E check — no code change needed beyond the existing pending/synced status).
- §8 security invariants → enforced across Tasks 2/3 (RLS, RPC gating, enumeration no-op) + Task 13 (data-free shell guard).
- §10 tests → Tasks 1, 2, 3, 4, 5, 8 (pure/RLS) + Task 13 (Manual E2E).
- §11 error handling → ActionResult + boundary safeParse in Tasks 4/11; RLS `42501` surfaced unchanged.
- §12 deploy → migration auto-applies (no task action beyond merge); confirmed in Task 13 full-suite + `db reset`.
- §13 risks → recursion (helper baked in, Task 2), enumeration (Task 3 test), prune (Task 5 test + Task 7), last-member leave (Task 3 test).

Gap check — **§7.4 "Updated from your household" toast**: the LWW mechanism is unchanged and the repo's `SyncStatus` shows pending/synced, not a per-conflict toast (Phase 5 likewise specced the toast as optional/quiet). No code task adds a new toast component; this is intentionally folded into the Manual E2E verification rather than over-built. If a literal toast is required, it is a small follow-up — flagged here, not silently dropped.

**2. Placeholder scan:** No "TBD/TODO/handle appropriately". Every code step shows full code. The two documented runtime decisions — the `profiles` embed fallback (Task 11 Step 1) and the `PendingInviteBanner` stub→real sequencing (Task 8 ↔ Task 12) — are explicit instructions with the exact fallback code, not gaps.

**3. Type consistency:** `ListMeta` (DAL) → `toLocalListMeta` → `LocalListMeta`/`ListRow` (kind added) is consistent across Tasks 4/5/6. `DisplayItem = ShoppingListItem & { listId }` defined in Task 8 (`lib/offline/lists.ts`), consumed by `displayItems`, `ListView`, `ItemSheet` — all import from `@/lib/offline/lists`. `syncShoppingList` return `{ items, cursor, lists }` (Task 4) matches `runSync`'s `result.lists`/`result.items`/`result.cursor` (Task 7). `clearCheckedLocal(db, key, listId)` (Task 9) matches ListView's `onClear` call (Task 8). `ActionResult` shape identical across Task 11 actions and Task 12 `run()`.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-29-nutri-shop-shared-list.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration. Note Tasks 8/9/12 are intentionally coupled (ListView ↔ items helpers ↔ banner); land them as a green group.

**2. Inline Execution** — execute tasks in this session via executing-plans, batch execution with checkpoints.

**Which approach?**
