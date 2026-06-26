-- Phase 5 offline sync: a client-time "edited_at" clock for last-edit-wins,
-- plus a batched upsert RPC. updated_at (server, trigger now()) stays the pull
-- cursor; edited_at (client) is the conflict tiebreak.

alter table public.shopping_lists
  add column edited_at timestamptz not null default now();

alter table public.shopping_list_items
  add column edited_at timestamptz not null default now();

-- Batched last-edit-wins upsert for shopping list items.
-- SECURITY INVOKER => runs as the calling `authenticated` role, so the existing
-- owner-only RLS policies gate every row (INSERT WITH CHECK + UPDATE USING/WITH
-- CHECK on list ownership). No service-role bypass. A row targeting a list the
-- caller does not own fails RLS and aborts the batch — the only safe outcome.
create or replace function public.sync_shopping_items(p_items jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  insert into public.shopping_list_items
    (id, list_id, name, quantity, category, fdc_id, checked, deleted_at, edited_at)
  select
    (e->>'id')::uuid,
    (e->>'list_id')::uuid,
    e->>'name',
    e->>'quantity',
    e->>'category',
    nullif(e->>'fdc_id', '')::bigint,
    (e->>'checked')::boolean,
    nullif(e->>'deleted_at', '')::timestamptz,
    (e->>'edited_at')::timestamptz
  from jsonb_array_elements(p_items) as e
  on conflict (id) do update set
    name       = excluded.name,
    quantity   = excluded.quantity,
    category   = excluded.category,
    fdc_id     = excluded.fdc_id,
    checked    = excluded.checked,
    deleted_at = excluded.deleted_at,
    edited_at  = excluded.edited_at
  where excluded.edited_at > public.shopping_list_items.edited_at; -- last-edit-wins guard
end;
$$;

grant execute on function public.sync_shopping_items(jsonb) to authenticated;
