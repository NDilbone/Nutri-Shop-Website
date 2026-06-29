# Nutri-Shop — Phase 6C: shared household list (design)

**Date:** 2026-06-28
**Author:** NDilbone
**Status:** Approved design, pending implementation plan
**Predecessor:** [`2026-06-26-nutri-shop-mfa-design.md`](./2026-06-26-nutri-shop-mfa-design.md) (Phase 6B) · [`2026-06-26-nutri-shop-invite-admin-design.md`](./2026-06-26-nutri-shop-invite-admin-design.md) (Phase 6A) · [`2026-06-25-nutri-shop-offline-sync-design.md`](./2026-06-25-nutri-shop-offline-sync-design.md) (Phase 5) · [`2026-06-24-nutri-shop-shopping-list-design.md`](./2026-06-24-nutri-shop-shopping-list-design.md) (Phase 3) · foundation [`2026-06-23-nutri-shop-foundation-design.md`](./2026-06-23-nutri-shop-foundation-design.md)

## Roadmap context — the last of Phase 6's three sub-projects

Phase 6 ("hardening") was always three independent subsystems: **6A invite-admin** (shipped), **6B MFA** (shipped), and **6C shared/household list** — named from the start as the largest and riskiest, deserving its own brainstorm → spec → plan → build → PR cycle. This spec is 6C.

**Scope of this spec:** let two (or a few) invited users share **one** shopping list — "you + your fiancé see one list" — while each keeps a private personal list. A user self-serves a **household**: creates it, invites another existing user **in-app**, who accepts. The household has exactly **one** shared list; a user belongs to **at most one** household. The `/list` screen shows the personal list and the household list together as two labelled sections. Sharing is delivered as a **server-side RLS broaden** (Phase 3 §6 predicted this) plus client multi-list handling — **not** a sync-engine rewrite and **not** a cryptography change.

### The two things that look hard but aren't, and the one that is

- **Not a crypto problem.** Phase 5 encryption is *local-at-rest only*: each device encrypts list content under its own non-extractable key; the **server stores plaintext** (`sync_shopping_items` and `getChangesSince` operate on plaintext columns). A shared list is therefore just rows two people are both allowed to read/write — each member's device pulls them and encrypts locally under its own key. The "collides with the per-user AES key" warning carried in the 6A/6B specs is overstated; there is no shared-key or key-exchange problem.
- **Not a sync rewrite.** `getChangesSince` has **no `list_id` filter** — it selects every `shopping_list_items` row with `updated_at > cursor`, RLS-scoped. Broaden RLS and the pull returns the shared list's items automatically. `sync_shopping_items` is **`SECURITY INVOKER`**, so once item policies admit members, members can push to the shared list. Both ship unchanged.
- **The real risk: multi-writer conflict + access revocation.** Phase 5's last-edit-wins was justified *because* a list had a single writer on a few devices. 6C exposes the same rows to **two different people** with independently-skewed clocks, and adds a new lifecycle event Phase 5 never had — **losing access** (leave / be removed) while local data and unsynced edits still sit in Dexie. The design centers on these two.

---

## 1. Goal & non-goals

### Goal
A logged-in user can create a household, invite another existing user by email from inside the app, and — once accepted — both members see and edit **one shared shopping list** alongside their own private lists. Shared items add/check/edit/delete/clear with the same instant, offline-capable, foreground-synced behavior Phase 5 gave the personal list. Concurrent edits resolve deterministically (newer real-world edit wins) with a quiet "updated from your household" notice and no silent loss in the common case. Leaving or being removed from a household cleanly removes the shared list from that user's device.

