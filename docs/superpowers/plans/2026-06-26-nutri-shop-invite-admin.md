# Phase 6A — Invite-Admin UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an admin an in-app screen to add/revoke invite emails and reversibly disable (ban) joined users, gated behind a new `is_admin` role, without exposing the `invites`/`auth.users` tables or putting the service-role key in the normal request path.

**Architecture:** A boolean `is_admin` on `profiles` (locked so users cannot self-promote). Invite add/list/revoke run through admin-gated `SECURITY DEFINER` RPCs (no service-role). The single service-role op — a reversible user ban via the Supabase Auth admin API — lives behind a `requireAdmin()` gate and a pure `banGuard()` decision. A new `app/(app)/admin` route renders the list; the entry point is a conditional link on `/account`.

**Tech Stack:** Next.js 16 App Router (Server Components + Server Actions), Supabase (Postgres + Auth, RLS), TypeScript, Zod 4, Tailwind 4, Vitest. No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-06-26-nutri-shop-invite-admin-design.md`](../specs/2026-06-26-nutri-shop-invite-admin-design.md)

## Global Constraints

- **Identity:** every commit authored by **NDilbone** (repo-local git config is already set to `NDilbone <208098727+NDilbone@users.noreply.github.com>` — do not override it). Never write "RegEdits", "Claude", "AI", or any tool attribution into any commit, file, or artifact.
- **No new dependencies** this phase. If that changes, pin to the current latest stable.
- **Test command:** `pnpm test <path>` — NOT `pnpm test -- <path>` (the `--` runs the whole suite and false-greens a TDD red step).
- **Lint every TS/UI task:** run `pnpm lint`; the Turbopack build skips ESLint, and the React-19 set-state-in-effect rule only surfaces via lint. Derive state at render time — **no `useEffect`** for derived/persisted state.
- **Service-role stays out of the request path** except the one `requireAdmin()`-gated ban op.
- **Emails normalized to lowercase** on every write and compare (matches the existing `invites.email` gate).
- **No CSP / service-worker / public-path change** — `/admin` is an authenticated route already covered by the proxy matcher.
- **Gates that must be green before any commit:** `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

## File Structure

| File | Responsibility |
|------|----------------|
| `lib/validation/admin.ts` (create) | `inviteEmailSchema` — trim + lowercase + validate an invite email. |
| `lib/admin/ban-guard.ts` (create) | Pure `banGuard()` decision (self-ban / last-admin). |
| `supabase/migrations/0006_invite_admin.sql` (create) | `is_admin` column + escalation lockdown + `is_admin()` helper + 3 admin RPCs + grants. |
| `tests/rls/admin.test.ts` (create) | Live RLS: defaults, escalation denial, non-admin RPC rejection, admin success + status. |
| `lib/dal/session.ts` (modify) | Add `verifyAdmin()` + `requireAdmin()`. |
| `lib/dal/admin.ts` (create) | Server-only admin DAL: `listInvites` / `addInvite` / `revokeInvite` (RPCs) + `setUserBanned` (service-role). |
| `lib/supabase/admin.ts` (modify) | Doc comment: record the second sanctioned service-role use (ban). |
| `app/(app)/admin/actions.ts` (create) | Server Actions wrapping the DAL with `requireAdmin()` + validation + `revalidatePath`. |
| `app/(app)/admin/page.tsx` (create) | Server component: `requireAdmin()` → `listInvites()` → render. |
| `app/(app)/admin/AdminView.tsx` (create) | Client UI: add-invite form + status-grouped list + row actions. |
| `app/(app)/account/page.tsx` (modify) | Conditional **Admin** link (shown only to admins). |
| `tests/validation/admin.test.ts` (create) | Unit: `inviteEmailSchema`. |
| `tests/admin/ban-guard.test.ts` (create) | Unit: `banGuard()`. |
| `README.md` (modify) | Admin section + first-admin bootstrap step. |

---

### Task 1: Invite-email validation schema

**Files:**
- Create: `lib/validation/admin.ts`
- Test: `tests/validation/admin.test.ts`

**Interfaces:**
- Consumes: `zod` (`z.string`, `z.email`).
- Produces: `inviteEmailSchema: z.ZodType<string, string>` — parses an unknown/string input to a trimmed, lowercased, validated email string. Throws `ZodError` on invalid input.

- [ ] **Step 1: Write the failing test**

