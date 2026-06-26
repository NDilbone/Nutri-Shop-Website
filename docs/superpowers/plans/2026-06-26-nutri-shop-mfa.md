# Phase 6B — MFA (TOTP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add TOTP two-factor auth on top of the existing Supabase email/password auth — mandatory for admins, optional for members — enforced via Authenticator Assurance Level (AAL2) at every authenticated boundary.

**Architecture:** A pure `mfaRequirement()` function decides per session whether the user is `ok`, must `challenge`, or must `enroll`. A `requireStepUp()` DAL gate (mirroring the existing `requireUser()`) applies that decision at the `(app)` layout, every data-mutating Server Action, and the food API routes; `requireAdmin()` composes it (admins are mandatory-MFA). Enroll/challenge happen on a top-level `/mfa` interstitial (outside the `(app)` gate to avoid a redirect loop); self-service management lives on `/account`; admin-assisted recovery (service-role) lives on `/admin`. No SQL migration — factors live in Supabase-managed `auth.mfa_factors`.

**Tech Stack:** Next.js 16 (App Router, Server Actions), `@supabase/supabase-js` 2.108.2 + `@supabase/ssr` 0.12.0 (`auth.mfa.*` + `auth.admin.mfa.*`), TypeScript, Vitest, Tailwind. Optional live test: `otplib`.

## Global Constraints

- **Factor type:** TOTP only. No SMS/WebAuthn.
- **Policy:** a session needs **aal2** iff the user **is an admin OR has a verified factor**; otherwise aal1 is allowed.
- **Detection:** `getAuthenticatorAssuranceLevel()` → `hasVerifiedFactor = (nextLevel === "aal2")`, `currentAAL = currentLevel`. Called with no args it reads the cached, signed JWT (no network).
- **No SQL migration. No RLS change. No CSP / service-worker change** (the QR is SVG markup, not script).
- **Service-role** (`createAdminClient`) used **only** in `resetUserMfa`, behind `requireAdmin()`.
- **`/mfa` and `/account` enroll/disable actions use `requireUser()` only** (must be reachable at aal1); everything else under `(app)` uses `requireStepUp()` / `requireAdmin()`.
- **Step-up persists across token refresh** — never add an interval re-challenge.
- **Dependencies pinned to latest stable.** `@supabase/*` are already current (do not change). If adding `otplib`, pin the current latest stable from npm.
- **Tests/docs stay in sync.** Pure logic gets an exhaustive unit test that fails first. DAL/gate/UI wiring follows the repo's existing untested-wiring convention (same as `requireUser`/`requireAdmin`) and is covered by the live test (Task 8) + manual e2e (Task 9) — **do not claim the live test exercises the TS wiring; it exercises the Supabase SDK round-trip.**
- **Authorship:** conventional-commit messages; **no AI/Claude attribution** in any commit, comment, doc, or PR.

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/auth/mfa-requirement.ts` (create) | Pure `mfaRequirement()` decision + `AAL`/`MfaRequirement` types. No I/O. |
| `tests/auth/mfa-requirement.test.ts` (create) | Exhaustive truth-table unit test. |
| `lib/dal/mfa.ts` (create) | Server-only MFA DAL: `enrollTotp`, `verifyTotp`, `disableTotp`, `getOwnMfaStatus`, `resetUserMfa`. |
| `lib/supabase/admin.ts` (modify) | Update the service-role doc comment to record the MFA-reset use. |
| `lib/dal/session.ts` (modify) | Add `verifyStepUp` + `requireStepUp`; make `requireAdmin` compose `requireStepUp`. |
| `app/(app)/layout.tsx` (modify) | `requireUser` → `requireStepUp` (keep the `userId` for `OfflineProvider`). |
| `app/(app)/today/actions.ts` (modify) | Add `requireStepUp()` to the three macro actions. |
| `app/(app)/list/actions.ts` (modify) | `requireUser` → `requireStepUp`. |
| `app/api/foods/route.ts`, `app/api/foods/[fdcId]/route.ts` (modify) | After the 401 check, return 403 when `verifyStepUp() !== "ok"`. |
| `app/mfa/actions.ts` (create) | `startEnrollmentAction`, `completeMfaAction` (`requireUser` only). |
| `app/mfa/page.tsx` (create) | Top-level interstitial: branch on `verifyStepUp()`. |
| `app/mfa/EnrollForm.tsx` (create) | Client enroll form (QR + secret + code). Reused by `/account`. |
| `app/mfa/ChallengeForm.tsx` (create) | Client step-up form (code only). |
| `app/(app)/account/actions.ts` (create) | `disableMfaAction`. |
| `app/(app)/account/MfaSection.tsx` (create) | Client MFA management section. |
| `app/(app)/account/page.tsx` (modify) | Render `<MfaSection>` with status + `isAdmin`. |
| `app/(app)/admin/actions.ts` (modify) | Add `resetUserMfaAction`. |
| `app/(app)/admin/AdminView.tsx` (modify) | Add a **Reset MFA** button per joined/banned row. |
| `tests/rls/mfa.test.ts` (create, optional) | Live enroll→verify→aal2 + admin reset, via `otplib`. |
| `README.md` (modify) | MFA section (member opt-in, admin mandatory, reset, break-glass). |

---

## Task 1: Pure `mfaRequirement` decision function

**Files:**
- Create: `lib/auth/mfa-requirement.ts`
- Test: `tests/auth/mfa-requirement.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type AAL = "aal1" | "aal2"`, `type MfaRequirement = "ok" | "challenge" | "enroll"`, and `mfaRequirement(input: { isAdmin: boolean; hasVerifiedFactor: boolean; currentAAL: AAL }): MfaRequirement`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/auth/mfa-requirement.test.ts
import { describe, it, expect } from "vitest";
import { mfaRequirement } from "@/lib/auth/mfa-requirement";

describe("mfaRequirement", () => {
  it("member, no factor, aal1 → ok (optional, allowed)", () => {
    expect(mfaRequirement({ isAdmin: false, hasVerifiedFactor: false, currentAAL: "aal1" })).toBe("ok");
  });
  it("opted-in member, aal1 → challenge", () => {
    expect(mfaRequirement({ isAdmin: false, hasVerifiedFactor: true, currentAAL: "aal1" })).toBe("challenge");
  });
  it("opted-in member, aal2 → ok", () => {
    expect(mfaRequirement({ isAdmin: false, hasVerifiedFactor: true, currentAAL: "aal2" })).toBe("ok");
  });
  it("admin, no factor, aal1 → enroll (forced)", () => {
    expect(mfaRequirement({ isAdmin: true, hasVerifiedFactor: false, currentAAL: "aal1" })).toBe("enroll");
  });
  it("admin, has factor, aal1 → challenge", () => {
    expect(mfaRequirement({ isAdmin: true, hasVerifiedFactor: true, currentAAL: "aal1" })).toBe("challenge");
  });
  it("admin, has factor, aal2 → ok", () => {
    expect(mfaRequirement({ isAdmin: true, hasVerifiedFactor: true, currentAAL: "aal2" })).toBe("ok");
  });
  it("aal2 always resolves ok even without a recorded factor (unreachable, defensive)", () => {
    expect(mfaRequirement({ isAdmin: false, hasVerifiedFactor: false, currentAAL: "aal2" })).toBe("ok");
    expect(mfaRequirement({ isAdmin: true, hasVerifiedFactor: false, currentAAL: "aal2" })).toBe("ok");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test mfa-requirement`
