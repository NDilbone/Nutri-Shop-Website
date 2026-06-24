-- supabase/migrations/0002_food_cache.sql — Phase 1: FDC food cache + per-user rate limit

-- ============ food_cache (public CC0 reference data; authed-read, privileged-write) ============
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
-- No insert/update/delete policy => writes only via upsert_food_cache (SECURITY DEFINER).

-- ============ upsert_food_cache: privileged write without a service-role client ============
create or replace function public.upsert_food_cache(
  p_fdc_id bigint, p_data_type text, p_description text,
  p_brand_owner text, p_gtin_upc text, p_raw jsonb, p_nutrition jsonb
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.food_cache
    (fdc_id, data_type, description, brand_owner, gtin_upc, raw, nutrition, fetched_at)
  values
    (p_fdc_id, p_data_type, p_description, p_brand_owner, p_gtin_upc, p_raw, p_nutrition, now())
  on conflict (fdc_id) do update set
    data_type   = excluded.data_type,
    description = excluded.description,
    brand_owner = excluded.brand_owner,
    gtin_upc    = excluded.gtin_upc,
    raw         = excluded.raw,
    nutrition   = excluded.nutrition,
    fetched_at  = now();
end; $$;

-- ============ api_rate_limit (per-user fixed window; default-deny) ============
create table public.api_rate_limit (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  window_start  timestamptz not null default now(),
  request_count int not null default 0
);
alter table public.api_rate_limit enable row level security;
-- No policies => default-deny. Touched only via check_and_increment_rate (SECURITY DEFINER).

-- ============ check_and_increment_rate: atomic fixed-window counter ============
-- Identity comes from auth.uid() INSIDE the function, never from a client argument.
create or replace function public.check_and_increment_rate(
  p_limit int, p_window_seconds int
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  allowed boolean;
begin
  if uid is null then return false; end if;

  insert into public.api_rate_limit (user_id, window_start, request_count)
    values (uid, now(), 1)
  on conflict (user_id) do update set
    window_start = case
      when public.api_rate_limit.window_start < now() - make_interval(secs => p_window_seconds)
      then now() else public.api_rate_limit.window_start end,
    request_count = case
      when public.api_rate_limit.window_start < now() - make_interval(secs => p_window_seconds)
      then 1 else public.api_rate_limit.request_count + 1 end
  returning (request_count <= p_limit) into allowed;

  return allowed;
end; $$;

-- ============ grants ============
grant select on public.food_cache to authenticated;
grant all    on public.food_cache to service_role;
grant all    on public.api_rate_limit to service_role;
grant execute on function public.upsert_food_cache(bigint,text,text,text,text,jsonb,jsonb) to authenticated;
grant execute on function public.check_and_increment_rate(int,int) to authenticated;
