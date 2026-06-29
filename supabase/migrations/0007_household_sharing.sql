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
