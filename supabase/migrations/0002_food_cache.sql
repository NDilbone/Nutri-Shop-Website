-- supabase/migrations/0002_food_cache.sql — Phase 1: FDC food cache + per-user rate limit

-- ============ food_cache (public CC0 reference data; authed-read, service-role write) ============
create table public.food_cache (
  fdc_id      bigint primary key,
  data_type   text not null,
  description text not null,
  brand_owner text,
  gtin_upc    text,
  raw         jsonb not null,   -- full FDC payload (CC0 — legal to store)
  nutrition   jsonb not null,   -- NormalizedNutrition
  fetched_at  timestamptz not null default now()
);
alter table public.food_cache enable row level security;

create policy "food_cache_select_authenticated"
  on public.food_cache for select
  to authenticated
  using ( true );
-- No insert/update/delete policy => default-deny for authenticated. The server writes the
-- cache with the service-role client (which bypasses RLS) ONLY after fetching the row from
-- FDC. There is deliberately NO authenticated-callable write path: an earlier design exposed
-- a SECURITY DEFINER upsert function to `authenticated`, which let any invited user write
-- arbitrary rows and poison shared nutrition data. Writes are server-only now.

-- ============ api_rate_limit (per-user fixed window; default-deny) ============
create table public.api_rate_limit (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  window_start  timestamptz not null default now(),
  request_count int not null default 0
);
alter table public.api_rate_limit enable row level security;
-- No policies => default-deny. Touched only via check_and_increment_rate (SECURITY DEFINER).

-- ============ check_and_increment_rate: atomic fixed-window counter ============
-- Identity comes from auth.uid() INSIDE the function. The limit and window are CONSTANTS
-- here, NOT client arguments: an earlier design accepted them as parameters, which let an
-- authenticated caller invoke the RPC directly with p_window_seconds => 0 to reset their own
-- counter (or a huge p_limit) and defeat the throttle. Baking them in closes that bypass
-- while still allowing the function to be granted to `authenticated`.
create or replace function public.check_and_increment_rate()
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_limit          constant int := 60;   -- requests allowed per window
  v_window_seconds constant int := 60;   -- window length in seconds
  uid uuid := (select auth.uid());
  allowed boolean;
begin
  if uid is null then return false; end if;

  insert into public.api_rate_limit (user_id, window_start, request_count)
    values (uid, now(), 1)
  on conflict (user_id) do update set
    window_start = case
      when public.api_rate_limit.window_start < now() - make_interval(secs => v_window_seconds)
      then now() else public.api_rate_limit.window_start end,
    request_count = case
      when public.api_rate_limit.window_start < now() - make_interval(secs => v_window_seconds)
      then 1 else public.api_rate_limit.request_count + 1 end
  returning (request_count <= v_limit) into allowed;

  return allowed;
end; $$;

-- ============ grants ============
grant select on public.food_cache to authenticated;
grant all    on public.food_cache to service_role;
grant all    on public.api_rate_limit to service_role;
grant execute on function public.check_and_increment_rate() to authenticated;
