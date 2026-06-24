# Nutri-Shop — Secure Foundation Design (v1)

**Date:** 2026-06-23
**Author:** NDilbone
**Status:** Approved design — ready for implementation planning
**Scope of this spec:** v1 = the secure, stable, deployable foundation *only*. No product features. Features are layered on afterward per the roadmap at the end.

---

## 1. Summary

Nutri-Shop is a private, invite-only web app for the owner and a small, growing group of trusted users (initially two people; later possibly family) to track calories and macro/micro nutrients and build shopping lists. Despite the name, it is **not** e-commerce — there are no payments.

This spec covers **only the foundation**: a hardened, deployable skeleton with invite-only authentication, database-enforced per-user data isolation, a strict web security baseline, supply-chain/repo hardening for a **public** GitHub repository, and continuous deployment to Vercel. The app will compile, deploy, and let an invited user log in to an empty authenticated dashboard — proving the full security path end-to-end — but it ships **no tracker or shopping-list features**. Those are deferred to the roadmap.

The driving requirement is **security and stability before features**. The owner self-describes as a vibe-coder, so every decision favors the safest managed path with the fewest ways to get security wrong.

---

## 2. Goals & non-goals

### Goals (v1)
- Invite-only authentication (no public self-signup), email + password.
- **Per-user data isolation enforced at the database** via Postgres Row Level Security (RLS), so an application-code bug cannot leak one user's data to another.
- A strict, modern web security baseline (CSP, security headers, secret hygiene, input validation, rate limiting).
- A **public** GitHub repository that is safe by design: no secret depends on code being private.
- Reproducible CI/CD that proves isolation on every change and deploys automatically.
- A foundation explicitly shaped to carry the planned features without re-architecting.

### Non-goals (v1 — deferred to roadmap)
- USDA food search / nutrient lookup (the secret + proxy boundary is reserved, not implemented).
- Macro/micro tracking, logging, daily totals.
- Shopping list (online or offline).
- PWA install / offline sync.
- In-app invite management UI, MFA/2FA, advanced leak backstops.
- Custom domain (a free `*.vercel.app` URL is used initially).

---

## 3. Stack & pinned versions

All versions verified against authoritative sources of truth (npm registry `dist-tags.latest`, nodejs.org release lifecycle) on 2026-06-23. No pre-releases. Pin exactly; keep current via Dependabot.

| Component | Version | Notes |
|---|---|---|
| Node.js | 24 LTS (`24.17.0`) | Active LTS; `engines: ">=24"`. Ships npm 11. |
| pnpm | `11.9.0` | Pinned via `packageManager` (corepack). |
| Next.js | `16.2.9` | App Router. Async request APIs (`cookies()`, `headers()`, `params`, `searchParams` are awaited). Turbopack default. Verify against GitHub security advisories before pinning — stay on latest stable patch. |
| React / react-dom | `19.2.7` | Must match exactly. Mandated by Next 16. |
| TypeScript | `6.0.3` | Strict mode. v6 dropped deprecated flags — verify `tsconfig`. |
| Tailwind CSS | `4.3.1` | CSS-first: `@import "tailwindcss"` + `@theme {}` in CSS, `@tailwindcss/postcss` plugin. **No `tailwind.config.js`.** |
| @supabase/supabase-js | `2.108.2` | Stable v2. |
| @supabase/ssr | `0.12.0` | SSR/cookie helper for App Router. **Pre-1.0 — pin exactly, watch 0.x bumps.** Replaces deprecated `@supabase/auth-helpers-nextjs`. |
| zod | `4.4.3` | v4 API: `z.email()` top-level, `error` over `message`. |
| eslint | `10.5.0` | Flat config only (`eslint.config.js`). Use `eslint-config-next` flat config. |
| server-only | latest stable | Verify on npm at install. Build-time guard against client imports of secret modules. |

**Reserved for later phases (not installed in v1):** `@serwist/next` + `serwist` `9.5.11` (PWA), `dexie` `4.4.4` (offline IndexedDB).

**Host:** Vercel **Hobby ($0, non-commercial — fits private family use)**. One-click upgrade to **Pro ($20/member/mo)** later when desired — no migration, no redeploy, same project/URL/env vars. App remains portable (Netlify free is an equal-footing fallback; Cloudflare is avoided because its Next.js Server Components / middleware support is only partial and would break this design).

---

## 4. Architecture & security model

The system is three managed services with a single, layered request path:

```
GitHub (public repo)  ──Vercel watches──►  Vercel (builds + runs the app)  ──►  Supabase (Postgres + Auth)
```

Every request to a protected resource passes through **four independent gates** (defense in depth). No single bug opens the door:

