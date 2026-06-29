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
      (l.household_id is null and l.owner_id = (select auth.uid()))
      or (l.household_id is not null and public.is_household_member(l.household_id))
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
-- The direct owner_id disjunct short-circuits before can_access_list (a SECURITY
-- DEFINER self-query that an INSERT ... RETURNING cannot see the new row through),
-- so owner inserts on a personal list still read their row back. It is safe against
-- the revocation hole because leave_household reassigns a shared list's owner_id to a
-- remaining member, so a departed creator is never owner_id here.
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
declare v_uid uuid := (select auth.uid()); v_hh uuid; v_left bigint;
begin
  select household_id into v_hh from public.household_members where user_id = v_uid;
  if v_hh is null then raise exception 'forbidden' using errcode = 'insufficient_privilege'; end if;
  delete from public.household_members where household_id = v_hh and user_id = v_uid;
  select count(*) into v_left from public.household_members where household_id = v_hh;
  if v_left = 0 then
    delete from public.households where id = v_hh;  -- cascades shared list + items + invites
  else
    update public.shopping_lists
      set owner_id = (select user_id from public.household_members
                      where household_id = v_hh order by joined_at limit 1)
      where household_id = v_hh and owner_id = v_uid;
  end if;
end;
$$;

grant execute on function public.create_household(text)            to authenticated;
grant execute on function public.invite_to_household(text)         to authenticated;
grant execute on function public.respond_to_invite(uuid, boolean)  to authenticated;
grant execute on function public.leave_household()                 to authenticated;
