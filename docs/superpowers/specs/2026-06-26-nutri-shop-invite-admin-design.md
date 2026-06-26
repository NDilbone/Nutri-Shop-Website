# Nutri-Shop — Phase 6A: invite-admin UI (design)

**Date:** 2026-06-26
**Author:** NDilbone
**Status:** Approved design, pending implementation plan
**Predecessor:** [`2026-06-25-nutri-shop-offline-sync-design.md`](./2026-06-25-nutri-shop-offline-sync-design.md) (Phase 5) · [`2026-06-25-nutri-shop-pwa-desktop-design.md`](./2026-06-25-nutri-shop-pwa-desktop-design.md) (Phase 4) · [`2026-06-24-nutri-shop-shopping-list-design.md`](./2026-06-24-nutri-shop-shopping-list-design.md) (Phase 3) · [`2026-06-24-nutri-shop-macro-tracker-design.md`](./2026-06-24-nutri-shop-macro-tracker-design.md) (Phase 2) · [`2026-06-24-nutri-shop-usda-food-search-design.md`](./2026-06-24-nutri-shop-usda-food-search-design.md) (Phase 1) · foundation [`2026-06-23-nutri-shop-foundation-design.md`](./2026-06-23-nutri-shop-foundation-design.md)

## Roadmap context — Phase 6 is three sub-projects

The roadmap names Phase 6 as "hardening": **invite-admin UI**, **MFA**, and **shared/household list**. These are three independent subsystems with different size and risk, so each gets its own spec → plan → build → PR cycle. Agreed build order:

1. **6A — invite-admin UI** *(this spec)* — smallest, lowest risk; introduces a reusable `is_admin` primitive; removes the manual Supabase-dashboard-SQL workflow for invites. No interaction with the offline/encryption model.
2. **6B — MFA (TOTP)** — self-contained security hardening on Supabase Auth primitives; can reuse the admin primitive.
3. **6C — shared/household list** — largest and riskiest; collides with Phase 5's per-user non-extractable AES key (a shared list needs a shared key or server-side decrypt) and rewrites the list RLS + cross-user sync. Deserves its own deep brainstorm and the heaviest adversarial pass.

**Scope of this spec:** 6A only.

---

## 1. Goal & non-goals

### Goal

An admin user opens an in-app **Admin** screen and can:

- **Add** an email to the invite allowlist so that person may sign up.
- **See** every invited email with its status — *pending* (no account yet), *joined* (account exists), or *banned* (account disabled).
- **Revoke** a pending invite so the email can no longer be used to sign up.
- **Disable / re-enable** a joined user — a reversible ban that locks them out of login but keeps their data, and which also revokes their invite so they cannot sign up into a fresh account around the ban.

Today, invites are added only by hand via the Supabase dashboard SQL editor. 6A moves that into the product, gated behind an admin role, with no new exposure of the `invites` or `auth.users` tables and the smallest possible use of the service-role key.

### Non-goals (6A — deferred)

- **Hard delete of a user / their data.** Removal is a reversible ban only. `admin.deleteUser` + cascade is explicitly out; can be added later behind a confirm gate if ever needed.
- **Sending invite emails.** Adding an invite is **allowlist-only** — the invitee self-signs-up via the existing signup page; the admin notifies them out-of-band. No `inviteUserByEmail`, no email template, no service-role on the common "add" action. (Deferred; would change "pending" to mean invited-but-unconfirmed and add an email template.)
- **A general role system.** A single boolean `is_admin` on `profiles` is enough for a private family app. No roles enum/table (YAGNI).
- **Self-service admin management UI** (granting/revoking admin from the screen). The first admin is bootstrapped by a one-time DB statement (§6). Granting further admins is a manual DB step for now; a UI for it is deferred.
- **Audit log of admin actions.** Not in 6A.
- **MFA and shared lists** — Phases 6B / 6C.

---

## 2. Decisions locked