```
Browser
  │  httpOnly session cookie (JavaScript cannot read it → XSS cannot steal it)
  ▼
proxy.ts ─────────── Gate 1: optimistic redirect (no session cookie → /login);
  │                          also sets the per-request nonce-based CSP here
  ▼
Page / Server Action / Route Handler
  │
  ▼
server-only Data Access Layer (DAL) ── Gate 2: verify session (getUser — network-validated)
  │                                     Gate 3: verify ownership (caller owns this row?)
  │                                     (the ONLY place process.env secrets are read)
  ▼
Supabase Postgres ── Gate 4: Row Level Security — the database itself refuses
                             to return another user's rows
```

- **Gate 1 (`proxy.ts`)** is fast but bypassable, so it is **never** the sole gate.
- **Gates 2–3 (DAL)** are the real application-level authentication + authorization checks, re-run inside **every** page, Server Action, and Route Handler.
- **Gate 4 (RLS)** is the backstop that makes the core requirement literally true: even if Gates 1–3 all have bugs, Postgres will not hand one user another user's data.

### Key structural decisions
- **`proxy.ts`, not `middleware.ts`.** Next.js 16 renamed the file; a leftover `middleware.ts` is **silently ignored** (routes look protected but are wide open). Use `proxy.ts` and verify it executes. No database calls in `proxy.ts` (it runs on every route, including prefetches).
- **Server-only Data Access Layer** (`lib/dal/`, marked `import 'server-only'`): a `cache()`-memoized `verifySession()` reads the `@supabase/ssr` cookie and validates via `supabase.auth.getUser()` (network-validated, not just `getSession()`). All `process.env` secret access is confined here. A client import of this module is a build error.
- **No secret behind `NEXT_PUBLIC_`.** That prefix inlines the value into the browser bundle permanently (rotating later does not un-leak shipped builds). Only `NEXT_PUBLIC_SUPABASE_URL` and the Supabase anon/publishable key are public — and the anon key is harmless because RLS gates everything it can do.
- **`@supabase/ssr` clients** created per-request (never module-scoped): `createServerClient` for Server Components/Actions/Route Handlers, `createBrowserClient` for Client Components. Cookies: `httpOnly`, `secure`, `sameSite=lax`, `path=/`.

### Security baseline (ships in v1)
- **RLS enabled on every user-data table**, default-deny, policies keyed to `auth.uid()` for select/insert/update/delete. Verified by a CI test that attempts a cross-user read with a non-owner session and fails the build if it succeeds.
- **Layered auth/authz:** optimistic redirect in `proxy.ts`; real re-verification in the DAL on every entry point; ownership checked (not just login) to prevent IDOR.
- **Server Actions treated as public POST endpoints:** each independently re-runs auth + authz + Zod validation and returns narrow DTOs (never raw DB rows). Rely on Next.js built-in Server Action CSRF (POST-only + Origin/Host comparison + SameSite cookies); never mutate as a side effect of a GET render.
- **Strict nonce-based CSP** in `proxy.ts`: `default-src 'self'; script-src 'self' 'nonce-…' 'strict-dynamic' (+ 'unsafe-eval' dev-only); style-src 'self' 'nonce-…'; img-src 'self' blob: data:; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests`. `connect-src` includes the Supabase project URL. The proxy matcher skips `api`, `_next/static`, `_next/image`, `favicon`, and prefetches. (Accepted tradeoff: nonce CSP forces dynamic rendering on matched routes — acceptable for an authenticated app shell.)
- **Static OWASP headers** in `next.config` via `headers()` for `/(.*)`: HSTS `max-age=63072000; includeSubDomains; preload` (enable `preload` only once all subdomains are HTTPS), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, `Permissions-Policy` with empty allowlists (`camera=()`, `microphone=()`, `geolocation=()`, `payment=()`, `usb=()`). CSP stays only in `proxy.ts` (per-request nonce) — not duplicated here.
- **Secret hygiene:** secrets only in local `.env` (gitignored) and Vercel encrypted env settings; accessed only in the DAL; secret-touching modules marked `import 'server-only'`.
- **Boundary validation** with Zod `safeParse` on all client-controlled input (formData, searchParams, route params, JSON bodies, headers). Never derive privilege from client input — re-derive from the verified session.
- **Rate limiting** on auth endpoints (login / signup / password reset) — per-IP **and** per-account (Vercel counters are per-region, so an account-level key is required to actually stop credential stuffing). Implemented via Vercel WAF + `@vercel/firewall`, and/or Supabase Auth's built-in rate limits.

---

## 5. Authentication & invite-only flow