Expected: FAIL — `Cannot find module "@/lib/auth/mfa-requirement"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/auth/mfa-requirement.ts
export type AAL = "aal1" | "aal2";
export type MfaRequirement = "ok" | "challenge" | "enroll";

/** Pure MFA policy. Inputs derive from getAuthenticatorAssuranceLevel() + verifyAdmin().
 *  - "ok": requirement met (or none) — proceed.
 *  - "challenge": user has a verified factor but the session is still aal1 — enter a code.
 *  - "enroll": admin with no factor — must set up TOTP. */
export function mfaRequirement(input: {
  isAdmin: boolean;
  hasVerifiedFactor: boolean;
  currentAAL: AAL;
}): MfaRequirement {
  if (input.currentAAL === "aal2") return "ok";
  if (input.hasVerifiedFactor) return "challenge";
  if (input.isAdmin) return "enroll";
  return "ok";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test mfa-requirement`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/auth/mfa-requirement.ts tests/auth/mfa-requirement.test.ts
git commit -m "feat: add pure MFA requirement decision (admin/factor/aal → ok|challenge|enroll)"
```

---

## Task 2: MFA Data Access Layer

**Files:**
- Create: `lib/dal/mfa.ts`
- Modify: `lib/supabase/admin.ts:6-9` (doc comment)

**Interfaces:**
- Consumes: `createClient` from `@/lib/supabase/server`; `createAdminClient` from `@/lib/supabase/admin`.
- Produces:
  - `interface EnrollResult { factorId: string; qrCodeSvg: string; secret: string }`
  - `enrollTotp(): Promise<EnrollResult>`
  - `verifyTotp(factorId: string, code: string): Promise<void>` (throws `"invalid code"`)
  - `disableTotp(factorId: string): Promise<void>`
  - `interface OwnMfaStatus { hasVerifiedFactor: boolean; verifiedFactorId: string | null }`
  - `getOwnMfaStatus(): Promise<OwnMfaStatus>`
  - `resetUserMfa(userId: string): Promise<void>`

No unit test: every function is a thin Supabase I/O wrapper (testing it would require mocking the entire `auth.mfa` surface — no value over the live test in Task 8). Verified by `pnpm typecheck` here and the live round-trip in Task 8.

- [ ] **Step 1: Create the MFA DAL**

```ts
// lib/dal/mfa.ts
import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export interface EnrollResult {
  factorId: string;
  qrCodeSvg: string;
  secret: string;
}