| # | Decision | Rationale |
|---|----------|-----------|
| Admin model | A boolean **`is_admin` on `profiles`**, default `false`. | Smallest primitive that supports >1 admin and is reusable by 6B/6C. No env-coupling, no roles table. |
| Access model | **Approach 1 (hybrid):** invite add/list/revoke via admin-gated `SECURITY DEFINER` RPCs (no service-role); **ban** via the service-role admin client (the only op with no safe SQL equivalent). | Keeps the service-role surface to the single operation that genuinely needs it; mirrors the vetted RPC+RLS-test pattern (`sync_shopping_items`). |
| Remove semantics | **Reversible ban** (`ban_duration`), data retained, re-enable supported; ban also **revokes the invite**. No hard delete. | No destructive path from a single web tap; "stop their access" is fully met reversibly. Revoking the invite stops re-signup into a fresh account. |
| Invite delivery | **Allowlist-only**; invitee self-signs-up. No email sent. | Matches today's gate flow exactly; avoids an email template + service-role on "add". |
| Escalation lockdown | `is_admin` is **never** user-writable: tighten `profiles` to a **column-level `update` grant** on `display_name` only. | `0001` granted whole-row `update` to `authenticated`; with `profiles_update_own` a user could self-promote. This closes it. Load-bearing. |
| Status source | Derived live in the list RPC by left-joining `invites` to `auth.users` on email; nothing about `auth.users` is exposed via RLS. | No schema bloat (no `accepted_at`); a definer RPC owned by `postgres` may read `auth.users`. |
| Admin gate | New `requireAdmin()` DAL helper, server-side, on top of the existing network-validated `verifySession()`. | Defense in depth beyond the optimistic proxy redirect; same memoized pattern as `requireUser()`. |
| Surfacing | Conditional **Admin** link on `/account` (and optionally SideNav on desktop), shown only to admins. New route `app/(app)/admin`. | No TabBar crowding; non-admins see nothing. |
| SW / CSP | **No change.** `/admin` is authenticated, already covered by the proxy matcher; no public path, no cached data. | First phase since Phase 3 that touches no service worker / CSP surface. |

---

## 3. Data model & migration `0006`

`supabase/migrations/0006_invite_admin.sql`:

### 3.1 Admin flag + escalation lockdown

```sql
alter table public.profiles
  add column is_admin boolean not null default false;

-- CRITICAL: 0001 granted whole-row UPDATE on profiles to `authenticated`, and
-- profiles_update_own lets a user write their own row — so without this, a user
-- could `update profiles set is_admin = true where id = auth.uid()` and self-promote.
-- Restrict authenticated UPDATE to the one column users may change. is_admin then
-- becomes writable only by service_role / SECURITY DEFINER functions.
revoke update on public.profiles from authenticated;
grant  update (display_name) on public.profiles to authenticated;
```

The `profiles_update_own` policy is unchanged; the column grant is what bounds *which* columns the policy may write.

### 3.2 Admin predicate helper

```sql
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
```

`SECURITY DEFINER` so it can also be used inside policies/functions later (6B/6C) regardless of the caller's row visibility. (A self-check would actually pass under `profiles_select_own` too, but the definer form is the reusable primitive.)

### 3.3 Admin RPCs (all self-gate on `is_admin()`)

Each begins with `if not public.is_admin() then raise exception 'forbidden' using errcode = 'insufficient_privilege'; end if;`

- **`admin_add_invite(p_email text) returns void`** — `insert into public.invites (email) values (lower(p_email)) on conflict (email) do nothing;`
- **`admin_revoke_invite(p_email text) returns void`** — `delete from public.invites where email = lower(p_email);`
- **`admin_list_invites() returns table (email text, invited_at timestamptz, user_id uuid, status text)`** —
  ```sql
  select i.email, i.invited_at, u.id as user_id,
         case
           when u.id is null               then 'pending'
           when u.banned_until > now()     then 'banned'
           else                                 'joined'
         end as status
  from public.invites i
  left join auth.users u on lower(u.email) = i.email
  order by i.invited_at desc;
  ```

All three: `SECURITY DEFINER`, `set search_path = ''`, owned by the migration runner (`postgres`) so the list RPC may read `auth.users`. `grant execute … to authenticated` (the `is_admin()` guard is the real gate; a non-admin caller raises `forbidden`).

Emails are normalized to lowercase on write and compared lowercase on join, matching how the existing gate trigger keys `invites.email`.

### 3.4 What the migration does **not** do