**Method:** email + password via Supabase Auth. Supabase hashes passwords (bcrypt) server-side — no custom crypto, no raw-password storage. Session stored in an httpOnly cookie via `@supabase/ssr`.

**Password hardening (configuration, not custom code):**
- Leaked-password protection (HaveIBeenPwned check) enabled in Supabase Auth.
- Minimum length/strength enforced in Supabase Auth settings.
- Email confirmation required before an account is active.
- Rate-limited login / signup / reset (per-IP + per-account).
- Secure emailed password-reset link flow (built in).
- MFA/2FA (TOTP) supported by Supabase — **deferred** to roadmap Phase 6.

**Invite-only (public self-signup disabled):**

```
Registration attempt
        │
        ▼
Is the email in the `invites` allowlist?  ◄── enforced SERVER-SIDE in Postgres
        │                                      (SECURITY DEFINER trigger / pre-signup
   no ──┴── yes                                 check — NOT client code; cannot be
   │         │                                  bypassed via direct API calls)
   ▼         ▼
 REJECTED   Account created → profile row auto-created by trigger
```

- **Inviting a user (v1):** the owner adds the email to the `invites` table directly in the Supabase dashboard. No UI to build for v1.
- **Inviting a user (later):** small in-app admin screen — deferred to Phase 6.
- The allowlist check runs in the database. Even an attacker reading the public code and calling the signup API directly is rejected if their email is not pre-invited.

**Auth routes (v1):** `/login`, invite-gated `/signup`, `/auth/callback` (Route Handler exchanging the code and setting the session cookie), `/auth/signout`, password reset.

---

## 6. Data model & Row Level Security

v1 ships two tables; both establish the pattern every future table copies.

| Table | Purpose | RLS |
|---|---|---|
| `profiles` | One row per user (id references `auth.users`; display name + settings later). Auto-created by a `handle_new_user` trigger on signup. | Read/update **own row only** (`auth.uid() = id`). |
| `invites` | Email allowlist gating signup. | Locked to server/admin; no end-user access. |

**Policy shape (every user-data table):**

```sql
alter table profiles enable row level security;

create policy "own profile read"
  on profiles for select
  using ( auth.uid() = id );

create policy "own profile update"
  on profiles for update
  using ( auth.uid() = id );
```

`auth.uid()` is the logged-in user's id (from the Supabase JWT), compared to the row owner on every query. **Default-deny:** with RLS enabled, anything without an explicit allowing policy is denied — forgetting a policy locks a table rather than leaking it.

**Forward-compat convention (set now, applied when feature tables are added in later phases):** every future user-data table (`logged_foods`, `shopping_list_items`, …) gets a `user_id` column + the four `auth.uid()`-keyed policies, **plus**:
- **client-generated UUID** primary keys (an offline device can mint ids without the server),
- **`updated_at`** on every row (last-write-wins sync),
- **`deleted_at`** soft-delete (deletions sync rather than vanish).

Deciding these now is free; retrofitting them after data exists is a painful migration. This is the single piece of forward-design baked into the foundation.

**Migrations:** versioned SQL in `supabase/migrations/`, committed to the repo (schema is not secret). Reproducible and reviewable.

**Isolation guarantee test:** a CI test logs in as User A, attempts to read User B's `profiles` row, and **fails the build if it succeeds** — so RLS cannot silently regress as the app grows.

---

## 7. Repository hardening, secrets & CI/CD (public GitHub)

**Secret handling (enforced mechanically):**
- `.gitignore` blocks all `.env*` files from the first commit.
- `.env.example` ships placeholders only (e.g. `FDC_API_KEY=your-key-here`).
- Real secrets live only in local `.env` + Vercel encrypted env settings; read only in the server-only DAL; `import 'server-only'` makes a client import a build error.

**GitHub hardening (free on public repos):**
- Secret scanning + **push protection** (blocks a push containing a key).
- CodeQL code scanning on every PR.
- Dependabot (version + security updates; keeps deps on latest stable).
- Branch protection on `main` (no direct pushes; PR must pass CI).
- GitHub Actions pinned to commit SHAs; least-privilege `permissions:`.
- Committed `pnpm-lock.yaml`; exact pinned versions; corepack-pinned package manager.

**CI pipeline (GitHub Actions, every PR):**

```
push / PR → lint (ESLint 10) → typecheck (tsc) → build → tests
                                                            │
                                       includes the RLS isolation test
                                                            │
                          all green → Vercel deploys: PR → preview URL · main → production
```

Vercel's GitHub integration handles deploys (preview per PR, production on `main`).

**Project files:** `README.md` (setup + run), `LICENSE`, `SECURITY.md` (vulnerability-reporting policy).