/** Remove dangling UNVERIFIED factors (friendly_name is unique-per-user and there's a
 *  10-factor cap, so a prior abandoned enroll would otherwise block this), then enroll a
 *  fresh TOTP factor. Unverified factors unenroll at aal1, so this is safe pre-step-up. */
export async function enrollTotp(): Promise<EnrollResult> {
  const supabase = await createClient();
  const { data: factors } = await supabase.auth.mfa.listFactors();
  await Promise.all(
    (factors?.all ?? [])
      .filter((f) => f.status === "unverified")
      .map((f) => supabase.auth.mfa.unenroll({ factorId: f.id })),
  );
  // friendlyName intentionally omitted to avoid the unique-name collision.
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp" });
  if (error || !data) throw new Error("failed to start MFA enrollment");
  return { factorId: data.id, qrCodeSvg: data.totp.qr_code, secret: data.totp.secret };
}

/** Verify a TOTP code (enroll completion or step-up). On success the SSR client persists
 *  the new aal2 session via the cookie adapter. */
export async function verifyTotp(factorId: string, code: string): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
  if (error) throw new Error("invalid code");
}

/** Unenroll a verified factor. Supabase requires the current session to be aal2. */
export async function disableTotp(factorId: string): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  if (error) throw new Error("failed to disable MFA");
}

export interface OwnMfaStatus {
  hasVerifiedFactor: boolean;
  verifiedFactorId: string | null;
}

/** The caller's own verified-factor status (for /account and the /mfa challenge screen).
 *  listFactors().totp contains only VERIFIED TOTP factors. */
export async function getOwnMfaStatus(): Promise<OwnMfaStatus> {
  const supabase = await createClient();
  const { data } = await supabase.auth.mfa.listFactors();
  const verified = data?.totp?.[0];
  return { hasVerifiedFactor: !!verified, verifiedFactorId: verified?.id ?? null };
}

/** Service-role: delete ALL of a target user's factors (admin-assisted reset). After this,
 *  a member drops to aal1-ok; an admin is forced through /mfa enroll on their next request.
 *  No guard needed — reset never permanently locks anyone out. */
export async function resetUserMfa(userId: string): Promise<void> {
  const adminClient = createAdminClient();
  const { data, error } = await adminClient.auth.admin.mfa.listFactors({ userId });
  if (error) throw new Error("failed to list target factors");
  await Promise.all(
    (data?.factors ?? []).map((f) => adminClient.auth.admin.mfa.deleteFactor({ id: f.id, userId })),
  );
}
```

- [ ] **Step 2: Record the third sanctioned service-role use**

In `lib/supabase/admin.ts`, replace the doc comment (lines 6-9) so it lists the MFA-reset use:

```ts
/** Service-role client. Bypasses RLS — use ONLY for sanctioned server-side admin ops,
 *  each behind an is_admin gate: (1) writes to public reference tables (food_cache);
 *  (2) the reversible user ban via the Auth admin API (lib/dal/admin.ts setUserBanned);
 *  (3) admin-assisted MFA reset via the Auth admin API (lib/dal/mfa.ts resetUserMfa).
 *  NEVER expose to the client; never use in the normal authenticated request path. */
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (no type errors). If `auth.admin.mfa` does not type-narrow, confirm `@supabase/supabase-js` is `2.108.2` (it is, per `package.json`).

- [ ] **Step 4: Commit**

```bash
git add lib/dal/mfa.ts lib/supabase/admin.ts
git commit -m "feat: add MFA DAL (enroll/verify/disable/status + service-role reset)"
```

---

## Task 3: Step-up gate in the session DAL

**Files:**
- Modify: `lib/dal/session.ts`

**Interfaces:**
- Consumes: `mfaRequirement`, `type AAL`, `type MfaRequirement` (Task 1); existing `verifySession`, `requireUser`, `verifyAdmin`, `createClient`, `cache`, `redirect`.
- Produces:
  - `verifyStepUp(): Promise<MfaRequirement>` (memoized; non-redirecting — safe for API routes)
  - `requireStepUp(): Promise<{ userId: string }>` (redirects to `/mfa` when not `"ok"`)
  - upgraded `requireAdmin(): Promise<{ userId: string }>` (composes `requireStepUp`)