- It does **not** set any `is_admin = true`. The first admin is bootstrapped out-of-band (§6) so no personal email is committed to the repo (consistent with the project's no-personal-data-in-files discipline).
- No new table, no change to `invites` columns, no change to RLS *policies* (only the column grant).

---

## 4. Access / enforcement

### 4.1 `requireAdmin()` — `lib/dal/session.ts`

```ts
export async function requireAdmin(): Promise<{ userId: string }> {
  const session = await requireUser();              // Gate 2: network-validated getUser
  const supabase = await createClient();            // authenticated server client
  const { data } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", session.userId)
    .single();                                       // own row — profiles_select_own allows it
  if (!data?.is_admin) redirect("/today");           // not an admin → bounce, reveal nothing
  return session;
}
```

Memoized via the existing React `cache` boundary (it composes `verifySession`). The `/admin` page and **every** admin Server Action call `requireAdmin()` first.

### 4.2 Invite ops — no service-role

`app/(app)/admin/actions.ts` Server Actions (`"use server"`):

- `addInvite(email)` → `requireAdmin()` → validate with Zod → `supabase.rpc("admin_add_invite", { p_email })` → `revalidatePath("/admin")`.
- `revokeInvite(email)` → `requireAdmin()` → `supabase.rpc("admin_revoke_invite", { p_email })` → revalidate.
- The list is read in the page via `supabase.rpc("admin_list_invites")`.

All use the **authenticated** server client (anon key + session cookie); RLS/`is_admin()` enforces. No service-role.

### 4.3 Ban — the single service-role op

```ts
async function setUserBanned(targetUserId: string, banned: boolean) {
  const { userId } = await requireAdmin();
  const decision = banGuard({ actorId: userId, targetUserId, banned, ... });
  if (!decision.allowed) throw new Error(decision.reason);

  const admin = createAdminClient();                 // service-role, server-only
  await admin.auth.admin.updateUserById(targetUserId, {
    ban_duration: banned ? "876000h" : "none",       // ~100y ban, or lift
  });
  if (banned) {
    // revoke their invite so a re-signup can't mint a fresh account around the ban
    await supabase.rpc("admin_revoke_invite", { p_email: <their email> });
  }
  revalidatePath("/admin");
}
```

`lib/supabase/admin.ts`'s doc comment is updated to record this second sanctioned use (it currently says "food_cache writes only").

### 4.4 Ban guard (pure, unit-tested) — `banGuard()`

Returns `{ allowed: false, reason }` when:

- **Self-ban:** `targetUserId === actorId` and `banned === true` → block ("cannot disable your own account").
- **Last admin:** target `is_admin` and they are the only non-banned admin → block ("cannot disable the last admin").

Otherwise allowed. The caller supplies the admin/ban facts (target's `is_admin`, count of active admins) so the function stays pure. Re-enable (`banned === false`) is always allowed.

> **Decision (approved):** guards are *self-ban* + *last-admin* only. Banning a non-last admin is permitted (a second admin can discipline another); the last-admin guard prevents total lockout. A `banned` access token already issued remains valid until its ~1h expiry — documented, acceptable for a family app.

---

## 5. UI / routes / nav

- **Route:** `app/(app)/admin/` — `page.tsx` (server component, `requireAdmin()`, renders the list from `admin_list_invites`), `actions.ts` (the four actions above), plus small client components for the add-invite form and per-row action buttons. Reuses the existing dark-editorial primitives (`Input`, `Button`, `Select`/`Checkbox` as needed); no new design system work.
- **Screen layout:** an **add-invite** field + submit at the top; below, the invite list grouped/sorted by status:
  - *Pending* row → **Revoke** (confirm).
  - *Joined* row → **Disable** (confirm).
  - *Banned* row → **Re-enable**.
- **Entry point:** a conditional **Admin** link on `/account`, rendered only when the server knows `is_admin` (the account page already runs server-side and can read it). Optionally a SideNav entry on desktop, gated the same way (the layout would pass an `isAdmin` prop). Non-admins never see the link, and `requireAdmin()` independently bounces direct navigation.
- **Errors:** form validation errors surface inline; action failures (e.g. RPC `forbidden`, network) surface a non-blocking message. A failed ban leaves state unchanged (no partial: invite-revoke runs only after the ban call resolves).

---

## 6. Bootstrap (first admin)

The migration ships the column defaulting `false`, so immediately after deploy **no one is an admin**. Promote the first admin once, by hand, in the Supabase dashboard SQL editor (the same surface used to apply prior migrations):

```sql
update public.profiles
set is_admin = true
where id = (select id from auth.users where email = '<your-admin-email>');
```

This is intentionally **not** committed (keeps the admin email out of the repo). Document the step in the README's admin section. Granting additional admins later uses the same one-liner until/unless a management UI is built.

---

## 7. Security invariants (held)

- **No service-role in the normal request path** — only `setUserBanned` uses it, behind `requireAdmin()`.
- **`invites` and `auth.users` stay unexposed** — no RLS policy is added to either; all access is through admin-gated `SECURITY DEFINER` RPCs that self-check `is_admin()`.
- **No privilege escalation** — `is_admin` is unwritable by `authenticated` (column grant); only definer functions / service-role can set it.
- **Defense in depth** — proxy optimistic redirect → `requireUser()` (Gate 2) → `requireAdmin()` (admin gate) → RPC `is_admin()` self-check (DB-level). A bug in any one layer is backstopped by the next.
- **No new attack surface on the edge** — no CSP, service-worker, or public-path change; `/admin` is just another authenticated route.

---

## 8. Testing

Mirrors prior phases (pure-fn node unit tests + live RLS integration in `rls.yml` + manual e2e).

### 8.1 Pure-fn node tests
- **Invite-email Zod schema** (`lib/validation`): accepts a valid email, lowercases, rejects empty/malformed.
- **`banGuard()`**: self-ban blocked; last-admin blocked; non-last admin allowed; re-enable always allowed.
- **Status derivation** if any pure slice is extracted from the RPC shaping (otherwise covered live).

### 8.2 Live RLS integration (`rls.yml`, fail-closed)
- `is_admin` defaults `false` on a fresh profile.
- **Escalation test (load-bearing):** an authenticated (non-admin) user attempting `update profiles set is_admin = true` on their own row is **denied** by the column grant (row unchanged).
- Non-admin calling `admin_add_invite` / `admin_revoke_invite` / `admin_list_invites` → **raises `forbidden`** / returns nothing.
- Admin calling each → succeeds; `admin_list_invites` reports correct `pending` / `joined` status for seeded fixtures.

### 8.3 Manual e2e (deployed app)
Add invite → appears *pending* → invitee signs up → flips to *joined* → **Disable** → invitee can no longer log in and their invite is gone → **Re-enable** → invitee can log in again → **Revoke** a different pending invite → that email can no longer sign up. Confirm a non-admin sees no Admin link and is bounced from `/admin`.

The ban Auth-API call itself is exercised by manual e2e (no service-role in CI); its decision logic is covered by `banGuard()` unit tests.

---

## 9. Rollout

- Migration `0006` is a schema change → **`db-migrate`** (gated Production approval) and **`rls.yml`** both run on merge to `main`, as in Phases 2/3/5.
- After deploy, run the §6 bootstrap one-liner once to become admin.
- No env-var, dependency, CSP, or service-worker change. README gains an **Admin** section (invite management + the bootstrap step).

---

## 10. Open risks / notes for the plan + adversarial pass

- **`auth.users` readability inside the definer RPC.** The list RPC relies on the `postgres`-owned definer being able to `select … from auth.users`. Verify on the real project and in the fresh CI stack (the same implicit-vs-explicit-grant gap that bit Phase 2's local RLS run). If a fresh stack denies it, add an explicit `grant select on auth.users to postgres` (or scope the read) in `0006`.
- **`banned_until` column.** Confirm the column name/semantics exposed by the installed `gotrue`/Supabase version for the status derivation; `auth.users.banned_until` is the expected field.
- **Re-enable vs invite.** Re-enabling restores login on the existing account (the signup gate does not re-fire on login), so the earlier invite-revoke does not need to be undone. Documented so it isn't "fixed" into re-adding the invite.
- **Active-session lag on ban.** A pre-issued access token survives until ~1h expiry. If immediate cutoff is ever required, a future enhancement can also `auth.admin.signOut`/revoke sessions — out of scope for 6A.
- **Escalation regression guard.** The column grant is the single thing standing between a user and self-promotion; the §8.2 escalation test must be treated as non-skippable.
