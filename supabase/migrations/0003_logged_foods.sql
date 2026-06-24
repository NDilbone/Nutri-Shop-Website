-- Phase 2: per-user food log. Owner-only RLS. Nutrition is snapshotted per row
-- (a log is a historical fact: it must not change if USDA refreshes or the cache evicts).

create table public.logged_foods (
  id           uuid primary key default gen_random_uuid(),       -- DB default; a client may also mint (offline-ready, Phase 5)
  user_id      uuid not null references auth.users (id) on delete cascade,
  fdc_id       bigint not null,                                   -- source food (re-open / future re-derive)
  description  text not null,                                     -- label snapshot at log time
  meal         text not null check (meal in ('breakfast','lunch','dinner','snack')),
  amount_grams numeric not null check (amount_grams > 0 and amount_grams <= 100000),
  nutrition    jsonb not null,                                    -- per-100g NormalizedNutrition snapshot
  logged_on    date not null,                                     -- day it counts toward (client local tz)
  logged_at    timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz                                        -- soft delete (sync-ready, Phase 5)
);

create index logged_foods_user_day
  on public.logged_foods (user_id, logged_on)
  where deleted_at is null;

alter table public.logged_foods enable row level security;

create policy "logged_foods_select_own" on public.logged_foods
  for select using ( (select auth.uid()) = user_id );
create policy "logged_foods_insert_own" on public.logged_foods
  for insert with check ( (select auth.uid()) = user_id );
create policy "logged_foods_update_own" on public.logged_foods
  for update using ( (select auth.uid()) = user_id )
             with check ( (select auth.uid()) = user_id );
create policy "logged_foods_delete_own" on public.logged_foods
  for delete using ( (select auth.uid()) = user_id );

-- Explicit grants: a fresh local CI stack lacks Supabase's implicit defaults
-- (lesson from 0001). RLS still gates which rows each role can touch.
grant all on public.logged_foods to service_role;
grant select, insert, update, delete on public.logged_foods to authenticated;

-- Bump updated_at on every UPDATE (last-write-wins sync, Phase 5).
create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end; $$;

create trigger logged_foods_set_updated_at
  before update on public.logged_foods
  for each row execute function public.set_updated_at();