This is wiring (no return value to assert without a live session), following the same untested convention as `requireUser`/`requireAdmin`. Verified by `pnpm typecheck` + manual e2e (Task 9).

- [ ] **Step 1: Add imports**

At the top of `lib/dal/session.ts`, after the existing imports:

```ts
import { mfaRequirement, type AAL, type MfaRequirement } from "@/lib/auth/mfa-requirement";
```

- [ ] **Step 2: Add `verifyStepUp` and `requireStepUp`**

Insert after `verifyAdmin` (before `requireAdmin`):

```ts
/** The MFA requirement for the current session. Non-redirecting — call this from API
 *  route handlers (which must return JSON, not redirect). Memoized per render pass. */
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

/** Session + MFA gate. Use at every authenticated (app) page/Server Action boundary. */
export async function requireStepUp(): Promise<{ userId: string }> {
  const session = await requireUser(); // Gate 2: network getUser
  if ((await verifyStepUp()) !== "ok") redirect("/mfa");
  return session;
}
```

- [ ] **Step 3: Make `requireAdmin` compose the step-up gate**

Replace the existing `requireAdmin` body:

```ts
/** Use in any admin-only page or Server Action. Admins are mandatory-MFA, so step-up is
 *  enforced first (an admin with no factor is sent to /mfa to enroll). Bounces non-admins. */
export async function requireAdmin(): Promise<{ userId: string }> {
  const session = await requireStepUp();
  if (!(await verifyAdmin())) redirect("/today");
  return session;
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/dal/session.ts
git commit -m "feat: add requireStepUp/verifyStepUp aal2 gate; requireAdmin composes it"
```

---

## Task 4: Enforce the gate at every authenticated boundary

**Files:**
- Modify: `app/(app)/layout.tsx:2,9`
- Modify: `app/(app)/today/actions.ts`
- Modify: `app/(app)/list/actions.ts:8,15`
- Modify: `app/api/foods/route.ts:2,11`
- Modify: `app/api/foods/[fdcId]/route.ts:2,12`

**Interfaces:**
- Consumes: `requireStepUp`, `verifyStepUp` (Task 3); existing `jsonError` (`@/lib/fdc/http`).
- Produces: no new exports.

Wiring; verified by `pnpm typecheck` + `pnpm build` + manual e2e (Task 9).

- [ ] **Step 1: Gate the `(app)` layout**

In `app/(app)/layout.tsx`: change the import on line 2 and the call on line 9.

```ts
import { requireStepUp } from "@/lib/dal/session";
```
```ts
  const { userId } = await requireStepUp(); // Gate 2 + MFA step-up; defense in depth beyond proxy.ts
```

- [ ] **Step 2: Gate the macro Server Actions**

In `app/(app)/today/actions.ts`: add the import and a `requireStepUp()` call at the top of all three actions (the macro DAL only does `verifySession`, so the aal2 gate must be added here).

```ts
import { requireStepUp } from "@/lib/dal/session";
```
Then as the first line inside `addFoodAction`, `editFoodAction`, and `deleteFoodAction` (before the `safeParse`):
```ts
  await requireStepUp();
```

- [ ] **Step 3: Gate the shopping-list sync action**

In `app/(app)/list/actions.ts`: change the import on line 8 and the call on line 15.

```ts
import { requireStepUp } from "@/lib/dal/session";
```
```ts
  await requireStepUp();
```

- [ ] **Step 4: Gate the food API routes (403, not redirect)**

In **both** `app/api/foods/route.ts` and `app/api/foods/[fdcId]/route.ts`: add `verifyStepUp` to the session import and a 403 check immediately after the existing `if (!session) … 401` line.

`app/api/foods/route.ts` — line 2 becomes:
```ts
import { verifySession, verifyStepUp } from "@/lib/dal/session";
```
After line 11 (`if (!session) return jsonError("UNAUTHENTICATED", "Sign in required", 401);`):
```ts
  if ((await verifyStepUp()) !== "ok")
    return jsonError("MFA_REQUIRED", "Multi-factor step-up required", 403);
```
Apply the identical two edits to `app/api/foods/[fdcId]/route.ts` (import on line 2, the 403 check right after its `if (!session)` 401 line).

- [ ] **Step 5: Typecheck, build**

Run: `pnpm typecheck && pnpm build`
Expected: PASS (compiles; no type errors).

- [ ] **Step 6: Commit**

```bash
git add app/\(app\)/layout.tsx app/\(app\)/today/actions.ts app/\(app\)/list/actions.ts app/api/foods/route.ts "app/api/foods/[fdcId]/route.ts"
git commit -m "feat: enforce aal2 step-up at app layout, mutating actions, and food API"
```

---

## Task 5: `/mfa` interstitial — actions, page, forms