**Accepted caveat:** on the free Hobby tier, preview URLs are publicly reachable (Vercel preview password-protection is a Pro feature). Acceptable because invite-only auth gates the app itself — a discovered preview URL still hits the login wall. Lockable at the edge later via Pro.

---

## 8. v1 deliverable & roadmap

**v1 foundation ships (complete, deployable, secure, featureless):**
- Next.js 16 App Router project (pnpm, TS 6 strict, Tailwind 4, ESLint 10 flat).
- Supabase project: `profiles` + `invites`, RLS enabled, `handle_new_user` trigger, migrations in repo.
- Email + password auth: invite-only (server-enforced), email confirmation, leaked-password protection, rate-limited.
- `@supabase/ssr` cookie clients; httpOnly sessions.
- `proxy.ts`: nonce CSP + optimistic redirects.
- Server-only DAL: session verify + ownership checks + sole secret access.
- `next.config`: OWASP static headers.
- Zod boundary validation harness.
- Auth routes: `/login`, invite-gated `/signup`, `/auth/callback`, `/auth/signout`, password reset.
- One authenticated dashboard page — empty, but proves login → DAL → RLS end-to-end.
- USDA secret slot reserved: `FDC_API_KEY` env + stubbed `/api/foods` proxy boundary (no calls).
- Repo hardening + CI (incl. RLS isolation test).
- Deployed on Vercel Hobby.

**Roadmap (foundation is built to carry these; each is its own spec → plan → implementation cycle):**

| Phase | Feature |
|---|---|
| 1 | USDA food search + nutrient detail (wire the stubbed proxy; real FDC key; two-layer cache; rate-limit handling). |
| 2 | Macro/micro tracker — `logged_foods` table (+RLS), Server Actions to log, daily totals, stable internal nutrient model. |
| 3 | Shopping list (online) — `shopping_list_items` table (+RLS); applies the UUID + `updated_at` + `deleted_at` + idempotent-upsert convention. |
| 4 | PWA install — `@serwist/next` + manifest; SW kept out of auth/REST caching. |
| 5 | Offline shopping list + sync — Dexie local store + outbox; flush on `online`/focus as primary trigger; last-write-wins. |
| 6 | Hardening/polish — in-app invite admin UI, MFA/2FA, React taint backstop, observability. |

---

## 9. Top risks & mitigations

| Risk | Mitigation |
|---|---|
| Leftover/misnamed `middleware.ts` silently ignored in Next 16 → route protection inactive. | Use `proxy.ts`; verify it executes; never make it the sole gate (DAL + RLS behind it). |
| RLS misconfig (forgot to enable, too-permissive policy, service-role key in a request path) bypasses isolation. | Default-deny; per-table policies; CI cross-user-read test; service-role key never in request path (DAL only, server-side). |
| Secret leak via `NEXT_PUBLIC_` or a committed key (USDA keys are auto-deactivated if public). | Server-only DAL + `import 'server-only'` + `.gitignore` + push protection from day one. |
| IDOR — checking login but not ownership in a Server Action. | Re-check `row.user_id === session.userId` in the DAL; RLS as backstop. |
| Pre-1.0 `@supabase/ssr` (0.12.0) + many recent majors (Next 16 / React 19 / TS 6 / Tailwind 4 / ESLint 10 / Zod 4) — breaking upgrades can break the auth cookie path. | Pin exactly; use official codemods; Dependabot PRs reviewed, not auto-merged; verify Next security advisories before bumping. |
| Per-IP-only rate limits bypassable (Vercel counters per-region). | Add per-account limits on auth endpoints. |
| Strict nonce CSP disables static optimization / can block Supabase fetches via `connect-src`. | Scope the matcher; include Supabase URL in `connect-src`; acceptable for an authenticated shell. |
| Offline forward-compat debt (later phases) — server-assigned int ids / non-idempotent writes / caching authed responses in the SW. | Decide client-UUID + `updated_at` + `deleted_at` + upsert at the shopping-list schema stage; keep SW out of auth/REST caching. |

---

## 10. Success criteria (v1 is done when…)

1. An invited user can register (email + password), confirm email, and log in; an **un-invited** email is rejected even via a direct API call.
2. After login, the authenticated dashboard renders only via the DAL session check; logout clears the session.
3. The CI cross-user-read test passes (User A cannot read User B's row) — proving RLS isolation.
4. No secret is present anywhere in the public repo or the client bundle; push protection + secret scanning are active.
5. CSP + OWASP headers are present on responses (verifiable in browser dev tools / a headers scan).
6. CI (lint, typecheck, build, tests) is green and the app is deployed to a live Vercel Hobby URL.
7. No product features exist yet — scope held to the foundation.
