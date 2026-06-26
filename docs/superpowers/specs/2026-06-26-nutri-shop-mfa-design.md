# Nutri-Shop — Phase 6B: MFA (TOTP) (design)

**Date:** 2026-06-26
**Author:** NDilbone
**Status:** Approved design, pending implementation plan
**Predecessor:** [`2026-06-26-nutri-shop-invite-admin-design.md`](./2026-06-26-nutri-shop-invite-admin-design.md) (Phase 6A) · [`2026-06-25-nutri-shop-offline-sync-design.md`](./2026-06-25-nutri-shop-offline-sync-design.md) (Phase 5) · foundation [`2026-06-23-nutri-shop-foundation-design.md`](./2026-06-23-nutri-shop-foundation-design.md)

## Roadmap context — Phase 6B of three

Phase 6 ("hardening") is three independent subsystems, each with its own spec → plan → build → PR cycle:

1. **6A — invite-admin UI** *(shipped, PRs #12/#13)* — introduced the reusable `is_admin` primitive and the second sanctioned service-role use (reversible ban).
2. **6B — MFA (TOTP)** *(this spec)* — self-contained auth hardening on Supabase Auth + AAL primitives; reuses 6A's `is_admin` and service-role admin client.
3. **6C — shared/household list** — largest/riskiest; deferred, own brainstorm.

**Scope of this spec:** 6B only.

---

## 1. Goal & non-goals

### Goal

Add TOTP two-factor authentication on top of the existing email/password Supabase Auth, enforced through Authenticator Assurance Level (AAL):

- **Admins must use MFA** (mandatory). The invite/ban + service-role power of an admin account is the real attack target, so it gets the strongest gate.
- **Members may opt in** (optional). A member with no factor is unaffected; a member who enrolls is thereafter held to aal2 like an admin.
- **A locked-out user is recoverable** by an admin (reusing the 6A service-role client), with a documented Supabase-dashboard break-glass for the last/only admin.

### Non-goals (6B — deferred or out)

- **SMS / WebAuthn factors.** TOTP only (roadmap-locked). Phone/WebAuthn are feature-gated and out.
- **Member-mandatory MFA.** Members are opt-in; not forced.
- **Self-service backup recovery codes.** Recovery is admin-assisted reset + dashboard break-glass; no codes table, no redeem flow.
- **RLS-level aal2 enforcement (Approach B).** Enforcement is app-layer (proxy + DAL). The conditional RLS predicate is documented in §12 as a clean future hardening but is not built now — it fits the member-optional model only with a `SECURITY DEFINER` predicate over `auth.mfa_factors`, adding migration surface and lock-out risk for no gain over the app gate.
- **A custom access-token hook / custom JWT claims.** The proxy stays simple (see §4.3).
- **An in-app password-change page.** The app currently has none (the reset link logs the user in via `/auth/confirm` and lands them on `/today`); this is a pre-existing gap, out of 6B scope. The MFA interaction is covered in §11.
- **Forced re-challenge on an interval.** aal2 persists across token refresh; step-up is once per sign-in (see §3.3).
- **Self-service admin granting.** Still the 6A manual DB step.

---

## 2. Decisions locked

| # | Decision | Rationale |
|---|----------|-----------|
| Factor type | **TOTP only**, via Supabase `auth.mfa.*`. | Roadmap-locked; no SMS/WebAuthn surface. |
| Who must MFA | **Admins mandatory, members optional.** | Protects the high-privilege accounts unconditionally; zero friction for casual members who don't opt in. |
| Required-AAL rule | A session needs **aal2** iff the user **is an admin OR has a verified factor**; else **aal1**. | One predicate drives every gate and screen; encoded as a pure function (§3). |
| Enforcement | **Approach A — proxy unchanged + DAL gate at every protected boundary.** `requireStepUp()` mirrors the existing `requireUser()` pattern. No RLS change. | Matches the project's existing two-gate model; puts the conditional decision where both `is_admin` and factor state are available (app code); near-zero migration. |
| Recovery | **Admin-assisted reset** (service-role `auth.admin.mfa.deleteFactor`) + **dashboard break-glass** for the last admin. | Smallest build; reuses 6A; reset never permanently locks anyone out (forces re-enroll, doesn't delete data). |
| Migration | **None.** Factors live in Supabase-managed `auth.mfa_factors`; `is_admin` already exists. | First phase with no SQL change since the work is entirely app-layer. |
| Proxy | **No MFA logic in `proxy.ts`.** | It has the signed `aal` claim but not `is_admin`/factor state, so it cannot distinguish "member without a factor (fine)" from "needs step-up" — the `(app)` DAL gate owns that decision. No custom JWT claim/hook. |
| Step-up durability | aal2 is **recalculated on every token refresh** from current factors, so it persists; re-challenge only on a new sign-in or after a factor change. | No per-request or interval re-challenge; good UX, still secure. |

---

## 3. The requirement model (the heart of it)

### 3.1 Pure decision function — `lib/auth/mfa-requirement.ts`

```ts
export type AAL = "aal1" | "aal2";
export type MfaRequirement = "ok" | "challenge" | "enroll";

/** Pure policy. Inputs are derived from getAuthenticatorAssuranceLevel() + verifyAdmin(). */
export function mfaRequirement(input: {
  isAdmin: boolean;
  hasVerifiedFactor: boolean;
  currentAAL: AAL;
}): MfaRequirement {
  if (input.currentAAL === "aal2") return "ok";       // already stepped up this session
  if (input.hasVerifiedFactor) return "challenge";    // aal1 + a verified factor → enter a code
  if (input.isAdmin) return "enroll";                 // aal1 + no factor + admin → must set up TOTP
  return "ok";                                        // aal1 + no factor + member → optional, allowed
}
```

### 3.2 Truth table (the unit-test matrix)

| isAdmin | hasVerifiedFactor | currentAAL | result | meaning |
|:---:|:---:|:---:|:---:|---|
| no  | no  | aal1 | **ok** | member, not opted in |
| no  | yes | aal1 | **challenge** | opted-in member, not yet stepped up |
| no  | yes | aal2 | **ok** | opted-in member, stepped up |
| yes | no  | aal1 | **enroll** | admin, no factor → forced setup |
| yes | yes | aal1 | **challenge** | admin, not yet stepped up |
| yes | yes | aal2 | **ok** | admin, stepped up |
| no  | no  | aal2 | **ok** | (unreachable in practice; aal2 implies a factor — still returns ok) |
| yes | no  | aal2 | **ok** | (unreachable; same) |

`hasVerifiedFactor` ⇐ `getAuthenticatorAssuranceLevel().nextLevel === "aal2"` (per Supabase, `nextLevel` is `aal2` iff the user has ≥1 **verified** factor). `currentAAL` ⇐ `.currentLevel`. `isAdmin` ⇐ existing `verifyAdmin()`.

### 3.3 AAL state semantics (from Supabase, confirmed)

| currentLevel | nextLevel | meaning |
|---|---|---|
| aal1 | aal1 | no verified factor |
| aal1 | aal2 | has a verified factor, **not** challenged this session → step up |
| aal2 | aal2 | challenged this session |

An **unverified** factor (mid-enrollment) does **not** flip `nextLevel` to aal2 — so a user is never bounced mid-enroll. `getAuthenticatorAssuranceLevel()` called with no argument reads the cached, signed JWT (microsecond, no network); the `aal` claim's trust comes from the JWT signature, not a round-trip.

---

## 4. Access / enforcement (Approach A)

### 4.1 `requireStepUp()` — `lib/dal/session.ts`

```ts
import { mfaRequirement, type AAL, type MfaRequirement } from "@/lib/auth/mfa-requirement";

/** The MFA requirement for the current session. Memoized per render pass. */
export const verifyStepUp = cache(async (): Promise<MfaRequirement> => {
  const supabase = await createClient();
  const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  const isAdmin = await verifyAdmin();
  return mfaRequirement({
    isAdmin,
    hasVerifiedFactor: data?.nextLevel === "aal2",
    currentAAL: (data?.currentLevel ?? "aal1") as AAL,
  });
});

/** Session + MFA gate. Use at every authenticated (app) boundary. */
export async function requireStepUp(): Promise<{ userId: string }> {
  const session = await requireUser();            // Gate 2: network getUser
  if ((await verifyStepUp()) !== "ok") redirect("/mfa");
  return session;
}
```

### 4.2 `requireAdmin()` composes the step-up gate

Admins are mandatory-MFA, so the admin gate enforces step-up first:

```ts
export async function requireAdmin(): Promise<{ userId: string }> {
  const session = await requireStepUp();          // admin with no factor → redirect /mfa (enroll)
  if (!(await verifyAdmin())) redirect("/today");
  return session;
}
```

(`verifyStepUp` and `requireAdmin` both call the memoized `verifyAdmin` — no duplicate work.)

### 4.3 Call sites — swap `requireUser` → `requireStepUp`

The gate is applied at **every** authenticated boundary, exactly as `requireUser` is today (page renders are covered by the layout; Server Actions / route handlers must each call it, since a direct POST does not re-render the layout):

- `app/(app)/layout.tsx` — `requireUser` → `requireStepUp` (covers all page navigations).
- `app/(app)/today/actions.ts`, `app/(app)/list/actions.ts` — data-mutating member actions: `requireUser` → `requireStepUp`.
- `app/(app)/admin/actions.ts` — already on `requireAdmin` (auto-upgraded via §4.2); no per-action change.
- `app/api/foods/*` and the offline-sync route handler — authenticated boundaries: `requireUser` → `requireStepUp`.

**Exempt (must remain reachable at aal1):**
- `/mfa` page + its server actions — `requireUser` **only** (this is where the user enrolls/challenges; gating it would loop).
- `/account` enroll/disable actions — `requireUser` only. The `(app)` layout already gated the navigation; and Supabase enforces aal2 server-side to unenroll a **verified** factor, so a direct aal1 POST to "disable" fails safely on its own.

**`proxy.ts`: unchanged.** It cannot compute the *required* level (no `is_admin`/factor context in the JWT), so any aal-based redirect there would wrongly bounce members-without-a-factor. The `(app)` server gate runs before any protected content renders and is the authoritative, network-validated layer — strictly better than an optimistic proxy redirect for this decision.

---

## 5. UI / routes / nav

### 5.1 `/mfa` — the forced interstitial (top-level, **outside** `(app)`)

`requireUser()` only. Reads `verifyStepUp()` and branches:

- `"ok"` → `redirect("/today")` (nothing to do here).
- `"enroll"` → **EnrollForm**: render the returned QR + manual-entry secret, user enters a 6-digit code to confirm.
- `"challenge"` → **ChallengeForm**: a 6-digit code field for the existing verified factor.

On success (session promoted to aal2) → `redirect("/today")`. Lives at top level so the `(app)` step-up gate never applies to it (no redirect loop).

### 5.2 `/account` — self-service management (in `(app)`, reachable only once the requirement is met)

- Member, no factor → **"Enable MFA"** (inline enroll, same flow as §5.1 enroll).
- Member, has factor → status + **"Disable MFA"** (unenroll; Supabase requires the current session to be aal2, which it already is here).
- Admin → status + **"Replace"** (reset-then-re-enroll); **no Disable** (mandatory).

### 5.3 `/admin` — admin-assisted reset (6A screen)

Each user row gains a **"Reset MFA"** action (§7). Reuses the existing invite-list layout and per-row action-button pattern.

### 5.4 Nav

No new tab/link beyond the existing conditional **Admin** link. The `/account` MFA section is the member entry point; `/mfa` is reached only by redirect.

---

## 6. Server actions & Supabase API

All MFA mutations are **server actions** using the SSR server client, so the promoted (aal2) session is persisted to cookies server-side, consistent with the existing `app/auth/actions.ts`.

### 6.1 Enroll (with mandatory unverified-factor cleanup)

```ts
// app/mfa/actions.ts (and reused by /account "Enable")
const supabase = await createClient();

// Cleanup: a prior abandoned enroll leaves a dangling UNVERIFIED factor.
// friendly_name is unique-per-user and there's a 10-factor cap, so re-enroll can
// otherwise fail. Unverified factors unenroll at aal1. (~5min auto-expiry is only a backstop.)
const { data: factors } = await supabase.auth.mfa.listFactors();
await Promise.all(
  (factors?.all ?? [])
    .filter((f) => f.status === "unverified")
    .map((f) => supabase.auth.mfa.unenroll({ factorId: f.id })),
);

const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp" });
// friendlyName intentionally omitted to avoid the unique-name collision.
// Return to the client: data.id (factorId), data.totp.qr_code (SVG markup), data.totp.secret.
```

### 6.2 Verify (enroll completion **and** challenge) — `challengeAndVerify`

```ts
const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
// success → SSR client persists the new aal2 session via the cookie adapter → redirect("/today")
```

For the **challenge** screen the `factorId` is the existing verified factor: `(await supabase.auth.mfa.listFactors()).data.totp[0].id`.

### 6.3 QR rendering & CSP

`data.totp.qr_code` is **raw SVG markup** whose module colors are inline `style="fill:..."` attributes (GoTrue uses goqrsvg + svgo). Render it as an **`<img>` data URI** (`svgToDataUri()` → `data:image/svg+xml;utf8,...`), **not** via `dangerouslySetInnerHTML`: injected into the page DOM those inline styles are stripped by the prod CSP (`style-src 'self' 'nonce-...'`, no `'unsafe-inline'`) and the QR renders solid black. As an `<img>` the SVG is an isolated image resource the page `style-src` does not govern, so the fills survive. **No CSP change** — `img-src` already allows `data:`. Also show `data.totp.secret` for manual entry; no service-worker change.

### 6.4 Admin reset — `lib/dal/admin.ts` (service-role)

```ts
export async function resetUserMfa(userId: string): Promise<void> {
  const admin = createAdminClient();                         // service-role, server-only
  const { data } = await admin.auth.admin.mfa.listFactors({ userId }); // -> { factors: Factor[] }
  await Promise.all(
    (data?.factors ?? []).map((f) =>
      admin.auth.admin.mfa.deleteFactor({ id: f.id, userId })),
  );
}
```

Action wrapper (`app/(app)/admin/actions.ts`):

```ts
export async function resetUserMfaAction(targetUserId: string): Promise<void> {
  await requireAdmin();                       // aal2 admin session
  const id = z.uuid().parse(targetUserId);    // boundary-validate the client-supplied id
  await resetUserMfa(id);
  revalidatePath("/admin");
}
```

No guard function is needed (unlike `banGuard`): reset never permanently locks anyone out — a member drops to aal1-ok and may re-opt-in; an admin is forced through `/mfa` enroll on their next request. This is the **third** sanctioned service-role use → update the `lib/supabase/admin.ts` doc comment accordingly.

---

## 7. Recovery

- **Admin reset:** an admin clicks **Reset MFA** on a user row → `resetUserMfaAction` deletes all of that user's factors. Effect: member → aal1-ok (may re-opt-in); admin → forced re-enroll at `/mfa` next request.
- **Last-admin break-glass:** if the only admin loses their device, recover via the Supabase dashboard (delete the user's rows from `auth.mfa_factors`, or use the Auth admin UI), mirroring the 6A first-admin bootstrap. Document in the README MFA section. Because `is_admin` supports more than one admin, a second admin resetting the first is the normal path; the dashboard is the single-admin fallback.

---

## 8. Data model / migration

**No SQL migration.** TOTP factors live in Supabase-managed `auth.mfa_factors`; `is_admin` already exists (0006); Approach A adds no RLS and no new table. 6B ships as application code only.

---

## 9. Security invariants (held)

- **aal2 enforced at every authenticated `(app)` boundary** — layout, data-mutating actions, and admin (composed onto `requireUser`/`requireAdmin`). The `aal` claim is JWT-signed; the gate reads it from the validated session, so it cannot be forged.
- **Service-role only in `resetUserMfa`**, behind `requireAdmin()` (itself an aal2 admin session) — the third and final sanctioned service-role op.
- **Unenroll of a verified factor requires aal2** (Supabase-enforced) — a direct aal1 POST to "disable" fails safely without app-side checks.
- **No privilege/MFA bypass via the proxy** — the proxy carries no aal logic; the authoritative decision is the server gate. No custom JWT claim/hook to widen the trusted surface.
- **No new attack surface on the edge** — `/mfa` is authenticated (`requireUser`); no public path added; no CSP or service-worker change (the QR renders as an `<img>` `data:` URI, already allowed by `img-src`).
- **Members self-disable; admins cannot** — the UI omits Disable for admins, and the gate re-forces enrollment if an admin's factors disappear.

---

## 10. Testing

Mirrors prior phases (pure-fn node unit tests + optional live integration + manual e2e).

### 10.1 Pure-fn node tests (vitest) — required
- **`mfaRequirement()`** — assert the full §3.2 truth table: member no-factor aal1 → `ok`; opted-in member aal1 → `challenge`, aal2 → `ok`; admin no-factor aal1 → `enroll`; admin with factor aal1 → `challenge`, aal2 → `ok`; plus the two unreachable aal2-without-factor rows → `ok`. This is the load-bearing logic and must be exhaustive.

### 10.2 Live integration (CI) — recommended
- In the existing live-Supabase job, with a seeded **invited + confirmed** test user:
  - User client `enroll({factorType:'totp'})` → take `data.totp.secret` → generate a code with **`otplib`** (`authenticator.generate(secret)`) → `challengeAndVerify` → assert `getAuthenticatorAssuranceLevel().currentLevel === 'aal2'`.
  - Service-role `admin.mfa.listFactors({userId})` shows 1 → `deleteFactor` → list empty.
- Adds an `otplib` dev dependency (pin latest stable). If standing up a confirmed-user session in CI proves heavy, downgrade this to manual-only and keep §10.1 + §10.3; decide in the plan.

### 10.3 Manual e2e (deployed app)
- Admin (no factor) logs in → forced to `/mfa` enroll → scans QR → enters code → reaches `/today`; **Admin** link works.
- New session for that admin → `/mfa` **challenge** required before the app.
- Member opts in at `/account` → enrolls → thereafter challenged on each new sign-in.
- Member **disables** at `/account` (aal2) → reverts to aal1-ok, no further prompts.
- Admin **resets** a member from `/admin` → member can re-opt-in; admin resets another admin → that admin is forced to re-enroll next session.
- Non-opted member sees no MFA prompt anywhere.
- (Documented) last-admin dashboard break-glass restores access.

---

## 11. Interactions / rollout

- **Offline (Phase 5):** step-up needs network; MFA gates *online* session establishment. Once aal2 is obtained online it persists across refreshes, so offline use continues unchanged. A user who is offline with an aal1/expired session cannot step up until back online — the same constraint as login.
- **Password recovery + MFA:** the app has no in-app password-change page, so the known `updateUser`-at-aal1 `401` does not apply here. A recovery-link session (aal1) simply flows through the normal `(app)` step-up gate: a user with a factor must still pass TOTP to reach the app — correct, since email access alone must not bypass MFA. A user who lost *both* password and device recovers via admin reset / break-glass (§7).
- **Asymmetric JWT signing keys (ops pre-req):** `getClaims()` in the proxy verifies the JWT **locally against cached JWKS** only with asymmetric signing keys (the current default for new projects); legacy HS256 falls back to a network call per request. The proxy is unchanged either way, but confirm asymmetric keys in the Supabase dashboard so the existing `proxy.ts` stays zero-network. Add to the rollout checklist.
- **Dependencies:** `@supabase/supabase-js` (2.108.2) and `@supabase/ssr` (0.12.0) are already at latest stable — no upgrade. `otplib` is the only new dep (dev, CI test) — pin latest stable.
- **Rollout:** no migration → no `db-migrate` run; ships as app code via the normal PR → Vercel deploy. README gains an **MFA** section (member opt-in, admin mandatory, admin reset, last-admin dashboard break-glass).

---

## 12. Open risks / notes for the plan + adversarial pass

- **AAL refresh lag.** `getAuthenticatorAssuranceLevel` reads the cached JWT; after a factor change (e.g. an admin resetting their *own* factor) the level only updates on the next token refresh (≤ token TTL). The gate is safe-fail (treats the still-aal2 token as valid until refresh). If immediate cutoff is ever required, call `refreshSession()` / `signOut({scope:'global'})` on reset — deferred.
- **Every mutation boundary must call the gate.** The `(app)` layout covers renders; each authenticated Server Action / route handler must independently call `requireStepUp` (or `requireAdmin`). A missed boundary is a hole — the adversarial pass must enumerate every authenticated mutation and confirm coverage (same discipline as `requireUser`).
- **Conditional RLS (future hardening, not built).** If a DB-level backstop is ever wanted, the documented pattern is a `restrictive` policy plus a `SECURITY DEFINER public.requires_aal2(uid)` reading `auth.mfa_factors` (status `verified`) + `profiles.is_admin`, with `auth.uid()`/`auth.jwt()` wrapped in `(select …)` for the per-query initplan. Noted for 6C-era hardening; out of 6B.
- **Unverified-factor cleanup race.** Concurrent enrolls could collide; acceptable for single-user family use, backstopped by the 10-factor cap and ~5-min auto-expiry.
- **TOTP brute force.** Rely on Supabase's built-in attempt limits; surface generic error copy (don't reveal validity), matching the existing auth-error discipline.
- **`/account` factor-status read.** Rendering the right control reads the caller's own factors via `listFactors()` (own session only — no cross-user exposure).

---

## References

- MFA overview & enforcement (AAL semantics, RLS templates): https://supabase.com/docs/guides/auth/auth-mfa
- TOTP guide (AAL state table, step-up branching): https://supabase.com/docs/guides/auth/auth-mfa/totp
- `enroll` / `challenge` / `verify` / `unenroll` / `listFactors` / `getAuthenticatorAssuranceLevel`: https://supabase.com/docs/reference/javascript/auth-mfa-enroll (and sibling `auth-mfa-*` pages)
- `getClaims` (local JWKS vs network): https://supabase.com/docs/reference/javascript/auth-getclaims
- `aal` claim definition: https://supabase.com/docs/guides/auth/jwt-fields
- Next.js SSR (`getClaims` in proxy; never `getSession` server-side): https://supabase.com/docs/guides/auth/server-side/nextjs
- AAL recalculated on refresh: https://deepwiki.com/supabase/auth/6.1-access-tokens-and-jwts
- Admin MFA API, unverified-factor lifecycle, friendly_name uniqueness, 10-factor cap: https://github.com/supabase/auth-js/blob/master/src/GoTrueAdminApi.ts · https://github.com/orgs/supabase/discussions/16067