**Files:**
- Create: `app/mfa/actions.ts`
- Create: `app/mfa/page.tsx`
- Create: `app/mfa/EnrollForm.tsx`
- Create: `app/mfa/ChallengeForm.tsx`

**Interfaces:**
- Consumes: `enrollTotp`, `verifyTotp`, `getOwnMfaStatus`, `type EnrollResult` (Task 2); `requireUser`, `verifyStepUp` (Task 3); `Input`, `Button` (`@/components/ui/*`); `useRouter` (`next/navigation`).
- Produces:
  - `startEnrollmentAction(): Promise<EnrollResult>`
  - `completeMfaAction(factorId: string, code: string): Promise<void>`
  - `<EnrollForm />` (default-less named export, reused by `/account`)
  - `<ChallengeForm factorId={string} />`

Wiring + UX; verified by `pnpm build` + manual e2e (Task 9). `/mfa` is **top-level** (outside `(app)`) so the step-up gate never applies to it.

- [ ] **Step 1: Create the server actions**

```ts
// app/mfa/actions.ts
"use server";

import { requireUser } from "@/lib/dal/session";
import { enrollTotp, verifyTotp, type EnrollResult } from "@/lib/dal/mfa";

/** Start (or restart) TOTP enrollment. aal1-reachable on purpose. */
export async function startEnrollmentAction(): Promise<EnrollResult> {
  await requireUser();
  return enrollTotp();
}

/** Verify a code for enroll-completion or step-up; promotes the session to aal2. */
export async function completeMfaAction(factorId: string, code: string): Promise<void> {
  await requireUser();
  await verifyTotp(factorId, code);
}
```

- [ ] **Step 2: Create the enroll form**

```tsx
// app/mfa/EnrollForm.tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { startEnrollmentAction, completeMfaAction } from "./actions";

export function EnrollForm({ redirectTo = "/today" }: { redirectTo?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [enroll, setEnroll] = useState<{ factorId: string; qrCodeSvg: string; secret: string } | null>(null);
  const [code, setCode] = useState("");

  const begin = () =>
    startTransition(async () => {
      setError(null);
      try {
        setEnroll(await startEnrollmentAction());
      } catch {
        setError("Could not start setup. Try again.");
      }
    });

  const confirm = () =>
    startTransition(async () => {
      setError(null);
      try {
        await completeMfaAction(enroll!.factorId, code.trim());
        router.replace(redirectTo);
        router.refresh();
      } catch {
        setError("That code didn't match. Try the current 6-digit code.");
      }
    });

  if (!enroll) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Set up an authenticator app (Google Authenticator, 1Password, etc.) to add a second factor.
        </p>
        <Button type="button" disabled={pending} onClick={begin}>Set up authenticator</Button>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* qr_code is SVG markup (not script) — safe to inject; no CSP change. */}
      <div className="rounded-md bg-white p-3" dangerouslySetInnerHTML={{ __html: enroll.qrCodeSvg }} />
      <p className="text-xs text-muted break-all">Can't scan? Enter this secret manually: <code>{enroll.secret}</code></p>
      <Input
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="6-digit code"
        aria-label="Authenticator code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />
      <Button type="button" disabled={pending || code.trim().length < 6} onClick={confirm}>
        Verify & enable
      </Button>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 3: Create the challenge form**

```tsx
// app/mfa/ChallengeForm.tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { completeMfaAction } from "./actions";