```ts
// tests/validation/admin.test.ts
import { describe, it, expect } from "vitest";
import { inviteEmailSchema } from "@/lib/validation/admin";

describe("inviteEmailSchema", () => {
  it("trims and lowercases a valid email", () => {
    expect(inviteEmailSchema.parse("  Foo@Bar.COM ")).toBe("foo@bar.com");
  });

  it("accepts an already-normalized email", () => {
    expect(inviteEmailSchema.parse("a@b.io")).toBe("a@b.io");
  });

  it("rejects a non-email string", () => {
    expect(() => inviteEmailSchema.parse("not-an-email")).toThrow();
  });

  it("rejects an empty string", () => {
    expect(() => inviteEmailSchema.parse("")).toThrow();
  });

  it("rejects null (a missing form field — formData.get returns null)", () => {
    expect(() => inviteEmailSchema.parse(null)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/validation/admin.test.ts`
Expected: FAIL — cannot resolve `@/lib/validation/admin`.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/validation/admin.ts
import { z } from "zod";

/** Trim + lowercase, then validate as an email. Output is the normalized string. */
export const inviteEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email());
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/validation/admin.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/validation/admin.ts tests/validation/admin.test.ts
git commit -m "feat: add invite-email validation schema for the admin screen"
```

---

### Task 2: Ban-guard decision (pure)

**Files:**
- Create: `lib/admin/ban-guard.ts`
- Test: `tests/admin/ban-guard.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `interface BanGuardInput { actorId: string; targetUserId: string; banned: boolean; targetIsAdmin: boolean; activeAdminCount: number }`
  - `type BanGuardResult = { allowed: true } | { allowed: false; reason: string }`
  - `function banGuard(input: BanGuardInput): BanGuardResult`

- [ ] **Step 1: Write the failing test**

```ts
// tests/admin/ban-guard.test.ts
import { describe, it, expect } from "vitest";
import { banGuard } from "@/lib/admin/ban-guard";

const base = {
  actorId: "admin-1",
  targetUserId: "user-2",
  banned: true,
  targetIsAdmin: false,
  activeAdminCount: 1,
};

describe("banGuard", () => {
  it("allows banning a normal user", () => {
    expect(banGuard(base)).toEqual({ allowed: true });
  });

  it("blocks banning yourself", () => {
    const r = banGuard({ ...base, targetUserId: "admin-1" });
    expect(r.allowed).toBe(false);
  });

  it("blocks banning the last admin", () => {
    const r = banGuard({ ...base, targetIsAdmin: true, activeAdminCount: 1 });
    expect(r.allowed).toBe(false);
  });

  it("allows banning a non-last admin", () => {
    expect(banGuard({ ...base, targetIsAdmin: true, activeAdminCount: 2 })).toEqual({
      allowed: true,
    });
  });

  it("always allows re-enabling (banned=false), even yourself", () => {
    expect(
      banGuard({ ...base, banned: false, targetUserId: "admin-1", targetIsAdmin: true, activeAdminCount: 1 }),
    ).toEqual({ allowed: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/admin/ban-guard.test.ts`
Expected: FAIL — cannot resolve `@/lib/admin/ban-guard`.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/admin/ban-guard.ts
export interface BanGuardInput {
  /** The admin performing the action. */
  actorId: string;
  /** The user being banned/unbanned. */
  targetUserId: string;
  /** true = ban, false = re-enable. */
  banned: boolean;
  /** Whether the target currently has is_admin. */
  targetIsAdmin: boolean;
  /** Count of NON-BANNED admins (from count_active_admins() — already-banned admins are
   *  excluded so the last-admin guard cannot be fooled by a banned co-admin). */
  activeAdminCount: number;
}

export type BanGuardResult = { allowed: true } | { allowed: false; reason: string };

/** Pure authorization decision for the reversible user ban. Re-enabling is always
 *  allowed; banning is blocked for self and for the last remaining admin. */
