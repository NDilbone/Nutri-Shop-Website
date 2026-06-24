-- 0001_init.sql — foundation schema: profiles, invites, RLS, triggers

-- ============ invites (email allowlist; gates signup) ============
create table public.invites (
  email      text primary key,
  invited_at timestamptz not null default now()
);
alter table public.invites enable row level security;
-- No policies => default-deny for anon/authenticated roles. Only service_role
-- (which bypasses RLS) and SECURITY DEFINER functions can read/write it.

-- ============ profiles (1 row per user) ============
create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at   timestamptz not null default now()
);
alter table public.profiles enable row level security;

create policy "profiles_select_own"
  on public.profiles for select
  using ( (select auth.uid()) = id );

create policy "profiles_update_own"
  on public.profiles for update
  using ( (select auth.uid()) = id )
  with check ( (select auth.uid()) = id );

-- Insert happens via the handle_new_user trigger (SECURITY DEFINER); no broad
-- insert/delete policy is granted to users, so those default-deny.

-- ============ auto-create a profile on signup ============
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- idempotent: never let profile creation 500 a signup
  insert into public.profiles (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============ invite gate: reject signups for non-invited emails ============
-- NOTE: this is a BEFORE INSERT trigger on auth.users (an intentional, non-standard
-- choice over Supabase's "Before User Created" Auth Hook) precisely because it also
-- fires for admin.createUser() — which Auth Hooks bypass — so tests and admin flows
-- are gated identically to public signups.
create or replace function public.gate_signup_by_invite()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.invites i where i.email = new.email) then
    -- generic message: do not reveal invite-vs-duplicate (enumeration)
    raise exception 'signup not permitted' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger gate_signup_before_insert
  before insert on auth.users
  for each row execute function public.gate_signup_by_invite();

-- ============ grants: let the auth admin role read the allowlist ============
-- The gate trigger runs in the auth insert path; grant explicit read access so it
-- cannot fail with an opaque permission error.
grant usage on schema public to supabase_auth_admin;
grant select on public.invites to supabase_auth_admin;