export function ChallengeForm({ factorId, redirectTo = "/today" }: { factorId: string; redirectTo?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");

  const submit = () =>
    startTransition(async () => {
      setError(null);
      try {
        await completeMfaAction(factorId, code.trim());
        router.replace(redirectTo);
        router.refresh();
      } catch {
        setError("That code didn't match. Try the current 6-digit code.");
      }
    });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">Enter the current 6-digit code from your authenticator app.</p>
      <Input
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="6-digit code"
        aria-label="Authenticator code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />
      <Button type="button" disabled={pending || code.trim().length < 6} onClick={submit}>Verify</Button>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 4: Create the interstitial page**

```tsx
// app/mfa/page.tsx
import { redirect } from "next/navigation";
import { requireUser, verifyStepUp } from "@/lib/dal/session";
import { getOwnMfaStatus } from "@/lib/dal/mfa";
import { Card } from "@/components/ui/Card";
import { EnrollForm } from "./EnrollForm";
import { ChallengeForm } from "./ChallengeForm";

export default async function MfaPage() {
  await requireUser(); // session only — NOT requireStepUp (this is where step-up happens)
  const requirement = await verifyStepUp();
  if (requirement === "ok") redirect("/today");

  let body = <EnrollForm />;
  if (requirement === "challenge") {
    const { verifiedFactorId } = await getOwnMfaStatus();
    body = verifiedFactorId ? <ChallengeForm factorId={verifiedFactorId} /> : <EnrollForm />;
  }

  return (
    <main className="mx-auto min-h-dvh w-full max-w-[480px] p-4">
      <h1 className="mb-4 text-xl font-semibold">Two-factor authentication</h1>
      <Card className="p-4">{body}</Card>
    </main>
  );
}
```

- [ ] **Step 5: Build**

Run: `pnpm build`
Expected: PASS — `/mfa` route compiles.

- [ ] **Step 6: Commit**

```bash
git add app/mfa
git commit -m "feat: add /mfa interstitial with enroll and step-up flows"
```

---

## Task 6: `/account` self-service MFA section

**Files:**
- Create: `app/(app)/account/actions.ts`
- Create: `app/(app)/account/MfaSection.tsx`
- Modify: `app/(app)/account/page.tsx`

**Interfaces:**
- Consumes: `disableTotp`, `getOwnMfaStatus` (Task 2); `requireUser`, `verifyAdmin` (existing); `EnrollForm` (Task 5); `Card`, `Button`.
- Produces: `disableMfaAction(factorId: string): Promise<void>`; `<MfaSection isAdmin hasFactor factorId>`.

Wiring + UX; `pnpm build` + manual e2e. Per the spec, admins manage device changes via the `/admin` reset path, so `/account` shows admins a read-only status (no Disable/Replace button) — members get Enable/Disable.

- [ ] **Step 1: Create the disable action**

```ts
// app/(app)/account/actions.ts
"use server";

import { disableTotp } from "@/lib/dal/mfa";
import { requireUser } from "@/lib/dal/session";

/** Member self-disable. requireUser only: the (app) layout already gated the navigation,
 *  and Supabase rejects unenrolling a VERIFIED factor unless the session is aal2 — so a
 *  direct aal1 POST fails safely on its own. */
export async function disableMfaAction(factorId: string): Promise<void> {
  await requireUser();
  await disableTotp(factorId);
}
```

- [ ] **Step 2: Create the management section**

```tsx
// app/(app)/account/MfaSection.tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { EnrollForm } from "@/app/mfa/EnrollForm";
import { disableMfaAction } from "./actions";

export function MfaSection({
  isAdmin,
  hasFactor,
  factorId,
}: {
  isAdmin: boolean;
  hasFactor: boolean;
  factorId: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [enrolling, setEnrolling] = useState(false);

  const disable = () =>
    startTransition(async () => {
      setError(null);
      try {
        await disableMfaAction(factorId!);
        router.refresh();
      } catch {
        setError("Could not disable MFA.");
      }
    });

  return (
    <Card className="mt-4 p-4 text-sm">
      <p className="mb-2 font-medium">Two-factor authentication</p>

      {isAdmin && (
        <p className="text-muted">
          Enabled — required for admins. To switch devices, reset it from the{" "}
          <span className="text-text">Admin</span> screen.
        </p>
      )}

      {!isAdmin && hasFactor && (
        <div className="space-y-3">
          <p className="text-muted">Enabled.</p>
          <Button type="button" variant="danger" disabled={pending} onClick={disable}>
            Disable MFA
          </Button>
        </div>
      )}

      {!isAdmin && !hasFactor && !enrolling && (
        <div className="space-y-3">
          <p className="text-muted">Off. Add an authenticator app for extra account security.</p>
          <Button type="button" onClick={() => setEnrolling(true)}>Enable MFA</Button>
        </div>
      )}

      {!isAdmin && !hasFactor && enrolling && <EnrollForm redirectTo="/account" />}

      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </Card>
  );
}
```

- [ ] **Step 3: Render it on the account page**

In `app/(app)/account/page.tsx`, import `getOwnMfaStatus` and `MfaSection`, read the status, and render the section after the sign-out block. The full file:

```tsx
import Link from "next/link";
import { requireUser, verifyAdmin } from "@/lib/dal/session";
import { getOwnMfaStatus } from "@/lib/dal/mfa";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { SignOutButton } from "@/components/ui/SignOutButton";
import { MfaSection } from "./MfaSection";

export default async function AccountPage() {
  const { userId } = await requireUser();
  const isAdmin = await verifyAdmin();
  const { hasVerifiedFactor, verifiedFactorId } = await getOwnMfaStatus();
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

      <MfaSection isAdmin={isAdmin} hasFactor={hasVerifiedFactor} factorId={verifiedFactorId} />

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

- [ ] **Step 4: Build**

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/\(app\)/account
git commit -m "feat: add MFA management section to /account (member enable/disable)"
```

---

## Task 7: Admin-assisted MFA reset

**Files:**
- Modify: `app/(app)/admin/actions.ts`
- Modify: `app/(app)/admin/AdminView.tsx`

**Interfaces:**
- Consumes: `resetUserMfa` (Task 2); `requireAdmin` (Task 3); `z` (`zod`); `revalidatePath`.
- Produces: `resetUserMfaAction(targetUserId: string): Promise<void>`.

Wiring + UX; `pnpm build` + manual e2e.

- [ ] **Step 1: Add the reset action**

In `app/(app)/admin/actions.ts`, add the import and the action:

```ts
import { resetUserMfa } from "@/lib/dal/mfa";
```
```ts
export async function resetUserMfaAction(targetUserId: string): Promise<void> {
  await requireAdmin(); // aal2 admin session
  const id = z.uuid().parse(targetUserId);
  await resetUserMfa(id);
  revalidatePath("/admin");
}
```

- [ ] **Step 2: Add the Reset MFA button to joined/banned rows**

In `app/(app)/admin/AdminView.tsx`: import the new action and render a **Reset MFA** button for rows that have a `user_id` (joined or banned). Update the import on line 8:

```ts
import { addInviteAction, revokeInviteAction, setBanAction, resetUserMfaAction } from "./actions";
```

Inside the `<li>`, after the existing status-specific buttons, add (covers both joined and banned — any row with an account):

```tsx
            {inv.user_id && (
              <div className="shrink-0">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => {
                    if (window.confirm(`Reset MFA for ${inv.email}? They'll set up a new authenticator next sign-in.`))
                      run(() => resetUserMfaAction(inv.user_id!));
                  }}
                >
                  Reset MFA
                </Button>
              </div>
            )}