export function banGuard(input: BanGuardInput): BanGuardResult {
  if (!input.banned) return { allowed: true };
  if (input.targetUserId === input.actorId) {
    return { allowed: false, reason: "You cannot disable your own account." };
  }
  if (input.targetIsAdmin && input.activeAdminCount <= 1) {
    return { allowed: false, reason: "You cannot disable the last admin." };
  }
  return { allowed: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/admin/ban-guard.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/admin/ban-guard.ts tests/admin/ban-guard.test.ts
git commit -m "feat: add pure ban-guard decision (self + last-admin protection)"
```

---

### Task 3: Migration `0006` — admin role, escalation lockdown, admin RPCs

**Files:**
- Create: `supabase/migrations/0006_invite_admin.sql`
- Test: `tests/rls/admin.test.ts`

**Interfaces:**
- Consumes: existing `public.profiles`, `public.invites`, `auth.users`; the test helpers `makeUser`, `admin`, `anonClient`, `HAS_SUPABASE_TEST_ENV` from `tests/rls/helpers.ts`.
- Produces (callable via `supabase.rpc(...)` as `authenticated`):
  - `is_admin() returns boolean`
  - `admin_add_invite(p_email text) returns void`
  - `admin_revoke_invite(p_email text) returns void`
  - `admin_list_invites() returns table (email text, invited_at timestamptz, user_id uuid, status text)` — `status ∈ {'pending','joined','banned'}`
  - New column `public.profiles.is_admin boolean not null default false`, writable only by `service_role` / definer functions.

- [ ] **Step 1: Write the migration**

```sql
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
```

- [ ] **Step 2: Write the live RLS tests**

```ts
// tests/rls/admin.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { HAS_SUPABASE_TEST_ENV, makeUser, admin } from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

if (process.env.REQUIRE_SUPABASE_TESTS === "1" && !HAS_SUPABASE_TEST_ENV) {
  throw new Error("REQUIRE_SUPABASE_TESTS=1 but SUPABASE_TEST_* env is missing");
}

let adminUser: SupabaseClient; // promoted to is_admin
let plainUser: SupabaseClient; // never an admin
let adminUserId: string;
let plainUserId: string;

describe.skipIf(!HAS_SUPABASE_TEST_ENV)("invite-admin RLS + RPCs", () => {
  beforeAll(async () => {
    adminUser = await makeUser("admin-a@example.com", "AdminA-pw-1234!");
    plainUser = await makeUser("plain-b@example.com", "PlainB-pw-1234!");
    adminUserId = (await adminUser.auth.getUser()).data.user!.id;
    plainUserId = (await plainUser.auth.getUser()).data.user!.id;
    // promote adminUser via service role (bypasses the column lockdown)
    const { error } = await admin().from("profiles").update({ is_admin: true }).eq("id", adminUserId);
    if (error) throw error;
  });

  it("is_admin defaults to false on a fresh profile", async () => {
    const { data } = await admin().from("profiles").select("is_admin").eq("id", plainUserId).single();
    expect(data!.is_admin).toBe(false);
  });

  it("ESCALATION: a user CANNOT set is_admin on their own profile", async () => {
    const { error } = await plainUser.from("profiles").update({ is_admin: true }).eq("id", plainUserId);
    expect(error).not.toBeNull(); // column-level grant denies the UPDATE (42501)
    const { data } = await admin().from("profiles").select("is_admin").eq("id", plainUserId).single();
    expect(data!.is_admin).toBe(false); // and it really did not change
  });

  it("a non-admin CANNOT call admin_add_invite", async () => {
    const { error } = await plainUser.rpc("admin_add_invite", { p_email: "x@example.com" });
    expect(error).not.toBeNull();
  });

  it("a non-admin CANNOT call admin_list_invites", async () => {
    const { error } = await plainUser.rpc("admin_list_invites");
    expect(error).not.toBeNull();
  });

  it("an admin CAN add, list, and revoke an invite", async () => {
    const email = "invitee-c@example.com";
    const add = await adminUser.rpc("admin_add_invite", { p_email: "  Invitee-C@Example.com " });
    expect(add.error).toBeNull(); // also proves trim+lowercase

    const list = await adminUser.rpc("admin_list_invites");
    expect(list.error).toBeNull();
    const row = (list.data as Array<{ email: string; status: string }>).find((r) => r.email === email);
    expect(row).toBeDefined();
    expect(row!.status).toBe("pending"); // no account for that email yet

    const revoke = await adminUser.rpc("admin_revoke_invite", { p_email: email });
    expect(revoke.error).toBeNull();
    const after = await adminUser.rpc("admin_list_invites");
    expect((after.data as Array<{ email: string }>).some((r) => r.email === email)).toBe(false);
  });

  it("admin_list_invites reports 'joined' for an email that has an account", async () => {
    // admin-a@example.com has both an invite (makeUser upserts it) and an account.
    const list = await adminUser.rpc("admin_list_invites");
    const row = (list.data as Array<{ email: string; status: string }>).find(
      (r) => r.email === "admin-a@example.com",
    );
    expect(row!.status).toBe("joined");
  });

  it("count_active_admins excludes banned admins (last-admin guard fix)", async () => {
    // Promote plainUser to admin as well, count, then ban them: the active count
    // must drop by exactly one, proving banned admins are not counted as "active".
    await admin().from("profiles").update({ is_admin: true }).eq("id", plainUserId);
    const before = (await admin().rpc("count_active_admins")).data as number;
    expect(before).toBeGreaterThanOrEqual(2);

    await admin().auth.admin.updateUserById(plainUserId, { ban_duration: "876000h" });
    const after = (await admin().rpc("count_active_admins")).data as number;
    expect(after).toBe(before - 1);

    // cleanup so test residue / ordering does not affect other runs
    await admin().auth.admin.updateUserById(plainUserId, { ban_duration: "none" });
    await admin().from("profiles").update({ is_admin: false }).eq("id", plainUserId);
  });
});
```

- [ ] **Step 3: Apply the migration locally and run the tests against a real stack**

Run:
```bash
supabase start
supabase db reset            # applies 0001..0006 fresh
SUPABASE_TEST_URL="$(supabase status -o json | jq -r .API_URL)" \
SUPABASE_TEST_ANON_KEY="$(supabase status -o json | jq -r .ANON_KEY)" \
SUPABASE_TEST_SERVICE_ROLE_KEY="$(supabase status -o json | jq -r .SERVICE_ROLE_KEY)" \
REQUIRE_SUPABASE_TESTS=1 pnpm test tests/rls/admin.test.ts --no-file-parallelism
```
Expected: PASS (7 tests). The `grant ... on auth.users to postgres` lines are already in the migration (Step 1), so `admin_list_invites` / `count_active_admins` must not raise a `42501` permission error; if they do, the grants did not apply — recheck the migration, do not work around it.

(If no local Supabase/Docker is available, the suite self-skips offline; it runs fail-closed in the `rls.yml` workflow on merge. Note that explicitly in the commit body.)

- [ ] **Step 4: Confirm the offline suite still passes (self-skip)**

Run: `pnpm test tests/rls/admin.test.ts`
Expected: SKIPPED (no `SUPABASE_TEST_*` env) — 0 failures.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0006_invite_admin.sql tests/rls/admin.test.ts
git commit -m "feat: add is_admin role, escalation lockdown, and admin invite RPCs (0006)"
```

---

### Task 4: `requireAdmin()` / `verifyAdmin()` server gate

**Files:**
- Modify: `lib/dal/session.ts`

**Interfaces:**
- Consumes: existing `verifySession`, `requireUser` (same file), `createClient` from `@/lib/supabase/server`, `redirect` from `next/navigation`, `cache` from `react`.
- Produces:
  - `verifyAdmin(): Promise<boolean>` — true iff the current session belongs to an admin (memoized).
  - `requireAdmin(): Promise<{ userId: string }>` — redirects non-admins to `/today`; returns the session otherwise.

This is wiring. The **DB-level** admin gate (the `is_admin()` RPC self-check and the column-grant escalation block) is proven live in `tests/rls/admin.test.ts`. `requireAdmin()`/`verifyAdmin()` themselves — the redirect/bounce path — follow the same untested-wiring convention as `requireUser()` (the repo does not mock-test it either) and are covered by manual e2e (§8.3). Do not claim the RLS test exercises the TS helpers; it does not.

- [ ] **Step 1: Add the helpers**

Append to `lib/dal/session.ts`:

```ts
/** True iff the current session belongs to an admin. Memoized per render pass.
 *  Reads the caller's own profile row (allowed by profiles_select_own). */
export const verifyAdmin = cache(async (): Promise<boolean> => {
  const session = await verifySession();
  if (!session) return false;
  const supabase = await createClient();
  const { data } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", session.userId)
    .single();
  return data?.is_admin === true;
});

/** Use in any admin-only page or Server Action. Bounces non-admins; reveals nothing. */
export async function requireAdmin(): Promise<{ userId: string }> {
  const session = await requireUser();
  if (!(await verifyAdmin())) redirect("/today");
  return session;
}
```

- [ ] **Step 2: Verify the gates**

Run: `pnpm typecheck && pnpm lint`
Expected: clean (no type errors, no lint errors).

- [ ] **Step 3: Commit**

```bash
git add lib/dal/session.ts
git commit -m "feat: add requireAdmin/verifyAdmin server-side admin gate"
```

---

### Task 5: Invite DAL (RPC wrappers, no service-role)

**Files:**
- Create: `lib/dal/admin.ts`

**Interfaces:**
- Consumes: `createClient` from `@/lib/supabase/server`.
- Produces:
  - `type InviteStatus = "pending" | "joined" | "banned"`
  - `interface InviteRow { email: string; invited_at: string; user_id: string | null; status: InviteStatus }`
  - `listInvites(): Promise<InviteRow[]>`
  - `addInvite(email: string): Promise<void>`
  - `revokeInvite(email: string): Promise<void>`

Wiring task — assumes the caller is already admin-gated (the RPCs self-gate too).

- [ ] **Step 1: Write the file**

```ts
// lib/dal/admin.ts
import "server-only";
import { createClient } from "@/lib/supabase/server";

export type InviteStatus = "pending" | "joined" | "banned";

export interface InviteRow {
  email: string;
  invited_at: string;
  user_id: string | null;
  status: InviteStatus;
}

/** All invites with derived status. Calls the admin-gated SECURITY DEFINER RPC. */
export async function listInvites(): Promise<InviteRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_list_invites");
  if (error) throw new Error("failed to list invites");
  return (data ?? []) as InviteRow[];
}

/** Add an email to the allowlist (idempotent). Caller must be admin. */
export async function addInvite(email: string): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_add_invite", { p_email: email });
  if (error) throw new Error("failed to add invite");
}

/** Remove an email from the allowlist. Caller must be admin. */
export async function revokeInvite(email: string): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_revoke_invite", { p_email: email });
  if (error) throw new Error("failed to revoke invite");
}
```

- [ ] **Step 2: Verify the gates**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add lib/dal/admin.ts
git commit -m "feat: add invite admin DAL (list/add/revoke via gated RPCs)"
```

---

### Task 6: Ban DAL (the single service-role op) + admin client doc

**Files:**
- Modify: `lib/dal/admin.ts`
- Modify: `lib/supabase/admin.ts`

**Interfaces:**
- Consumes: `createAdminClient` from `@/lib/supabase/admin`; `banGuard` from `@/lib/admin/ban-guard`; the `count_active_admins` RPC from migration `0006`.
- Produces: `setUserBanned(args: { actorId: string; targetUserId: string; banned: boolean }): Promise<void>`

- [ ] **Step 1: Update the admin-client doc comment**

In `lib/supabase/admin.ts`, replace the JSDoc on `createAdminClient` with:

```ts
/** Service-role client. Bypasses RLS — use ONLY for sanctioned server-side admin ops,
 *  each behind an is_admin gate: (1) writes to public reference tables (food_cache);
 *  (2) the reversible user ban via the Auth admin API (lib/dal/admin.ts setUserBanned).
 *  NEVER expose to the client; never use in the normal authenticated request path. */
```

- [ ] **Step 2: Add `setUserBanned` to `lib/dal/admin.ts`**

First add these two imports to the **existing import block at the top** of the file (Task 5 already created it):

```ts
import { createAdminClient } from "@/lib/supabase/admin";
import { banGuard } from "@/lib/admin/ban-guard";
```

Then append the constant and function at the **end** of the file:

```ts
const PERMANENT_BAN = "876000h"; // ~100 years; Supabase ban_duration string

/** Reversibly ban/unban a user via the Auth admin API. The ONLY service-role op in
 *  this DAL. The invite row is intentionally LEFT INTACT — re-entry is already blocked
 *  by the existing account (re-signup is a duplicate) plus the ban; deleting the invite
 *  would hide the banned user from the invite-rooted admin list and break re-enable.
 *  Caller MUST be admin (gated in the Server Action); banGuard blocks self / last-admin.
 *  activeAdminCount comes from count_active_admins() so already-banned admins are excluded. */
export async function setUserBanned(args: {
  actorId: string;
  targetUserId: string;
  banned: boolean;
}): Promise<void> {
  const adminClient = createAdminClient();

  // Facts for the guard: is the target an admin, and how many admins are still ACTIVE
  // (count_active_admins excludes banned admins — a plain is_admin count would not).
  const { data: targetProfile } = await adminClient
    .from("profiles")
    .select("is_admin")
    .eq("id", args.targetUserId)
    .single();
  const { data: activeAdmins, error: countErr } = await adminClient.rpc("count_active_admins");
  if (countErr) throw new Error("failed to count active admins");

  const decision = banGuard({
    actorId: args.actorId,
    targetUserId: args.targetUserId,
    banned: args.banned,
    targetIsAdmin: targetProfile?.is_admin === true,
    activeAdminCount: (activeAdmins as number) ?? 0,
  });
  if (!decision.allowed) throw new Error(decision.reason);

  const { error } = await adminClient.auth.admin.updateUserById(args.targetUserId, {
    ban_duration: args.banned ? PERMANENT_BAN : "none",
  });
  if (error) throw new Error("failed to update user ban state");
}
```

- [ ] **Step 3: Verify the gates**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: clean; existing unit suite unaffected.

- [ ] **Step 4: Commit**

```bash
git add lib/dal/admin.ts lib/supabase/admin.ts
git commit -m "feat: add reversible user ban (service-role, guarded) to the admin DAL"
```

---

### Task 7: Admin Server Actions

**Files:**
- Create: `app/(app)/admin/actions.ts`

**Interfaces:**
- Consumes: `requireAdmin` from `@/lib/dal/session`; `addInvite`, `revokeInvite`, `setUserBanned` from `@/lib/dal/admin`; `inviteEmailSchema` from `@/lib/validation/admin`; `revalidatePath` from `next/cache`.
- Produces (server actions):
  - `addInviteAction(formData: FormData): Promise<void>`
  - `revokeInviteAction(email: string): Promise<void>`
  - `setBanAction(targetUserId: string, banned: boolean): Promise<void>`

- [ ] **Step 1: Write the actions**

```ts
// app/(app)/admin/actions.ts
"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/dal/session";
import { addInvite, revokeInvite, setUserBanned } from "@/lib/dal/admin";
import { inviteEmailSchema } from "@/lib/validation/admin";

export async function addInviteAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const email = inviteEmailSchema.parse(formData.get("email"));
  await addInvite(email);
  revalidatePath("/admin");
}

export async function revokeInviteAction(email: string): Promise<void> {
  await requireAdmin();
  const parsed = inviteEmailSchema.parse(email);
  await revokeInvite(parsed);
  revalidatePath("/admin");
}

export async function setBanAction(targetUserId: string, banned: boolean): Promise<void> {
  const { userId } = await requireAdmin();
  // Validate the client-supplied id shape (boundary input). Any admin may target any
  // user id by design — this just fails fast on malformed input; banGuard enforces the rest.
  const id = z.uuid().parse(targetUserId);
  await setUserBanned({ actorId: userId, targetUserId: id, banned });
  revalidatePath("/admin");
}
```

- [ ] **Step 2: Verify the gates**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add "app/(app)/admin/actions.ts"
git commit -m "feat: add admin Server Actions (add/revoke invite, set ban)"
```

---

### Task 8: Admin page + client view

**Files:**
- Create: `app/(app)/admin/page.tsx`
- Create: `app/(app)/admin/AdminView.tsx`

**Interfaces:**
- Consumes: `requireAdmin` from `@/lib/dal/session`; `listInvites`, `type InviteRow` from `@/lib/dal/admin`; the actions from `./actions`; `Input`, `Button` primitives from `@/components/ui/*`.
- Produces: the default-exported `AdminPage` server component and the `AdminView` client component.

- [ ] **Step 1: Write the page (server component)**

```tsx
// app/(app)/admin/page.tsx
import { requireAdmin } from "@/lib/dal/session";
import { listInvites } from "@/lib/dal/admin";
import { AdminView } from "./AdminView";

export default async function AdminPage() {
  await requireAdmin(); // bounces non-admins to /today
  const invites = await listInvites();

  return (
    <main className="p-4">
      <h1 className="mb-4 text-xl font-semibold">Admin</h1>
      <AdminView invites={invites} />
    </main>
  );
}
```

- [ ] **Step 2: Write the client view**

```tsx
// app/(app)/admin/AdminView.tsx
"use client";

import { useRef, useState, useTransition } from "react";
import type { InviteRow } from "@/lib/dal/admin";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { addInviteAction, revokeInviteAction, setBanAction } from "./actions";

export function AdminView({ invites }: { invites: InviteRow[] }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const run = (fn: () => Promise<void>) =>
    startTransition(async () => {
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Action failed.");
      }
    });

  const onAdd = (formData: FormData) =>
    run(async () => {
      await addInviteAction(formData);
      formRef.current?.reset();
    });

  return (
    <div className="space-y-6">
      <form ref={formRef} action={onAdd} className="flex gap-2">
        <Input name="email" type="email" required placeholder="invite email" aria-label="Invite email" />
        <Button type="submit" disabled={pending}>Add</Button>
      </form>

      {error && <p role="alert" className="text-sm text-danger">{error}</p>}

      <ul className="divide-y divide-border">
        {invites.map((inv) => (
          <li key={inv.email} className="flex items-center justify-between gap-3 py-2 text-sm">
            <span className="min-w-0 flex-1 break-all">
              {inv.email}{" "}
              <span className="text-muted">· {inv.status}</span>
            </span>

            {inv.status === "pending" && (
              <Button
                type="button"
                disabled={pending}
                onClick={() => {
                  if (window.confirm(`Revoke the invite for ${inv.email}?`)) run(() => revokeInviteAction(inv.email));
                }}
              >
                Revoke
              </Button>
            )}

            {inv.status === "joined" && inv.user_id && (
              <Button
                type="button"
                disabled={pending}
                onClick={() => {
                  if (window.confirm(`Disable ${inv.email}? They will be logged out and cannot sign back in.`))
                    run(() => setBanAction(inv.user_id!, true));
                }}
              >
                Disable
              </Button>
            )}

            {inv.status === "banned" && inv.user_id && (
              <Button type="button" disabled={pending} onClick={() => run(() => setBanAction(inv.user_id!, false))}>
                Re-enable
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

> If `Input`/`Button` props differ from this usage (e.g. no `name`/`onClick` passthrough), check the primitive's signature in `components/ui/` and adapt — do not change the primitive's public API. The `Input` already forwards refs/props (Phase 3); `Button` is a styled `<button>`.

- [ ] **Step 3: Verify the gates (incl. build — this is presentational)**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: clean; `/admin` compiles as an authenticated route.

- [ ] **Step 4: Commit**

```bash
git add "app/(app)/admin/page.tsx" "app/(app)/admin/AdminView.tsx"
git commit -m "feat: add /admin invite-management screen"
```

---

### Task 9: Conditional Admin link on `/account`

**Files:**
- Modify: `app/(app)/account/page.tsx`

**Interfaces:**
- Consumes: `verifyAdmin` from `@/lib/dal/session`; `Link` from `next/link`.
- Produces: an **Admin** link rendered only when `verifyAdmin()` is true.

- [ ] **Step 1: Edit the account page**

This is an **additive edit**, NOT a full-file replacement — keep the existing `createClient` / `Card` / `SignOutButton` imports. Make exactly these three changes:
1. Change the existing session import to also pull `verifyAdmin`: `import { requireUser, verifyAdmin } from "@/lib/dal/session";`
2. Add `import Link from "next/link";` to the import block.
3. Add `const isAdmin = await verifyAdmin();` after the `requireUser()` call, and render the conditional link after the sign-out `<div>`.

The full file after the edit (preserving all existing imports):

```tsx
import Link from "next/link";
import { requireUser, verifyAdmin } from "@/lib/dal/session";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { SignOutButton } from "@/components/ui/SignOutButton";

export default async function AccountPage() {
  const { userId } = await requireUser();
  const isAdmin = await verifyAdmin();
  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("profiles").select("id, display_name").eq("id", userId).single();

  return (
    <main className="p-4">
      <h1 className="mb-4 text-xl font-semibold">Account</h1>
      <Card className="p-4 text-sm">
        <p className="text-muted">Signed in as</p>
        <p className="break-all">{profile?.display_name ?? userId}</p>
      </Card>
      <div className="mt-4">
        <SignOutButton />
      </div>
      {isAdmin && (
        <div className="mt-4">
          <Link href="/admin" className="text-sm text-brand underline">
            Admin
          </Link>
        </div>
      )}
    </main>
  );
}
```

- [ ] **Step 2: Verify the gates**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add "app/(app)/account/page.tsx"
git commit -m "feat: surface the Admin link on /account for admins only"
```

---

### Task 10: README admin section + bootstrap doc

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add an Admin section**

Insert the new `## Admin (Phase 6A)` section **immediately before the `## Database migrations` heading** (i.e. after the Phase 5 "Related changes" subsection, around line 101) — do NOT split the Phase 5 content:

```markdown
## Admin (Phase 6A)

Invite management lives in-app at `/admin`, gated to admin users (`profiles.is_admin`).
Admins can add an invite email (allowlist-only — the invitee then self-signs-up),
see each invite's status (pending / joined / banned), revoke a pending invite, and
**disable** (reversibly ban) or **re-enable** a joined user. Disabling keeps the user's
data and leaves their invite intact (they stay listed so they can be re-enabled);
re-entry is already blocked because their account exists and the ban prevents login.
There is no hard delete.

The **Admin** link appears on `/account` only for admins.

### Bootstrapping the first admin

Migration `0006` ships `is_admin` defaulting to `false`, so no one is an admin until
promoted once by hand. In the Supabase dashboard SQL editor (the surface used to apply
migrations), run:

```sql
update public.profiles
set is_admin = true
where id = (select id from auth.users where email = '<your-admin-email>');
```

This is intentionally not committed (keeps the admin email out of the repo). Grant
further admins the same way.
```

- [ ] **Step 2: Verify**

Run: `pnpm lint`
Expected: clean (Markdown only; no code change).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document the admin invite screen and first-admin bootstrap"
```

---

## Self-Review

**1. Spec coverage:**
- §2 admin model (`is_admin`) → Task 3. ✓
- §2/§3.1 escalation lockdown → Task 3 migration + Task 3 escalation RLS test. ✓
- §3.2 `is_admin()` helper → Task 3. ✓
- §3.3 three RPCs (add/revoke/list w/ status) → Task 3 + RLS tests. ✓
- §4.1 `requireAdmin` → Task 4. ✓
- §4.2 invite ops without service-role → Task 5 + Task 7. ✓
- §4.3 ban via service-role, **invite left intact** → Task 6. ✓
- §4.4 ban guard (self/last-admin), active-admin count excludes banned (`count_active_admins`) → Task 2 (pure guard) + Task 3 (RPC + exclusion test) + Task 6 (wires the count). ✓
- §5 route/UI/nav + account entry → Tasks 8, 9. ✓
- §6 bootstrap → Task 10 (README), migration sets no admin (Task 3). ✓
- §8 testing (email schema, banGuard, RLS escalation/gates/status) → Tasks 1, 2, 3. ✓
- §9 rollout (db-migrate + rls on merge; README) → inherent (migration + Task 10). ✓

**2. Placeholder scan:** No "TBD"/"add error handling"-style gaps; every code step is complete. The `<your-admin-email>` token is a documented runtime value the operator fills in, not a plan gap.

**3. Type consistency:** `InviteRow`/`InviteStatus` defined in Task 5, consumed in Tasks 8/9; `banGuard`/`BanGuardInput` defined in Task 2, consumed in Task 6; `setUserBanned` signature defined in Task 6, consumed in Task 7; `requireAdmin`/`verifyAdmin` defined in Task 4, consumed in Tasks 7/8/9; `inviteEmailSchema` defined in Task 1, consumed in Task 7. RPC names (`admin_add_invite`/`admin_revoke_invite`/`admin_list_invites`/`is_admin`) consistent between Task 3 SQL and Task 5 DAL. ✓

**4. Dependency order:** 1 → 2 → 3 (independent pure/DB) → 4 (gate) → 5 (invite DAL, creates `lib/dal/admin.ts`) → 6 (extends it) → 7 (actions) → 8 (UI) → 9 (account link) → 10 (docs). No forward references. ✓

## Adversarial verification (folded in)

A 6-lens + adjudicator workflow reviewed this plan against the spec and the real codebase. Folded fixes:
- **Breaker:** ban deleted the invite while `admin_list_invites` is invite-rooted → banned users vanished, `banned` status + Re-enable unreachable. **Fixed:** ban now leaves the invite intact (re-entry is already blocked by the existing account + the ban). Spec §1/§2/§4.3/§8.3/§10 and the Task 10 README copy updated to match.
- **Important:** last-admin guard counted all `is_admin` rows incl. already-banned admins → potential lockout. **Fixed:** added `count_active_admins()` (excludes banned) + its RLS exclusion test; `setUserBanned` uses it.
- **Important:** `0006` shipped no `auth.users` grant → fresh CI stack could raise `42501`. **Fixed:** unconditional `grant usage on schema auth to postgres; grant select on auth.users to postgres;`.
- **Minors:** `text-danger`+`role="alert"` for the error line; `window.confirm`; explicit additive Task 9 edit; imports-at-top in Task 6; explicit README insertion point; `z.uuid()` on `targetUserId`; Task 4 wording; null-case validation test.
- **Rejected (false positives):** "bare `confirm()` fails lint" and "mid-file imports fail lint" — neither breaks the build (kept as style-only).
