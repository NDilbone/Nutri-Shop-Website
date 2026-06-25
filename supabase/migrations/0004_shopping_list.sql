-- Phase 3: per-user shopping list. Owner-only RLS. Item ownership derives through
-- the list (no user_id on items) so a future household share is a policy broaden,
-- not a rewrite. UUID PK + updated_at + deleted_at keep it offline/sync-ready (Phase 5).

create table public.shopping_lists (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users (id) on delete cascade,
  name       text not null default 'Shopping list' check (char_length(name) between 1 and 100),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Exactly one live default list per owner; the DAL's get-or-create relies on this
-- to stay idempotent under a concurrent double-insert.
create unique index shopping_lists_one_default
  on public.shopping_lists (owner_id) where is_default and deleted_at is null;

create table public.shopping_list_items (
  id         uuid primary key default gen_random_uuid(),   -- a client may also mint (offline, Phase 5)
  list_id    uuid not null references public.shopping_lists (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 200),
  quantity   text check (quantity is null or char_length(quantity) <= 50),
  category   text check (category in
               ('produce','meat','dairy','bakery','frozen','pantry','beverages','household','other')),
  fdc_id     bigint,                                        -- set only for USDA-linked items
  checked    boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz                                    -- soft delete; "Clear checked" sets this
);

create index shopping_list_items_list
  on public.shopping_list_items (list_id) where deleted_at is null;

alter table public.shopping_lists      enable row level security;
alter table public.shopping_list_items enable row level security;

-- shopping_lists: owner-only.
create policy "shopping_lists_select_own" on public.shopping_lists
  for select using ( (select auth.uid()) = owner_id );
create policy "shopping_lists_insert_own" on public.shopping_lists
  for insert with check ( (select auth.uid()) = owner_id );
create policy "shopping_lists_update_own" on public.shopping_lists
  for update using ( (select auth.uid()) = owner_id )
             with check ( (select auth.uid()) = owner_id );
create policy "shopping_lists_delete_own" on public.shopping_lists
  for delete using ( (select auth.uid()) = owner_id );

-- shopping_list_items: you may touch an item iff you own its live list.
-- This EXISTS predicate is the forward-compat seam (later: "owner OR member").
create policy "shopping_list_items_select_own" on public.shopping_list_items
  for select using ( exists (
    select 1 from public.shopping_lists l
    where l.id = list_id and l.owner_id = (select auth.uid()) and l.deleted_at is null ) );
create policy "shopping_list_items_insert_own" on public.shopping_list_items
  for insert with check ( exists (
    select 1 from public.shopping_lists l
    where l.id = list_id and l.owner_id = (select auth.uid()) and l.deleted_at is null ) );
create policy "shopping_list_items_update_own" on public.shopping_list_items
  for update using ( exists (
    select 1 from public.shopping_lists l
    where l.id = list_id and l.owner_id = (select auth.uid()) and l.deleted_at is null ) )
             with check ( exists (
    select 1 from public.shopping_lists l
    where l.id = list_id and l.owner_id = (select auth.uid()) and l.deleted_at is null ) );
create policy "shopping_list_items_delete_own" on public.shopping_list_items
  for delete using ( exists (
    select 1 from public.shopping_lists l
    where l.id = list_id and l.owner_id = (select auth.uid()) and l.deleted_at is null ) );

-- Explicit grants: a fresh local CI stack lacks Supabase's implicit defaults (0001 lesson).
grant all on public.shopping_lists      to service_role;
grant all on public.shopping_list_items to service_role;
grant select, insert, update, delete on public.shopping_lists      to authenticated;
grant select, insert, update, delete on public.shopping_list_items to authenticated;

-- Bump updated_at on UPDATE (last-write-wins sync, Phase 5). Reuses set_updated_at() from 0003.
create trigger shopping_lists_set_updated_at
  before update on public.shopping_lists
  for each row execute function public.set_updated_at();
create trigger shopping_list_items_set_updated_at
  before update on public.shopping_list_items
  for each row execute function public.set_updated_at();