### Non-goals (6C — deferred or out)
- **More than one household per user, or more than one shared list per household.** A user is in ≤1 household; a household has exactly 1 shared list. No household/list switcher. (Multiple named lists remain a Phase 3 non-goal that carries forward.)
- **Intra-household roles / permissions.** Every member has equal read+write on the shared list's *items*. Only the **creator** can rename or delete the shared-list row (members never need to). No member-of-members, no per-item permissions.
- **Email-delivered invites.** Invites are in-app pending rows the invitee accepts; no email template and no sending path is built (consistent with 6A's no-email-infra stance).
- **Real-time / push collaboration.** Sync stays **foreground-only** (Phase 5 triggers). Two members see each other's changes on the next sync trigger, not live.
- **Offline household management.** Create / invite / accept / leave are online-only Server Actions. Only *list data* is offline. (You cannot form or change a household with no signal.)
- **Household-admin transfer / disband UI beyond "leave".** Leaving as the last member removes the household; there is no ownership-handoff flow.
- **Edit attribution by name.** The conflict notice is generic ("Updated from your household"); no `edited_by` column, no per-row "edited by X". (Mirrors Phase 5's "from your other device" toast.)
- **Hard delete.** Items remain soft-deleted (`deleted_at`), unchanged from Phase 3/5.
- **Macro logging sharing.** `logged_foods` stays online-only and per-user (untouched).

---

## 2. Decisions locked

| # | Decision | Rationale |
|---|----------|-----------|
| Sharing shape | **Personal list + one shared household list.** Each member keeps their Phase-3 personal default list; the household adds a second, shared list. | Owner's pick. Keeps private lists private and shared groceries shared; the client tracks at most two lists. |
| Household model | **Self-service:** a user creates a household, invites another **in-app**, who accepts/declines; a member can leave. | Owner's pick over admin-managed. Autonomy for a family; the flows are small because there is no email infra. |
| Cardinality | **≤1 household per user; exactly 1 shared list per household.** Enforced by `unique(user_id)` on `household_members` and a partial unique index on `shopping_lists(household_id)`. | Matches reality; removes any need for a switcher and bounds sync/UI to two lists. |
| Invite delivery | **In-app pending invite** keyed to the invitee's existing user id; surfaced as an Accept/Decline banner. No email, no token link. | Everyone is already an invite-only user with an account; mirrors 6A's no-send stance; no token-security surface. |
| Access control | **One `SECURITY DEFINER public.can_access_list(list_id)` helper** = "owner **OR** a member of the list's household." Item policies and the list `SELECT` policy call it. | Single source of truth, indexable, unit-testable; bypasses policy recursion on the membership table; clones the existing `is_admin()` predicate pattern (6A). |
| Item writes | **Any household member** may select/insert/update/(soft)delete the shared list's **items**. | That is the feature — a shared list both people edit. |
| List-row writes | **Owner-only** (`INSERT`/`UPDATE`/`DELETE` on `shopping_lists` unchanged). Members get `SELECT` via `can_access_list`. | Members edit items, not the list container; renaming/deleting the shared list stays with its creator. |
| Household writes | **Only via self-gating `SECURITY DEFINER` RPCs** (create/invite/respond/leave). Table-level writes denied to `authenticated`; `SELECT` allowed for your own household/members/pending invites. | The 6A "invites table written only through admin RPCs" pattern; keeps the trusted surface small and auditable. |
| Invite privacy | `invite_to_household` is a **silent no-op** on unknown email / target-already-in-a-household / existing pending. | No account-enumeration oracle; matches the careful-lookup posture of 6A's `auth.users` join. |
| Conflict resolution | **Unchanged Phase-5 last-edit-wins** (`edited_at`, client clock), now arbitrating across users; a quiet **"Updated from your household"** toast when one of your edits is superseded. | Owner's pick. Adds never conflict (UUIDs); check-off and clear converge; the only lossy case (two people retyping the same item in one sync window with skewed clocks) is rare for groceries. No schema change beyond sharing. |
| Access revocation | **Prune-on-revocation:** after a successful sync, drop any local list + items no longer in the caller's accessible set; a **pre-push filter** never sends dirty rows for an inaccessible list (so revocation can't abort the personal-list batch). | New lifecycle Phase 5 lacked; prevents stale shared data lingering on a device after leave/remove and prevents a poisoned push batch. |
| Encryption | **Unchanged.** Shared items are AES-GCM-encrypted at rest under each member's own non-extractable device key; the server stays plaintext; per-user Dexie DB + sign-out wipe unchanged. | Sharing is a server-side authorization broaden; the local-at-rest scheme is per-device and needs no change. |

---

## 3. Data model — migration `0007_household_sharing.sql`

The **first schema change since 6A's `0006`** (so `db-migrate.yml` and `rls.yml` run this phase). Additive: three new tables + one nullable column on `shopping_lists`. `shopping_lists.owner_id` **stays `NOT NULL`** — a shared list's `owner_id` is its creator, so no nullability migration.

```sql
-- ============ households ============
create table public.households (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 100),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id      uuid not null references auth.users(id)      on delete cascade,
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
-- at most one live invite per (household, invitee)
create unique index household_invites_one_pending
  on public.household_invites (household_id, invitee_user_id) where status = 'pending';

-- ============ shared list seam on the existing table ============
alter table public.shopping_lists
  add column household_id uuid references public.households(id) on delete cascade;

-- exactly one live shared list per household
create unique index shopping_lists_one_shared
  on public.shopping_lists (household_id)
  where household_id is not null and deleted_at is null;
```

- **Personal list:** `household_id IS NULL` — the Phase-3 lazy default list, untouched. Its `shopping_lists_one_default` partial unique index (`where is_default and deleted_at is null`) is independent of the new shared index.
- **Shared list:** `household_id` set, `is_default = false`, `owner_id =` creator. Created **eagerly** by `create_household` (not lazily), so a household always has exactly one shared list.
- `on delete cascade` from `households` → shared list → items: leaving as the last member (which deletes the household) tears down the shared list and its items in one step.

### Grants & triggers
Explicit grants (the `0001`/`0004` lesson — a fresh CI stack lacks Supabase's implicit privileges; RLS still gates rows):

```sql
grant all on public.households        to service_role;
grant all on public.household_members to service_role;
grant all on public.household_invites to service_role;
-- authenticated: SELECT only; all writes go through the RPCs in §5.
grant select on public.households        to authenticated;
grant select on public.household_members to authenticated;
grant select on public.household_invites to authenticated;
```

`shopping_lists` / `shopping_list_items` keep their existing grants and `set_updated_at` triggers; only their **policies** change (§4).

---

## 4. Access control — `can_access_list()` + broadened RLS

The load-bearing change. One helper centralizes the access rule; every consumer calls it.

```sql
create or replace function public.can_access_list(p_list_id uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.shopping_lists l
    where l.id = p_list_id and l.deleted_at is null and (
      l.owner_id = (select auth.uid())
      or exists (
        select 1 from public.household_members m
        where m.household_id = l.household_id
          and m.user_id = (select auth.uid())
      )
    )
  );
$$;
grant execute on function public.can_access_list(uuid) to authenticated;
```

`SECURITY DEFINER` + `search_path = ''` (the 6A `is_admin()` pattern) lets the predicate read `household_members` without forcing broad RLS on it or risking policy recursion. `stable` + the `(select auth.uid())` wrap keep it a per-query initplan.

### `shopping_list_items` — admit members (the only item-policy change)
All four policies replace the Phase-3 `EXISTS(select 1 from shopping_lists l where l.id = list_id and l.owner_id = (select auth.uid()) …)` with a single call:

```sql
-- drop + recreate each of the four policies with this predicate:
--   using / with check ( public.can_access_list(list_id) )
create policy "shopping_list_items_select_member" on public.shopping_list_items
  for select using ( public.can_access_list(list_id) );
create policy "shopping_list_items_insert_member" on public.shopping_list_items
  for insert with check ( public.can_access_list(list_id) );
create policy "shopping_list_items_update_member" on public.shopping_list_items
  for update using ( public.can_access_list(list_id) )
             with check ( public.can_access_list(list_id) );
create policy "shopping_list_items_delete_member" on public.shopping_list_items
  for delete using ( public.can_access_list(list_id) );
```

Because `can_access_list` covers both `owner_id = uid()` and household membership, **personal-list items behave exactly as before** (the owner branch) while shared-list items become reachable by members. The Phase-5 `sync_shopping_items` (SECURITY INVOKER) and `getChangesSince` need **no change** — they already run under these policies.

### `shopping_lists` — members may read the shared-list row
```sql
-- SELECT broadens; INSERT/UPDATE/DELETE stay owner-only (Phase 3, unchanged).
drop policy "shopping_lists_select_own" on public.shopping_lists;
create policy "shopping_lists_select_accessible" on public.shopping_lists
  for select using ( (select auth.uid()) = owner_id or public.can_access_list(id) );
```

### household tables — SELECT scoped, writes RPC-only
```sql
alter table public.households        enable row level security;
alter table public.household_members enable row level security;
alter table public.household_invites enable row level security;

-- See a household iff you are a member of it.
create policy "households_select_member" on public.households
  for select using ( exists (
    select 1 from public.household_members m
    where m.household_id = id and m.user_id = (select auth.uid()) ) );

-- See the member roster of your own household.
create policy "household_members_select_same" on public.household_members
  for select using ( exists (
    select 1 from public.household_members me
    where me.household_id = household_members.household_id
      and me.user_id = (select auth.uid()) ) );

-- See an invite iff it is addressed to you (pending banner) — or you sent it.
create policy "household_invites_select_mine" on public.household_invites
  for select using (
    invitee_user_id = (select auth.uid()) or invited_by = (select auth.uid()) );

-- No INSERT/UPDATE/DELETE policies for `authenticated` ⇒ all writes are RPC-only (§5).
```

> Note: `households_select_member` and `household_members_select_same` each reference `household_members`; because these are plain (non-recursive on themselves in a problematic way) `EXISTS` checks scoped by `auth.uid()`, they resolve without infinite recursion. The implementation plan verifies this against the live local stack (it is the kind of thing that bites only at runtime), and falls back to a `SECURITY DEFINER public.is_household_member(hid)` helper if Postgres flags recursion.

---

## 5. Household lifecycle RPCs — self-gating `SECURITY DEFINER`

Every function: `language plpgsql security definer set search_path = ''`, raises `forbidden` (`errcode = 'insufficient_privilege'`) on a violated precondition, and `grant execute … to authenticated`. Direct clones of 6A's `admin_*` shape.

- **`create_household(p_name text) returns uuid`** — caller must not already be in a household (`unique(user_id)` is the hard backstop; the RPC checks first for a clean error). Inserts the household (`created_by = auth.uid()`), the creator's membership, and the single shared list (`household_id`, `owner_id = auth.uid()`, `is_default = false`). Returns the household id.

- **`invite_to_household(p_email text) returns void`** — caller must be a member of a household. Resolve `lower(trim(p_email))` → `auth.users` (the 6A join). **Silent no-op** (return normally, insert nothing) when: no such user, the user is already in *any* household, or a pending invite already exists. Otherwise insert a `pending` invite (`invitee_user_id`, `invited_by = auth.uid()`). No value distinguishes the no-op cases — no enumeration oracle.

- **`respond_to_invite(p_invite_id uuid, p_accept boolean) returns void`** — caller must be the invite's `invitee_user_id` and the invite `pending`. Accept → caller must not already be in a household → insert membership, set invite `accepted`. Decline → set invite `declined`. (A `revoked` status exists for symmetry / future inviter-cancel; not surfaced in 6C UI.)

- **`leave_household() returns void`** — delete the caller's `household_members` row. If the caller was the **last** member, delete the household too (cascading the shared list + its items). A non-last leave just removes the caller (the shared list and remaining members are untouched; the caller's device prunes it on next sync, §6).

Email→user lookup reuses the existing `grant select on auth.users to postgres` from `0006` — **no new auth grant**. Each RPC is `grant execute … to authenticated`; the in-body precondition is the real gate.

---

## 6. Client — sync engine & Dexie go multi-list

Phase 5 tracked exactly one list (`meta.defaultListId`); the item row already carries `listId`, so the store is structurally multi-list-ready. The work is teaching the client which lists it can see, rendering them grouped, and pruning ones it loses.

### 6.1 Learning the accessible lists
`syncShoppingList` returns, in addition to push/pull, the caller's **accessible lists**:

- New DAL **`getMyLists(): Promise<ListMeta[]>`** (`lib/dal/shopping-list.ts`) — RLS-scoped `select id, household_id, name, is_default from shopping_lists where deleted_at is null`. RLS returns the personal list **and** (if a member) the shared list. `ListMeta = { id, householdId, name, isDefault }`; `kind` is derived (`householdId ? 'household' : 'personal'`).
- `getChangesSince(cursor)` SQL is **unchanged** (no `list_id` filter; RLS now widens its result to include shared items).

### 6.2 Dexie
Add a **`lists`** store (`lib/offline/db.ts`):
```ts
db.version(2).stores({
  items: "id, listId, dirty, updatedAt",   // unchanged
  lists: "id, kind",                        // NEW: { id, householdId, name, kind }
  meta:  "key",
  keyv:  "id",
});
```
List metadata is **not sensitive** (a list id + a household name the user chose) and is stored in clear, like the item sync-control fields. Only item *content* is encrypted (unchanged). A Dexie `version(2)` upgrade adds the `lists` store with no data migration (it backfills from the next sync's `getMyLists`).

### 6.3 Reconcile, prune, push-filter (`lib/offline/sync.ts` + `lib/offline/reconcile.ts`)
Each sync run, after push+pull:
1. **Upsert** the returned `ListMeta[]` into Dexie `lists`.
2. **Reconcile items** by last-edit-wins exactly as Phase 5 — the resolver is unchanged; it now simply sees rows from two `listId`s.
3. **Prune-on-revocation** (new, pure-testable): for every local `lists` row **not** in the returned accessible set, delete it and all its `items` from Dexie. If any pruned item was `dirty`, surface a quiet "Household list no longer available — N unsynced change(s) discarded." This is how leave/remove clears a device.
4. **Pre-push filter** (new): the dirty-row collector excludes rows whose `listId` is not in the *currently known accessible* set, so a just-revoked shared list can never put an RLS-failing row into the batch and abort the personal-list push. (Belt-and-suspenders with prune; ordering-safe if a revocation lands mid-run.)

Cursor handling, the in-flight guard, sign-out wipe, and the per-user DB name are **unchanged**.

### 6.4 Writes / add-target
The three Phase-5 add entry points still funnel through the local-write helper; the helper now takes a **target `listId`**:
- Add-to-list sheet shows a `[Mine | Household]` toggle (only when a household list exists); the choice sets `listId`.
- Each section's inline-add row writes to that section's list.
- A row action **"Move to Household" / "Move to Mine"** re-targets `listId` (a normal dirty edit; LWW-synced). Offline-capable — both list ids are cached from the last sync.

---

## 7. UI / UX

Phone-first inside the existing `app/(app)` shell; desktop uses the Phase-4 sidebar layout. Reuses dark-editorial tokens and primitives; no new visual identity.

### 7.1 `/list` — merged two-section view
`page.tsx` stays the **data-free shell** (no server fetch); `ListView` reads Dexie via `useLiveQuery` and renders:
```
 Shopping list                         [sync status]
 ── PERSONAL ──────────────────────────
 ┌─ Add item ──────────────┐ [＋]
 PRODUCE
   [ ] Bananas
 ── HOUSEHOLD · Smith family ───────────   (only if in a household)
 ┌─ Add item ──────────────┐ [＋]
 DAIRY
   [ ] Milk            1 gal
   ── checked ──
   [x] ~~Eggs~~        [ Clear checked ]
```
- Each section runs the existing `lib/shopping/group.ts` (aisle order + checked split) over its own list's items; sections render in fixed order **Personal, then Household**.
- The Household section appears only when a household list is present locally; with no household, `/list` is visually identical to Phase 5.
- Per-section inline-add + Clear-checked (each scoped to its list). The ＋-chooser "Add to list" sheet gains the `[Mine | Household]` target.

### 7.2 Household management — `/account`
A `HouseholdSection` on the existing `/account` screen (online-only; it lives behind the `(app)` MFA gate for free):
- **Not in a household:** a **Create household** form (name) + a **pending-invite banner** for each invite addressed to you (`<inviter household> invited you` → **Accept** / **Decline**).
- **In a household:** the household name, the **member roster**, an **Invite by email** field (→ `invite_to_household`; always shows a neutral "If <email> is a member, they'll see an invite" confirmation — no enumeration), and **Leave household** (confirm; warns if you are the last member that the shared list will be deleted).

### 7.3 Pending-invite banner on `/list`
When a pending invite exists, a slim banner also appears atop `/list` (Accept opens `/account`'s flow) so an invitee notices without hunting in settings.

### 7.4 Sync status
The Phase-5 status surface is unchanged; per-item "pending" dots now also appear on shared-list rows. The conflict notice text for a superseded shared edit is **"Updated from your household"** (vs Phase 5's "from your other device").

---

## 8. Security plumbing (load-bearing)

| Invariant | How 6C holds it |
|-----------|-----------------|
| **RLS remains the backstop.** | Item access flows through `can_access_list` in every policy; `sync_shopping_items` stays `SECURITY INVOKER` (members run as `authenticated`, RLS gates each row); no service-role in the list/sync path. |
| **Household writes are minimal & gated.** | Tables are SELECT-only to `authenticated`; create/invite/respond/leave are self-gating `SECURITY DEFINER` RPCs (6A pattern) — the trusted surface is four small functions. |
| **No account enumeration.** | `invite_to_household` is a silent no-op on unknown email / ineligible target; the UI confirmation is identical regardless; an invite carries no list data and a pending invite is readable only by its invitee (and sender). |
| **Encryption invariant intact.** | Shared items are AES-GCM-encrypted at rest under each member's own non-extractable device key; the server is plaintext as before; the per-user Dexie DB is still wiped on sign-out/user-switch. List metadata (id + chosen name) is non-sensitive and stored in clear, consistent with the existing clear sync-control fields. |
| **Cached `/list` shell stays data-free.** | The merged view still renders **no** server data (Dexie-sourced); the Phase-4/5 "no authed data in any cache; the `/list` shell is data-free" invariant is unchanged. The shell continues to render no PII (brand + nav only). |
| **MFA (6B) coverage.** | Household management and the list live under `app/(app)` → already behind the aal2 gate (mandatory for admins, opt-in for members). No new bypass. |
| **No stale shared data after access loss.** | Prune-on-revocation deletes the shared list + items from a device on the first sync after leave/remove; the pre-push filter stops a revoked list from poisoning the batch. |
| **Self-escalation closed.** | Membership is written only by the gated RPCs; there is no client-writable path to add yourself to a household or to another user's list (the 6A `revoke update on profiles` lesson, applied by giving the household tables no authenticated write policies at all). |

---

## 9. Components & files

**New**
- `supabase/migrations/0007_household_sharing.sql` — tables, `household_id` column, indexes, grants, `can_access_list`, broadened item/list policies, household RLS, the four lifecycle RPCs (§3–§5).
- `lib/dal/household.ts` (`server-only`) — thin wrappers over the RPCs (`createHousehold`, `inviteToHousehold`, `respondToInvite`, `leaveHousehold`) + reads (`getMyHousehold`, `getMembers`, `getPendingInvites`), each `verifySession`/`requireUser` first, RLS-scoped client. Mirrors `lib/dal/admin.ts`.
- `lib/validation/household.ts` (Zod 4) — boundary schemas (`name` 1..100, email, uuid, boolean).
- `app/(app)/account/HouseholdSection.tsx` (client) — create / invite / roster / pending-invite / leave UI.
- `app/(app)/account/household-actions.ts` (`"use server"`) — one thin action per RPC, `ActionResult` shape, `safeParse` at the boundary, `requireUser()`.
- `components/ui/Segmented.tsx` (or reuse) — the `[Mine | Household]` toggle, dark-token styled (one small primitive, reused by the add sheet).
- Pure helpers + tests: prune-on-revocation reconcile branch, pre-push accessible-filter, invite/accept/leave decision shapes.

**Modified**
- `lib/dal/shopping-list.ts` — add `getMyLists()`; `getChangesSince` and the mutation DAL unchanged.
- `app/(app)/list/actions.ts` — `syncShoppingList` also returns `getMyLists()`; payload/validation extended.
- `lib/offline/db.ts` — Dexie `version(2)` + `lists` store.
- `lib/offline/sync.ts` + `lib/offline/reconcile.ts` — upsert `lists`, prune-on-revocation, pre-push filter.
- `lib/offline/items.ts` — display read groups by list → aisle; local-write helper takes a target `listId`; "move to list" re-target.
- `app/(app)/list/ListView.tsx` + `ItemSheet.tsx` — two-section render; add-target toggle; pending-invite banner.
- `lib/validation/sync.ts` — accept rows for any accessible `listId` (validation stays structural; RLS is the authority).
- `README.md` — document households, the shared list, in-app invites, and the equal-write/last-edit-wins model.

No new environment variables, no new third-party services.

---

## 10. Testing strategy (TDD — each behavior fails first)

**RLS integration (`rls.yml`, live local Supabase, two users):**
- A member can `select`/`insert`/`update`/soft-`delete` the **shared** list's items; a non-member cannot (the `can_access_list` predicate).
- A non-member cannot `select` the shared `shopping_lists` row, the household, its members, or another user's invite.
- Drive `sync_shopping_items` **as a member** → shared rows upsert; **as a non-member** → RLS rejects; `getChangesSince` returns shared rows to members and never to non-members (incl. tombstones).
- After `leave_household`, the (ex-)member's `getChangesSince` no longer returns shared rows and writes are rejected.
- `invite_to_household` with an unknown email is a no-op (no invite row, no error); with a valid eligible email creates exactly one pending invite; a second call is idempotent (no duplicate, partial unique index).
- `create_household` twice for the same user fails closed (`unique(user_id)`); `respond_to_invite(accept)` for a user already in a household fails closed.

**Pure units (Vitest, `node`):**
- `can_access_list` truth table is also exercised via the RLS suite; the **prune-on-revocation** reconcile branch and the **pre-push accessible-filter** are pure functions tested directly (list present-vs-absent, dirty-vs-clean pruned rows, batch excludes inaccessible list).
- multi-list **display grouping** (Personal/Household × aisle; Household section omitted when no shared list); the **add-target** resolution; the invite/accept/leave decision shapes.
- existing Phase-5 resolver / cursor / sign-out tests stay green (unchanged behavior on the personal list).

**Component (`ListView`):** renders both sections; Household section hidden with no household; per-section Clear-checked visibility; add-target toggle present only with a household; pending-invite banner shows/clears.

**Manual e2e (two real accounts, deployed app):**
- Create household on A → invite B by email → B sees the banner → accept → both see an empty Household section.
- Both add/check/edit items on the shared list (one offline) → on reconnect they converge; superseded edit shows the quiet "Updated from your household" toast; nothing silently lost.
- B `leave_household` (or A removes the household by leaving last) → the shared list disappears from the other device on next sync; a dirty shared edit on a leaving device surfaces the "no longer available" notice.
- Privacy: DevTools shows shared item content as ciphertext at rest; Cache Storage holds only static assets + `/~offline` + the data-free `/list` shell; sign-out wipes the per-user DB.

---

## 11. Error handling

Consistent with the codebase; no speculative layers.
- **Boundary validation** in Server Actions (`safeParse` → `{ error }`); inputs past the boundary are trusted internally.
- **RPC preconditions** raise `insufficient_privilege` / clean errors; the DAL maps them to a toast (the 6A pattern). RLS denials surface as Postgres `42501`, never swallowed.
- **Sync** keeps the Phase-5 contract: a member's push that hits a just-revoked row is prevented by the pre-push filter, not left to abort the batch; auth-expiry leaves rows `dirty` and prompts re-login.
- No defensive `null`-checks past the validated boundary; no try/catch that only re-throws.

---

## 12. Deployment

- `0007_household_sharing.sql` auto-applies via `db-migrate.yml` on merge to `main` (the `SUPABASE_*` secrets exist since Phase 2). The RLS Integration Tests workflow spins up a fresh local stack and runs the new isolation + RPC tests against real Postgres before the feature is trusted.
- Additive migration (new tables, one nullable column, broadened policies); no destructive change, no backfill — existing personal lists keep working untouched.
- No new environment variables, no new third-party services, no CSP change (no new origins; IndexedDB/Web Crypto need none).

---

## 13. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Broadened RLS opens a cross-user path to another user's items. | All access flows through one audited `can_access_list`; an `rls.yml` test drives reads/writes/RPC as member **and** non-member and asserts rejection. Item policies have no path that ignores the helper. |
| Household RLS predicates referencing `household_members` recurse at runtime. | Predicates are `auth.uid()`-scoped `EXISTS` checks; the plan validates against the live local stack and falls back to a `SECURITY DEFINER is_household_member(hid)` helper if Postgres flags recursion. |
| Invite-by-email leaks which emails are registered. | `invite_to_household` is a uniform silent no-op across all ineligible cases; the UI confirmation is identical; pending invites are readable only by invitee/sender. |
| Multi-writer last-edit-wins silently drops an edit. | Adds never conflict (UUIDs); check/clear converge; only same-item text retypes in one sync window with skewed clocks can lose, rare for groceries; the superseded side gets a quiet toast (no silent *disappearance*, just an overwrite). Accepted by the owner. |
| A removed member keeps shared data / unsynced edits on-device. | Prune-on-revocation deletes the list + items on the next sync; a dirty pruned row raises a visible "no longer available — N discarded" notice; the pre-push filter stops a revoked list from aborting the batch. |
| Last member leaves and orphans the household/shared list. | `leave_household` deletes the household when the last member leaves; `on delete cascade` removes the shared list + items. |
| Concurrent `create_household` / double-accept races. | `unique(user_id)` on `household_members` is the hard backstop; RPCs check first for clean errors and fail closed on the index otherwise (the `shopping_lists_one_default` idempotency pattern). |
| Dexie `version(1)→(2)` upgrade on existing installs. | Additive store add, no data transform; the `lists` store backfills from the next `getMyLists`. Tested on an existing populated DB. |

---

## 14. Success criteria (Phase 6C is done when…)

1. A user can create a household, invite another existing user by email **in-app**, and that user can Accept/Decline a pending invite — no email is sent.
2. Accepted members both see a **Household** section on `/list` alongside their **Personal** section, and either can add/check/edit/delete/clear shared items.
3. Shared items work **offline** and **sync** on reconnect with the Phase-5 behavior; concurrent edits resolve by last-edit-wins with a quiet "Updated from your household" notice and no silent loss in the common case.
4. Leaving (or being removed when the last member triggers household deletion) **removes the shared list from that device** on the next sync, with any unsynced shared edits surfaced before they are discarded.
5. The `rls.yml` suite proves a non-member cannot read or write the shared list, its items, the household, or its invites — passing in CI against real Postgres; `invite_to_household` proven non-enumerating.
6. Encryption-at-rest, the data-free cached `/list` shell, and the per-user-DB-wipe-on-sign-out invariants all still hold (privacy e2e green).
7. CI (lint, typecheck, build, unit, RLS) is green; `0007` applies cleanly to the cloud project on merge.
8. Scope held: ≤1 household per user, exactly one shared list, equal-write members, in-app invites, foreground sync — no multi-household, roles, email invites, or real-time.