```

- [ ] **Step 3: Build**

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/\(app\)/admin
git commit -m "feat: add admin-assisted MFA reset to the admin screen"
```

---

## Task 8 (recommended, optional): Live MFA integration test

**Files:**
- Modify: `package.json` (add `otplib` devDependency, latest stable)
- Create: `tests/rls/mfa.test.ts`

**Interfaces:**
- Consumes: `makeUser`, `admin`, `HAS_SUPABASE_TEST_ENV` (`tests/rls/helpers.ts`); `otplib`.

This proves the real Supabase round-trip (enroll → TOTP → aal2, and service-role reset). It does **not** test our TS gates. It runs only when `SUPABASE_TEST_*` env is present (same `describe.skipIf` convention as `tests/rls/admin.test.ts`). If standing this up in CI proves heavy, drop it and rely on Task 9's manual e2e — note that choice in the PR.

- [ ] **Step 1: Add `otplib` (latest stable)**

Look up the current latest stable on npm, then:
```bash
pnpm add -D otplib@<latest-stable>
```
Expected: `package.json` devDependencies gains `otplib`.

- [ ] **Step 2: Write the live test**

```ts
// tests/rls/mfa.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { generateSync } from "otplib";
import { HAS_SUPABASE_TEST_ENV, makeUser, admin } from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

let user: SupabaseClient;
let userId: string;

describe.skipIf(!HAS_SUPABASE_TEST_ENV)("MFA enroll/verify/reset round-trip", () => {
  beforeAll(async () => {
    user = await makeUser("mfa-user@example.com", "MfaUser-pw-1234!");
    userId = (await user.auth.getUser()).data.user!.id;
  });

  it("enrolls TOTP, verifies a generated code, and reaches aal2", async () => {
    const { data: enroll, error: enrollErr } = await user.auth.mfa.enroll({ factorType: "totp" });
    expect(enrollErr).toBeNull();
    const code = generateSync({ secret: enroll!.totp.secret });
    const { error: verifyErr } = await user.auth.mfa.challengeAndVerify({ factorId: enroll!.id, code });
    expect(verifyErr).toBeNull();

    const { data: aal } = await user.auth.mfa.getAuthenticatorAssuranceLevel();
    expect(aal!.currentLevel).toBe("aal2");
    expect(aal!.nextLevel).toBe("aal2");
  });

  it("service-role admin reset removes every factor", async () => {
    const before = await admin().auth.admin.mfa.listFactors({ userId });
    expect(before.data!.factors.length).toBeGreaterThanOrEqual(1);

    await Promise.all(
      before.data!.factors.map((f) => admin().auth.admin.mfa.deleteFactor({ id: f.id, userId })),
    );

    const after = await admin().auth.admin.mfa.listFactors({ userId });
    expect(after.data!.factors.length).toBe(0);
  });
});
```

**Note:** otplib v13 (the current latest stable) replaced the legacy `authenticator.generate` API with `generateSync({ secret })`. The code above uses the v13 API.

- [ ] **Step 3: Run (with test env) / confirm skip (without)**

Run: `pnpm test mfa`
Expected: with `SUPABASE_TEST_*` set → 2 PASS; without → the suite is skipped (no failure).

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml tests/rls/mfa.test.ts
git commit -m "test: add live MFA enroll/verify/reset integration test"
```

---

## Task 9: Documentation + manual e2e

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the MFA section to the README**

Append after the existing Admin section:

```markdown
## Multi-factor authentication (MFA)

