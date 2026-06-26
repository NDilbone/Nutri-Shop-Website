-- supabase/migrations/0006_invite_admin.sql — Phase 6A: admin role + invite admin RPCs

-- ============ admin flag ============
alter table public.profiles
  add column is_admin boolean not null default false;

-- CRITICAL escalation lockdown: 0001 granted whole-row UPDATE on profiles to
-- `authenticated`, and profiles_update_own lets a user write their own row. Without
-- this, a user could `update profiles set is_admin = true where id = auth.uid()` and
-- self-promote. Restrict authenticated UPDATE to the single column users may change;
-- is_admin then becomes writable only by service_role / SECURITY DEFINER functions.
revoke update on public.profiles from authenticated;
grant  update (display_name) on public.profiles to authenticated;

-- ============ admin predicate (reusable primitive) ============
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and is_admin
  );
$$;

-- ============ admin RPCs (each self-gates on is_admin()) ============
create or replace function public.admin_add_invite(p_email text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  insert into public.invites (email) values (lower(trim(p_email)))
  on conflict (email) do nothing;
end;
$$;

create or replace function public.admin_revoke_invite(p_email text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  delete from public.invites where email = lower(trim(p_email));
end;
$$;

create or replace function public.admin_list_invites()
returns table (email text, invited_at timestamptz, user_id uuid, status text)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    select
      i.email,
      i.invited_at,
      u.id as user_id,
      case
        when u.id is null then 'pending'
        when u.banned_until is not null and u.banned_until > now() then 'banned'
        else 'joined'
      end as status
    from public.invites i
    left join auth.users u on lower(u.email) = i.email
    order by i.invited_at desc;
end;
$$;

-- ============ active-admin count (for the last-admin ban guard) ============
-- Counts admins who are NOT currently banned (ban state lives in auth.users,
-- not profiles). Called by the service-role ban op, which has no auth.uid(), so
-- this is intentionally NOT is_admin()-gated; it returns only an integer.
create or replace function public.count_active_admins()
returns integer
language sql
security definer
set search_path = ''
stable
as $$
  select count(*)::int
  from public.profiles p
  join auth.users u on u.id = p.id
  where p.is_admin and (u.banned_until is null or u.banned_until <= now());
$$;

-- ============ auth.users read access (REQUIRED, unconditional) ============
-- admin_list_invites() and count_active_admins() read auth.users (owned by
-- supabase_auth_admin). Supabase cloud's postgres owner already has access, but a
-- fresh local/CI stack does NOT guarantee it — without this, the first call raises
-- 42501 and fails rls.yml. Idempotent/harmless where access already exists.
grant usage on schema auth to postgres;
grant select on auth.users to postgres;

-- ============ grants (the is_admin() guard is the real gate) ============
grant execute on function public.is_admin()                to authenticated;
grant execute on function public.admin_add_invite(text)    to authenticated;
grant execute on function public.admin_revoke_invite(text) to authenticated;
grant execute on function public.admin_list_invites()      to authenticated;
grant execute on function public.count_active_admins()     to service_role;