Nutri-Shop uses TOTP (authenticator-app) two-factor auth:

- **Admins must use MFA.** An admin with no factor is sent to `/mfa` to set one up before reaching the app; every session is challenged for a 6-digit code.
- **Members may opt in** from **Account → Two-factor authentication → Enable MFA**, and can disable it there.
- **Lost device?** An admin opens **Admin**, finds the user, and clicks **Reset MFA** — the user sets up a new authenticator on next sign-in.
- **Last admin locked out (break-glass):** if the only admin loses their device, delete that user's rows from `auth.mfa_factors` in the Supabase dashboard (or use the Auth admin UI); they can then re-enroll. With more than one admin, a second admin resets the first.

Enforcement is app-layer (no migration): `requireStepUp()` gates the `(app)` layout, every mutating Server Action, and the food API. Confirm the Supabase project uses **asymmetric JWT signing keys** so the proxy verifies the `aal` claim locally (no per-request network call).
```

- [ ] **Step 2: Commit the docs**

```bash
git add README.md
git commit -m "docs: document MFA (member opt-in, admin mandatory, reset, break-glass)"
```

- [ ] **Step 3: Manual e2e (deployed/preview, per spec §10.3)**

Confirm asymmetric JWT signing keys are enabled in the Supabase dashboard, then walk through:
- [ ] Admin with no factor → login redirects to `/mfa` → scan QR / enter secret → enter code → lands on `/today`; **Admin** link works.
- [ ] Sign out / new session as that admin → `/mfa` **challenge** required before the app loads.
- [ ] Member: **Account → Enable MFA** → enroll → sign out → next sign-in challenges for a code.
- [ ] Member: **Account → Disable MFA** (while stepped up) → reverts to no prompt.
- [ ] Admin **Reset MFA** on a member → member re-enrolls; on another admin → that admin is forced to re-enroll next session.
- [ ] A member who never opted in sees no MFA prompt anywhere.
- [ ] Direct `GET /api/foods?q=egg` with an opted-in member's aal1 session → `403 MFA_REQUIRED`.

---

## Self-Review

**1. Spec coverage:**
- §1/§2 model (admins mandatory, members optional; required-AAL rule) → Task 1 (`mfaRequirement`) + Task 3 (`verifyStepUp`). ✓
- §3 decision function + truth table → Task 1 (test mirrors the table). ✓
- §4 enforcement (`requireStepUp`, `requireAdmin` composition, call sites, proxy unchanged) → Task 3 + Task 4 (proxy is untouched — correct). ✓
- §5 routes/UI (`/mfa`, `/account`, `/admin` reset) → Tasks 5, 6, 7. ✓
- §6 server actions & Supabase API (enroll w/ cleanup, `challengeAndVerify`, QR/CSP, admin reset) → Task 2 (DAL) + Tasks 5/6/7 (wrappers). ✓
- §7 recovery (admin reset + break-glass) → Task 7 + Task 9 (README). ✓
- §8 no migration → confirmed (no SQL task). ✓
- §9 security invariants (service-role only in reset; aal2-to-unenroll; no new public path/CSP) → Task 2 doc comment + Task 6 note + Task 5 (`/mfa` is `requireUser`). ✓
- §10 testing (pure required; live otplib recommended; manual e2e) → Tasks 1, 8, 9. ✓
- §11 interactions/rollout (offline, recovery, asymmetric keys, deps) → Task 9 README + Global Constraints. ✓
- §5.2 "Replace" for admins → intentionally simplified to "reset via /admin" (noted in Task 6) — within scope, removes surface. ✓

**2. Placeholder scan:** No "TBD"/"TODO"/"handle errors"; every code step shows real code. The only deferred value is `otplib`'s exact version (Task 8 Step 1, by the latest-stable rule). ✓

**3. Type consistency:** `AAL`/`MfaRequirement` (Task 1) consumed by Task 3. `EnrollResult`/`OwnMfaStatus` and `enrollTotp`/`verifyTotp`/`disableTotp`/`getOwnMfaStatus`/`resetUserMfa` (Task 2) consumed by Tasks 5/6/7. `verifyStepUp`/`requireStepUp` (Task 3) consumed by Task 4/5. `startEnrollmentAction`/`completeMfaAction` (Task 5) consumed by `EnrollForm`/`ChallengeForm` and reused in Task 6. `disableMfaAction` (Task 6) consumed by `MfaSection`. `resetUserMfaAction` (Task 7) consumed by `AdminView`. `factorId`/`code` param order consistent (`completeMfaAction(factorId, code)`, `verifyTotp(factorId, code)`). ✓
