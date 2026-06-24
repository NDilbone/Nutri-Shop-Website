# Nutri-Shop Secure Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a hardened, deployable Next.js 16 + Supabase skeleton with invite-only auth and database-enforced per-user isolation — secure and stable, with zero product features.

**Architecture:** Next.js 16 App Router on Vercel; Supabase (Postgres + Auth) as the backend. Four-gate defense in depth: `proxy.ts` (optimistic redirect + nonce CSP) → server-only Data Access Layer (session + ownership) → Postgres Row Level Security (the backstop). Secrets live only in a server-only DAL; the public repo is safe by design.

**Tech Stack:** Next.js 16.2.9, React 19.2.7, TypeScript 6.0.3, Tailwind CSS 4.3.1, `@supabase/supabase-js` 2.108.2, `@supabase/ssr` 0.12.0, Zod 4.4.3, ESLint 10.5.0, Vitest + `vite-tsconfig-paths` (latest stable — verify at install), pnpm 11.9.0, Node 24 LTS, Supabase CLI (latest stable — verify at install).

## Global Constraints

- **Authorship:** All artifacts authored by RegEdits. **No** `Co-Authored-By: Claude`, no "Generated with Claude" / AI-attribution anywhere in commits, code, docs, or PRs. Use the existing git config; never set identity to Claude. Branch names must not reference Claude/AI.
- **Versions — exact pins, latest stable:** Node `>=24` (24.17.0), pnpm `11.9.0` (via `packageManager`), `next@16.2.9`, `react@19.2.7`, `react-dom@19.2.7`, `typescript@6.0.3`, `tailwindcss@4.3.1`, `@supabase/supabase-js@2.108.2`, `@supabase/ssr@0.12.0`, `zod@4.4.3`, `eslint@10.5.0`. Re-verify each as latest non-prerelease on npm before installing; skip alphas/betas/RCs/canaries.
- **Secrets:** No secret behind `NEXT_PUBLIC_` (build-time inlined → permanently public). Only `NEXT_PUBLIC_SUPABASE_URL`, the Supabase anon/publishable key, and `NEXT_PUBLIC_SITE_URL` are public. Service-role key, `FDC_API_KEY`, session secrets are server-only, read only in `lib/` (never `app/`), in modules marked `import 'server-only'`. `.env*` is gitignored from the first commit.
- **Auth method:** Email + password via Supabase Auth. Invite-only — public self-signup disabled; the allowlist check is enforced server-side in Postgres (a trigger), never client code.
- **Next.js 16 specifics:** the request-gating file is `proxy.ts` (NOT `middleware.ts` — a leftover `middleware.ts` is silently ignored), exporting `function proxy(request)` + a `config` matcher. `cookies()`, `headers()`, `params`, `searchParams` are async and must be awaited. The CSP nonce must be set on the **request** headers (Next reads it there to stamp scripts); nonce auto-injection only happens on **dynamically** rendered routes.
- **RLS:** every user-data table has RLS enabled, default-deny, policies keyed to `auth.uid()`. CI tests must prove cross-user reads/writes fail AND that the invite-gate blocks non-invited signups.
- **TDD:** write the failing test first, watch it fail, implement minimally, watch it pass, commit. Frequent commits. DRY. YAGNI.
- **Scope:** foundation only. No tracker, no shopping list, no PWA. Do not add product features.

---

## File Structure

**Created in this plan:**

```
package.json                          # deps, scripts, engines, packageManager
pnpm-lock.yaml                        # committed lockfile
tsconfig.json                         # strict
next.config.ts                        # static OWASP security headers
eslint.config.js                      # ESLint 10 flat config (+ server-env import guard)
postcss.config.mjs                    # @tailwindcss/postcss
vitest.config.ts                      # test runner + '@/' alias via vite-tsconfig-paths
.gitignore                            # blocks .env*, node_modules, .next, .remember
.env.example                          # placeholders only
.nvmrc                                # 24
README.md  LICENSE  SECURITY.md
proxy.ts                              # Gate 1: optimistic redirect + nonce CSP (request-header nonce)
app/globals.css                       # Tailwind v4 CSS-first
app/layout.tsx                        # root layout (stays dynamic so Next stamps the nonce)
app/page.tsx                          # routes by auth state
app/login/page.tsx                    # email+password login form
app/signup/page.tsx                   # invite-gated signup form
app/dashboard/page.tsx                # authenticated shell (proves the path)
app/auth/confirm/route.ts             # email confirm / reset: verifyOtp(token_hash,type)
app/auth/signout/route.ts             # sign out
app/auth/actions.ts                   # 'use server' auth actions (login/signup/reset)
app/api/foods/route.ts                # stubbed USDA proxy boundary (501)
lib/env.ts                            # server-only zod-validated env
lib/supabase/server.ts                # createServerClient (per-request)
lib/supabase/client.ts                # createBrowserClient
lib/supabase/proxy-session.ts         # updateSession helper for proxy.ts (getClaims)
lib/dal/session.ts                    # Gate 2/3: verifySession (getUser), requireUser, ownership
lib/validation/auth.ts                # zod schemas for auth inputs
supabase/config.toml                  # supabase CLI local config (+ email templates)
supabase/migrations/0001_init.sql     # profiles, invites, RLS, triggers, grants
tests/rls/helpers.ts                  # fail-closed test-user factory
tests/rls/isolation.test.ts           # cross-user read/write/insert MUST fail (the guardrail)
tests/auth/invite-gate.test.ts        # non-invited signup MUST fail; invited succeeds
tests/dal/session.test.ts             # DAL unit tests
tests/validation/auth.test.ts         # zod schema tests
.github/workflows/ci.yml              # lint, typecheck, build, test (+ supabase local) + bundle guard
.github/dependabot.yml                # weekly dep + actions updates
.github/workflows/codeql.yml          # code scanning
```

**Responsibilities:** `lib/dal/` is the only secret-reading boundary for app data; `lib/` (never `app/`) reads server-only env. `lib/supabase/` holds the three client factories. `lib/validation/` holds Zod schemas. `app/auth/` holds the auth surface. `supabase/migrations/` is the schema source of truth.

---

## Task 1: Project scaffold (Next 16 + TS strict + Tailwind 4 + ESLint flat + Vitest)

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `eslint.config.js`, `postcss.config.mjs`, `app/globals.css`, `app/layout.tsx`, `app/page.tsx`, `.nvmrc`, `vitest.config.ts`, `tests/smoke.test.ts`

**Interfaces:**
- Produces: a building Next app; `pnpm dev`, `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test` scripts; working `@/` import alias in tests.

- [ ] **Step 1: Verify latest stable versions before pinning**

Run:
```bash
npm view next version; npm view react version; npm view typescript version; npm view tailwindcss version; npm view @tailwindcss/postcss version; npm view eslint version; npm view eslint-config-next version; npm view vitest version; npm view vite-tsconfig-paths version
```
Expected: prints versions. Use these exact values (must match or exceed the pins in Global Constraints; if a newer stable exists, use it and note the bump).

- [ ] **Step 2: Enable the pinned package manager**

Run:
```bash
corepack enable
corepack prepare pnpm@11.9.0 --activate
node -v
```
Expected: Node prints `v24.x`. If not, install Node 24 LTS first.

- [ ] **Step 3: Create `package.json`**

```json
{
  "name": "nutri-shop-website",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "packageManager": "pnpm@11.9.0",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "next": "16.2.9",
    "react": "19.2.7",
    "react-dom": "19.2.7",
    "@supabase/supabase-js": "2.108.2",
    "@supabase/ssr": "0.12.0",
    "zod": "4.4.3",
    "server-only": "latest"
  },
  "devDependencies": {
    "typescript": "6.0.3",
    "@types/node": "latest",
    "@types/react": "latest",
    "@types/react-dom": "latest",
    "tailwindcss": "4.3.1",
    "@tailwindcss/postcss": "4.3.1",
    "eslint": "10.5.0",
    "eslint-config-next": "16.2.9",
    "vitest": "latest",
    "vite-tsconfig-paths": "latest"
  }
}
```
Note: replace each `"latest"` with the exact version printed in Step 1 before committing the lockfile. (`vite-tsconfig-paths` makes Vitest honor the `@/` alias from `tsconfig.json` — without it every `@/...` test import fails to resolve.)

- [ ] **Step 4: Install**

Run: `pnpm install`
Expected: creates `pnpm-lock.yaml`, no peer-dependency errors. If React peer errors appear, confirm react/react-dom are both `19.2.7`.

- [ ] **Step 5: Create `tsconfig.json` (strict)**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "ES2022"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 6: Create config files**

`postcss.config.mjs`:
```js
const config = { plugins: { "@tailwindcss/postcss": {} } };
export default config;
```

`app/globals.css` (Tailwind v4 CSS-first — no `tailwind.config.js`):
```css
@import "tailwindcss";

@theme {
  --color-brand: #16a34a;
}
```

`eslint.config.js` (ESLint 10 flat — the documented v16 form: core-web-vitals + typescript, plus a guard keeping server-only env out of `app/`):
```js
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default [
  ...nextVitals,
  ...nextTs,
  {
    files: ["app/**/*.{ts,tsx}"],
    rules: {
      // Server-only env (incl. the service-role key) is read in lib/, never app/.
      "no-restricted-imports": [
        "error",
        { paths: [{ name: "@/lib/env", message: "Read server-only env in lib/, not app/." }] },
      ],
    },
  },
  { ignores: [".next/", "node_modules/", "supabase/.branches/"] },
];
```
Note: if `eslint-config-next/core-web-vitals` or `/typescript` subpath imports error on the installed version, run `npm view eslint-config-next exports` and adjust to the exported flat-config entry points.

`next.config.ts` (headers added in Task 8 — minimal for now):
```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
```

`.nvmrc`:
```
24
```

- [ ] **Step 7: Create the minimal app shell**

`app/layout.tsx` (final form — reading `headers()` keeps the route dynamic so Next stamps the CSP nonce; see Task 7):
```tsx
import "./globals.css";
import type { ReactNode } from "react";
import { headers } from "next/headers";

export const metadata = { title: "Nutri-Shop", description: "Private nutrition tracker" };

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Reading a request-time API keeps this layout dynamic so Next.js injects the
  // CSP nonce (set on the request header in proxy.ts) onto its own scripts.
  await headers();
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

`app/page.tsx` (temporary; replaced in Task 10):
```tsx
export default function Home() {
  return <main style={{ padding: 24 }}>Nutri-Shop foundation.</main>;
}
```

- [ ] **Step 8: Create the test runner config with `@/` alias resolution**

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()], // makes '@/...' imports resolve in tests
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
```

`tests/smoke.test.ts`:
```ts
import { describe, it, expect } from "vitest";

describe("smoke", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 9: Verify build, lint, typecheck, test all pass**

Run:
```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```
Expected: typecheck clean, lint clean, 1 test passes, build succeeds (`.next/` produced).

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js 16 app with TypeScript, Tailwind 4, ESLint, Vitest"
```

---

## Task 2: Repo hygiene, secret boundary & project docs

**Files:**
- Create: `.gitignore`, `.env.example`, `README.md`, `LICENSE`, `SECURITY.md`

**Interfaces:**
- Produces: the secret boundary (`.env*` ignored) and the documented env var names every later task references: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `FDC_API_KEY`.

- [ ] **Step 1: Create `.gitignore`**

```gitignore
# deps
node_modules/
.pnpm-store/

# next
.next/
out/
next-env.d.ts

# env — never commit secrets
.env
.env.*
!.env.example

# supabase local
supabase/.branches/
supabase/.temp/

# misc
.DS_Store
*.log
.remember/
```

- [ ] **Step 2: Create `.env.example` (placeholders only)**

```dotenv
# Supabase — public values (safe in the browser; anon key is RLS-gated)
NEXT_PUBLIC_SUPABASE_URL=https://YOUR-PROJECT-ref.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-or-publishable-key

# Public site origin used to build auth email links (NOT derived from request Origin)
NEXT_PUBLIC_SITE_URL=http://localhost:3000

# Supabase — SERVER ONLY. Never expose. Never prefix with NEXT_PUBLIC_.
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# USDA FoodData Central — SERVER ONLY (reserved for a later phase; unused in v1)
FDC_API_KEY=your-fdc-key-here
```
Note: this project uses the Supabase **anon** key naming. Supabase is migrating to publishable keys (`sb_publishable_…`) and deprecating legacy JWT anon keys by end of 2026 — if you start fresh after that, swap `NEXT_PUBLIC_SUPABASE_ANON_KEY` for `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` across the client/server/proxy factories, `.env.example`, CI, and Vercel.

- [ ] **Step 3: Verify `.env` cannot be committed**

Run:
```bash
printf 'SECRET=should-not-commit\n' > .env
git add .env 2>&1 || true
git status --porcelain .env
```
Expected: `git status` shows **nothing** for `.env` (it is ignored). Then: `rm .env`.

- [ ] **Step 4: Create `README.md`**

````markdown
# Nutri-Shop

Private, invite-only nutrition tracker and shopping-list app. Not e-commerce; no payments.

## Stack
Next.js 16 (App Router) · Supabase (Postgres + Auth, Row Level Security) · TypeScript · Tailwind 4 · Vercel.

## Local setup
1. Install Node 24 LTS and enable pnpm: `corepack enable && corepack prepare pnpm@11.9.0 --activate`
2. `pnpm install`
3. Copy env: `cp .env.example .env` and fill in values from your Supabase project (Settings → API). Set `NEXT_PUBLIC_SITE_URL` to your origin (e.g. `http://localhost:3000` locally).
4. Start Supabase locally (for tests): `supabase start`
5. `pnpm dev` → http://localhost:3000

## Scripts
- `pnpm dev` / `pnpm build` / `pnpm start`
- `pnpm lint` · `pnpm typecheck` · `pnpm test`

## Security
Secrets live only in `.env` (gitignored) and Vercel env settings — never in the repo. Auth email links are built from `NEXT_PUBLIC_SITE_URL` (a trusted constant), and Supabase's redirect allowlist must list only your real origins (no wildcards). See `SECURITY.md`.
````

- [ ] **Step 5: Create `LICENSE` and `SECURITY.md`**

`LICENSE` — MIT, attributed to RegEdits (verify the current year):
```
MIT License

Copyright (c) 2026 RegEdits

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

`SECURITY.md`:
```markdown
# Security Policy

## Reporting a vulnerability
Email security reports privately to the repository owner. Do not open a public
issue for security problems. You will receive an acknowledgement within a few days.

## Scope
This is a private application. Secrets are never committed; the public anon key is
gated by Postgres Row Level Security. Report any case where one user's data is
reachable by another, or where a secret appears in the repo or client bundle.
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: add gitignore, env example, README, LICENSE, security policy"
```

---

## Task 3: Server-only env validation & Supabase client factories

**Files:**
- Create: `lib/env.ts`, `lib/supabase/server.ts`, `lib/supabase/client.ts`
- Test: `tests/env.test.ts`

**Interfaces:**
- Produces:
  - `lib/env.ts` → `serverEnv` (`SUPABASE_SERVICE_ROLE_KEY: string`, `FDC_API_KEY: string | undefined`) and `publicEnv` (`NEXT_PUBLIC_SUPABASE_URL: string`, `NEXT_PUBLIC_SUPABASE_ANON_KEY: string`), plus exported `parsePublicEnv` / `parseServerEnv`. `lib/env.ts` is `import 'server-only'`.
  - `lib/supabase/server.ts` → `async function createClient()` returning a per-request `SupabaseClient`.
  - `lib/supabase/client.ts` → `function createClient()` returning a browser `SupabaseClient`.

- [ ] **Step 1: Write the failing test for public env parsing**

`tests/env.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parsePublicEnv } from "@/lib/env";

describe("parsePublicEnv", () => {
  it("accepts a valid URL and key", () => {
    const env = parsePublicEnv({
      NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
    });
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe("https://abc.supabase.co");
  });

  it("throws on a missing key", () => {
    expect(() =>
      parsePublicEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co" }),
    ).toThrow();
  });

  it("throws on a non-URL", () => {
    expect(() =>
      parsePublicEnv({ NEXT_PUBLIC_SUPABASE_URL: "not-a-url", NEXT_PUBLIC_SUPABASE_ANON_KEY: "k" }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `pnpm test tests/env.test.ts`
Expected: FAIL — `parsePublicEnv` is not exported (resolves via the `@/` alias; if it instead errors "cannot resolve @/lib/env", the Task 1 Step 8 alias config is missing).

- [ ] **Step 3: Implement `lib/env.ts`**

```ts
import "server-only";
import { z } from "zod";

const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
});

const serverSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  FDC_API_KEY: z.string().min(1).optional(),
});

export function parsePublicEnv(raw: Record<string, string | undefined>) {
  return publicSchema.parse(raw);
}

export function parseServerEnv(raw: Record<string, string | undefined>) {
  return serverSchema.parse(raw);
}

export const publicEnv = parsePublicEnv({
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
});

export const serverEnv = parseServerEnv({
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  FDC_API_KEY: process.env.FDC_API_KEY,
});
```
Note: `z.url()` is Zod 4 syntax (top-level string formats). If the installed Zod rejects it, use `z.string().url()`.

- [ ] **Step 4: Run the test; verify it passes**

Run: `pnpm test tests/env.test.ts`
Expected: PASS (3 tests). The module-level `publicEnv`/`serverEnv` are not exercised by the unit test (it imports only `parsePublicEnv`). Confirm no import-time crash with dummy env:
```bash
NEXT_PUBLIC_SUPABASE_URL=https://x.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=k SUPABASE_SERVICE_ROLE_KEY=s pnpm test tests/env.test.ts
```

- [ ] **Step 5: Implement the browser client `lib/supabase/client.ts`**

```ts
import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
```

- [ ] **Step 6: Implement the server client `lib/supabase/server.ts`**

```ts
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        // The optional second arg (cache-control headers, @supabase/ssr ≥0.10) is
        // not actionable inside a Server Component render — accept and ignore it.
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // called from a Server Component render — safe to ignore;
            // proxy.ts refreshes the session cookie.
          }
        },
      },
    },
  );
}
```

- [ ] **Step 7: Typecheck and commit**

Run: `pnpm typecheck`
Expected: clean.
```bash
git add -A
git commit -m "feat: add zod-validated server-only env and Supabase client factories"
```

---

## Task 4: Database schema, RLS policies & invite-gate trigger

**Files:**
- Create: `supabase/config.toml`, `supabase/migrations/0001_init.sql`

**Interfaces:**
- Produces: tables `public.profiles(id uuid pk, display_name text, created_at timestamptz)` and `public.invites(email text pk, invited_at timestamptz)`; a `handle_new_user` trigger; a `gate_signup_by_invite` trigger that rejects non-invited signups; grants letting the auth admin role read `invites`. Consumed by Task 5 (isolation test) and Task 9 (signup).

- [ ] **Step 1: Initialize the Supabase CLI project**

Run:
```bash
supabase --version   # verify installed; if missing, install the latest stable CLI
supabase init        # creates supabase/config.toml (accept defaults)
```
Expected: `supabase/config.toml` created.

- [ ] **Step 2: Create the migration `supabase/migrations/0001_init.sql`**

```sql
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
```
Note on `(select auth.uid())`: wrapping in a sub-select lets Postgres cache the value per statement (Supabase's documented RLS performance pattern). Behavior is identical to bare `auth.uid()`.

- [ ] **Step 3: Apply locally and verify it loads**

Run:
```bash
supabase start
supabase db reset    # applies migrations to the local stack
```
Expected: migration applies with no SQL error; `supabase start` prints the local API URL + anon + service_role keys + the Inbucket (email) URL.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add profiles/invites schema, RLS policies, and invite-gate trigger"
```
(The non-invited-signup rejection is proven by an automated test in Task 5, not a manual check.)

---

## Task 5: RLS isolation + invite-gate tests (the security guardrails)

**Files:**
- Create: `tests/rls/helpers.ts`, `tests/rls/isolation.test.ts`, `tests/auth/invite-gate.test.ts`

**Interfaces:**
- Consumes: local Supabase API URL + anon key + service-role key from env (`SUPABASE_TEST_URL`, `SUPABASE_TEST_ANON_KEY`, `SUPABASE_TEST_SERVICE_ROLE_KEY`).
- Produces: `admin()` and `makeUser(email, password)` from `tests/rls/helpers.ts`; tests that fail the build if cross-user access works or the invite gate is bypassable.

- [ ] **Step 1: Write the fail-closed helper**

`tests/rls/helpers.ts`:
```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required test env: ${name}`); // fail closed
  return v;
}

const url = reqEnv("SUPABASE_TEST_URL");
const anon = reqEnv("SUPABASE_TEST_ANON_KEY");
const service = reqEnv("SUPABASE_TEST_SERVICE_ROLE_KEY");

export function anonClient(): SupabaseClient {
  return createClient(url, anon, { auth: { persistSession: false } });
}

export function admin(): SupabaseClient {
  return createClient(url, service, { auth: { persistSession: false } });
}

/** Invite + create a confirmed user, then return an anon client signed in as them. */
export async function makeUser(email: string, password: string): Promise<SupabaseClient> {
  const a = admin();
  await a.from("invites").upsert({ email }); // allowlist so the gate permits creation
  const { error: createErr } = await a.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // admin API creates a pre-confirmed user
  });
  if (createErr && !/already.*registered/i.test(createErr.message)) throw createErr;

  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}
```

- [ ] **Step 2: Write the failing isolation test**

`tests/rls/isolation.test.ts`:
```ts
import { describe, it, expect, beforeAll } from "vitest";
import { makeUser } from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

let userA: SupabaseClient;
let userB: SupabaseClient;
let userAId: string;

beforeAll(async () => {
  userA = await makeUser("alice@example.com", "Alice-pw-123!");
  userB = await makeUser("bob@example.com", "Bob-pw-123!");
  const { data } = await userA.auth.getUser();
  userAId = data.user!.id;
});

describe("RLS per-user isolation", () => {
  it("a user can read their OWN profile", async () => {
    const { data, error } = await userA.from("profiles").select("id").eq("id", userAId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("a user CANNOT read another user's profile", async () => {
    const { data, error } = await userB.from("profiles").select("id").eq("id", userAId);
    expect(error).toBeNull();      // RLS returns zero rows, not an error
    expect(data).toHaveLength(0);
  });

  it("a user CANNOT change another user's profile (verified by reading back as the owner)", async () => {
    await userB.from("profiles").update({ display_name: "hacked" }).eq("id", userAId);
    const { data } = await userA.from("profiles").select("display_name").eq("id", userAId).single();
    expect(data?.display_name ?? null).not.toBe("hacked");
  });

  it("a user CANNOT insert a row owned by another user", async () => {
    const { error } = await userB.from("profiles").insert({ id: userAId });
    expect(error).not.toBeNull(); // RLS insert (no policy) and/or PK conflict reject
  });

  it("a non-owner CANNOT read the invites allowlist", async () => {
    const { data } = await userB.from("invites").select("email");
    expect(data ?? []).toHaveLength(0); // invites is default-deny
  });
});
```

- [ ] **Step 3: Write the invite-gate test (deny + allow paths via the real signup endpoint)**

`tests/auth/invite-gate.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { admin, anonClient } from "../rls/helpers";

describe("invite-gate (server-enforced, real signup path)", () => {
  it("REJECTS signup for a NON-invited email", async () => {
    const { error } = await anonClient().auth.signUp({
      email: "stranger@example.com",
      password: "Str0ng-pw-123!",
    });
    expect(error).not.toBeNull(); // gate trigger raised
  });

  it("ALLOWS signup for an invited email", async () => {
    await admin().from("invites").upsert({ email: "invited@example.com" });
    const { error } = await anonClient().auth.signUp({
      email: "invited@example.com",
      password: "Str0ng-pw-123!",
    });
    expect(error).toBeNull();
  });
});
```

- [ ] **Step 4: Run against local Supabase; verify all pass**

Run (export the values printed by `supabase start`):
```bash
export SUPABASE_TEST_URL=http://127.0.0.1:54321
export SUPABASE_TEST_ANON_KEY=<local anon key>
export SUPABASE_TEST_SERVICE_ROLE_KEY=<local service_role key>
pnpm test tests/rls/isolation.test.ts tests/auth/invite-gate.test.ts
```
Expected: all PASS. Critical assertions: cross-user read/insert/update blocked; invites unreadable; non-invited signup rejected.

- [ ] **Step 5: Prove the isolation test has teeth (temporary sabotage)**

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -c "create policy tmp_leak on public.profiles for select using (true);"
pnpm test tests/rls/isolation.test.ts || echo "GOOD: isolation test failed as expected"
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -c "drop policy tmp_leak on public.profiles;"
```
Expected: with the leak policy present, "CANNOT read" FAILS (the guardrail works); after dropping it, re-run → PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test: add RLS isolation and invite-gate security guardrails"
```

---

## Task 6: Server-only Data Access Layer (Gate 2 + Gate 3)

**Files:**
- Create: `lib/dal/session.ts`
- Test: `tests/dal/session.test.ts`

**Interfaces:**
- Consumes: `lib/supabase/server.ts` → `createClient()`.
- Produces:
  - `verifySession(): Promise<{ userId: string } | null>` — network-validated (`getUser`) user or null.
  - `requireUser(): Promise<{ userId: string }>` — user or `redirect('/login')`.
  - `assertOwnership(rowUserId: string, userId: string): void` — throws `Error('Forbidden')` on mismatch.

- [ ] **Step 1: Write the failing test for `assertOwnership`**

`tests/dal/session.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { assertOwnership } from "@/lib/dal/session";

describe("assertOwnership", () => {
  it("passes when ids match", () => {
    expect(() => assertOwnership("u1", "u1")).not.toThrow();
  });
  it("throws Forbidden when ids differ", () => {
    expect(() => assertOwnership("u1", "u2")).toThrow("Forbidden");
  });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `pnpm test tests/dal/session.test.ts`
Expected: FAIL — `assertOwnership` not exported.

- [ ] **Step 3: Implement `lib/dal/session.ts`**

```ts
import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/** Network-validated session. Uses getUser (NOT getSession) so a forged
 *  cookie cannot fake a user. Memoized per render pass via React cache. */
export const verifySession = cache(async (): Promise<{ userId: string } | null> => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return { userId: data.user.id };
});

/** Use in any page/Server Action/Route Handler that requires auth. */
export async function requireUser(): Promise<{ userId: string }> {
  const session = await verifySession();
  if (!session) redirect("/login");
  return session;
}

/** Authorization check — call after loading a row to prevent IDOR. */
export function assertOwnership(rowUserId: string, userId: string): void {
  if (rowUserId !== userId) throw new Error("Forbidden");
}
```

- [ ] **Step 4: Run the test; verify it passes**

Run: `pnpm test tests/dal/session.test.ts`
Expected: PASS (2 tests). (`verifySession`/`requireUser` need a request context and are covered by the manual end-to-end check in Task 10.)

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm typecheck`
```bash
git add -A
git commit -m "feat: add server-only DAL (verifySession, requireUser, assertOwnership)"
```

---

## Task 7: `proxy.ts` — optimistic redirect + nonce CSP (Gate 1)

**Files:**
- Create: `proxy.ts`, `lib/supabase/proxy-session.ts`

**Interfaces:**
- Consumes: `@supabase/ssr` `createServerClient`.
- Produces: `updateSession(request, requestHeaders): Promise<{ response: NextResponse; userId: string | null }>`; request gating for all non-static routes; the `x-nonce` + CSP request headers and the CSP response header; a refreshed Supabase session cookie.

- [ ] **Step 1: Implement the session-refresh helper `lib/supabase/proxy-session.ts`**

```ts
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/** Refresh the Supabase auth cookie and report the user id. Uses getClaims
 *  (local JWT/JWKS verification, network only when needed). The DAL re-checks
 *  with getUser at the data boundary. requestHeaders carries the CSP nonce. */
export async function updateSession(request: NextRequest, requestHeaders: Headers) {
  let response = NextResponse.next({ request: { headers: requestHeaders } });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = NextResponse.next({ request: { headers: requestHeaders } });
          for (const { name, value, options } of cookiesToSet)
            response.cookies.set(name, value, options);
        },
      },
    },
  );

  // No code between createServerClient and getClaims (avoids stale-session races).
  const { data } = await supabase.auth.getClaims();
  const userId = (data?.claims?.sub as string | undefined) ?? null;
  return { response, userId };
}
```
Note: if the installed `@supabase/supabase-js` lacks `getClaims`, substitute `const { data } = await supabase.auth.getUser(); const userId = data.user?.id ?? null;`. Optional hardening: `@supabase/ssr` ≥0.10 passes a second `headers` arg to `setAll` (cache-control). If your installed types expose it, forward those onto `response.headers` so CDNs never cache a refreshed authenticated response.

- [ ] **Step 2: Implement `proxy.ts`**

```ts
import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy-session";

const PUBLIC_PATHS = ["/login", "/signup", "/auth"];

export async function proxy(request: NextRequest) {
  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supaUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
  const isDev = process.env.NODE_ENV === "development";

  // 1) per-request CSP nonce (set on the REQUEST headers so Next stamps scripts)
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const supaWss = supaUrl.replace(/^https/, "wss");
  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    // dev: React/Next emit nonce-less inline styles → relax; prod: nonce only
    `style-src 'self' ${isDev ? "'unsafe-inline'" : `'nonce-${nonce}'`}`,
    `img-src 'self' blob: data:`,
    `font-src 'self'`,
    `connect-src 'self' ${supaUrl} ${supaWss}`, // wss for Supabase Realtime/auth
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `upgrade-insecure-requests`,
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  // 2) refresh session (optimistic — DAL re-verifies with getUser later)
  const { response, userId } = await updateSession(request, requestHeaders);
  response.headers.set("Content-Security-Policy", csp); // for the browser

  // 3) optimistic redirects
  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
  if (!userId && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  if (userId && (pathname === "/login" || pathname === "/signup")) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico|manifest.webmanifest).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
```
Note: the file MUST be named `proxy.ts` and export `proxy` (Next 16). A `middleware.ts` is silently ignored. The nonce is auto-injected by Next ONLY on dynamically rendered routes — keep a request-time API (e.g. `headers()`, as in `app/layout.tsx`) in scope on any page that must stay dynamic; a statically prerendered page under `strict-dynamic` would be CSP-blocked.

- [ ] **Step 3: Verify CSP + redirect behavior**

Run `pnpm dev` (with local Supabase env in `.env`), then:
```bash
curl -sI http://localhost:3000/dashboard | grep -i -E "content-security-policy|location"
```
Expected: a `Content-Security-Policy` header containing `nonce-…`, and (unauthenticated) `location: /login`. Then open `http://localhost:3000/login` in a real browser and confirm the DevTools console shows **no** `script-src`/`style-src` CSP violations (curl cannot catch those).

- [ ] **Step 4: Typecheck and commit**

Run: `pnpm typecheck`
```bash
git add -A
git commit -m "feat: add proxy.ts gate with request-header nonce CSP and optimistic redirects"
```

---

## Task 8: Static OWASP security headers in `next.config.ts`

**Files:**
- Modify: `next.config.ts`
- Test: `tests/headers.test.ts`

**Interfaces:**
- Produces: the `headers()` config. CSP stays in `proxy.ts` (per-request nonce) and is NOT duplicated here.

- [ ] **Step 1: Write a failing test asserting the header list**

`tests/headers.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import nextConfig from "@/next.config";

describe("security headers", () => {
  it("declares the OWASP header set for all routes", async () => {
    const headers = await nextConfig.headers!();
    const all = headers.find((h) => h.source === "/(.*)");
    const keys = all!.headers.map((h) => h.key.toLowerCase());
    expect(keys).toEqual(
      expect.arrayContaining([
        "strict-transport-security",
        "x-content-type-options",
        "referrer-policy",
        "x-frame-options",
        "permissions-policy",
      ]),
    );
  });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `pnpm test tests/headers.test.ts`
Expected: FAIL — `nextConfig.headers` is undefined.

- [ ] **Step 3: Implement headers in `next.config.ts`**

```ts
import type { NextConfig } from "next";

const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
```
Note: enable HSTS `preload` only once every subdomain is HTTPS — it is hard to reverse. Safe on `*.vercel.app` (HTTPS-only).

- [ ] **Step 4: Run the test; verify it passes**

Run: `pnpm test tests/headers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add static OWASP security headers"
```

---

## Task 9: Auth input validation & Server Actions

**Files:**
- Create: `lib/validation/auth.ts`, `app/auth/actions.ts`
- Test: `tests/validation/auth.test.ts`

**Interfaces:**
- Consumes: `lib/supabase/server.ts` → `createClient()`; `lib/validation/auth.ts` schemas; `process.env.NEXT_PUBLIC_SITE_URL` (trusted redirect base).
- Produces:
  - `credentialsSchema` (zod) → `{ email: string; password: string }`; `emailSchema` → `{ email: string }`.
  - Server actions `loginAction`, `signupAction`, `requestPasswordResetAction`, each `(prev: AuthState, formData: FormData) => Promise<AuthState>` where `AuthState = { error?: string; ok?: boolean }`.

- [ ] **Step 1: Write failing tests for the schema**

`tests/validation/auth.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { credentialsSchema } from "@/lib/validation/auth";

describe("credentialsSchema", () => {
  it("accepts a valid email + strong password", () => {
    const r = credentialsSchema.safeParse({ email: "a@b.com", password: "Sup3rSecret!" });
    expect(r.success).toBe(true);
  });
  it("rejects a bad email", () => {
    const r = credentialsSchema.safeParse({ email: "nope", password: "Sup3rSecret!" });
    expect(r.success).toBe(false);
  });
  it("rejects a short password", () => {
    const r = credentialsSchema.safeParse({ email: "a@b.com", password: "short" });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run; verify it fails**

Run: `pnpm test tests/validation/auth.test.ts`
Expected: FAIL — `credentialsSchema` not exported.

- [ ] **Step 3: Implement `lib/validation/auth.ts`**

```ts
import { z } from "zod";

export const credentialsSchema = z.object({
  email: z.email(),
  password: z.string().min(10, "Password must be at least 10 characters").max(200),
});

export const emailSchema = z.object({ email: z.email() });
```
Note: Supabase enforces leaked-password protection + minimum strength server-side; this is the client-boundary check. If `z.email()` is unavailable, use `z.string().email()`.

- [ ] **Step 4: Run; verify it passes**

Run: `pnpm test tests/validation/auth.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Implement `app/auth/actions.ts`**

```ts
"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { credentialsSchema, emailSchema } from "@/lib/validation/auth";

export type AuthState = { error?: string; ok?: boolean };

// Trusted redirect base for auth emails — NEVER derived from the request Origin
// header (attacker-controllable). Supabase's redirect allowlist is the backstop.
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export async function loginAction(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = credentialsSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) return { error: "Enter a valid email and password." };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return { error: "Invalid login." }; // do not leak which field failed

  revalidatePath("/", "layout"); // re-render cached layouts with the new auth state
  redirect("/dashboard");
}

export async function signupAction(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = credentialsSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) return { error: "Enter a valid email and password (10+ chars)." };

  const supabase = await createClient();
  const { error } = await supabase.auth.signUp({
    ...parsed.data,
    options: { emailRedirectTo: `${siteUrl}/auth/confirm` },
  });
  // The DB invite-gate trigger rejects non-invited emails; keep the message generic.
  if (error) return { error: "Signup is invite-only or the email is already registered." };
  return { ok: true };
}

export async function requestPasswordResetAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const parsed = emailSchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) return { error: "Enter a valid email." };

  const supabase = await createClient();
  await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${siteUrl}/auth/confirm`,
  });
  // Always report success — do not reveal whether the email exists.
  return { ok: true };
}
```

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm typecheck && pnpm test`
```bash
git add -A
git commit -m "feat: add zod auth validation and invite-gated auth server actions"
```

---

## Task 10: Auth pages, confirm/signout routes & authenticated dashboard

**Files:**
- Create: `app/login/page.tsx`, `app/signup/page.tsx`, `app/auth/confirm/route.ts`, `app/auth/signout/route.ts`, `app/dashboard/page.tsx`
- Modify: `app/page.tsx`

**Interfaces:**
- Consumes: `app/auth/actions.ts` actions; `lib/dal/session.ts` → `verifySession`, `requireUser`; `lib/supabase/server.ts` → `createClient`.
- Produces: the full login → dashboard flow, proving Gate 1→2→4 end to end.

- [ ] **Step 1: Login page `app/login/page.tsx`**

```tsx
"use client";

import { useActionState } from "react";
import { loginAction, type AuthState } from "@/app/auth/actions";

const initial: AuthState = {};

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(loginAction, initial);
  return (
    <main style={{ maxWidth: 360, margin: "10vh auto", padding: 24 }}>
      <h1>Log in</h1>
      <form action={formAction} style={{ display: "grid", gap: 12 }}>
        <input name="email" type="email" placeholder="Email" required autoComplete="email" />
        <input name="password" type="password" placeholder="Password" required autoComplete="current-password" />
        <button type="submit" disabled={pending}>{pending ? "…" : "Log in"}</button>
        {state.error ? <p role="alert" style={{ color: "crimson" }}>{state.error}</p> : null}
      </form>
      <p><a href="/signup">Have an invite? Sign up</a></p>
    </main>
  );
}
```

- [ ] **Step 2: Signup page `app/signup/page.tsx`**

```tsx
"use client";

import { useActionState } from "react";
import { signupAction, type AuthState } from "@/app/auth/actions";

const initial: AuthState = {};

export default function SignupPage() {
  const [state, formAction, pending] = useActionState(signupAction, initial);
  return (
    <main style={{ maxWidth: 360, margin: "10vh auto", padding: 24 }}>
      <h1>Sign up</h1>
      <p style={{ fontSize: 13, opacity: 0.8 }}>Invite-only. Use the email you were invited with.</p>
      <form action={formAction} style={{ display: "grid", gap: 12 }}>
        <input name="email" type="email" placeholder="Email" required autoComplete="email" />
        <input name="password" type="password" placeholder="Password (10+ chars)" required autoComplete="new-password" />
        <button type="submit" disabled={pending}>{pending ? "…" : "Create account"}</button>
        {state.error ? <p role="alert" style={{ color: "crimson" }}>{state.error}</p> : null}
        {state.ok ? <p>Check your email to confirm your account.</p> : null}
      </form>
    </main>
  );
}
```

- [ ] **Step 3: Email confirm / reset route `app/auth/confirm/route.ts`**

Supabase's `@supabase/ssr` email links deliver `token_hash` + `type` (NOT `?code=`); redeem with `verifyOtp`. (`exchangeCodeForSession` is only for OAuth/social login, not email confirm/reset.)
```ts
import { type EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  if (token_hash && type) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash });
    if (!error) return NextResponse.redirect(`${origin}/dashboard`);
  }
  return NextResponse.redirect(`${origin}/login`);
}
```

- [ ] **Step 4: Signout route `app/auth/signout/route.ts`**

```ts
import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
}
```

- [ ] **Step 5: Authenticated dashboard `app/dashboard/page.tsx`**

```tsx
import { requireUser } from "@/lib/dal/session";
import { createClient } from "@/lib/supabase/server";

export default async function DashboardPage() {
  const { userId } = await requireUser(); // Gate 2 — redirects if not authed
  const supabase = await createClient();
  // Gate 4 proves itself: RLS lets us read only our own profile row.
  const { data: profile } = await supabase
    .from("profiles")
    .select("id, display_name")
    .eq("id", userId)
    .single();

  return (
    <main style={{ maxWidth: 640, margin: "8vh auto", padding: 24 }}>
      <h1>Dashboard</h1>
      <p>Signed in. Your user id: <code>{userId}</code></p>
      <p>Profile loaded via RLS: <code>{profile?.id ?? "none"}</code></p>
      <form action="/auth/signout" method="post">
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}
```

- [ ] **Step 6: Replace `app/page.tsx` to route by auth state**

```tsx
import { redirect } from "next/navigation";
import { verifySession } from "@/lib/dal/session";

export default async function Home() {
  const session = await verifySession();
  redirect(session ? "/dashboard" : "/login");
}
```

- [ ] **Step 7: Configure local email templates, then verify end-to-end**

The `@supabase/ssr` token-hash flow needs the local email templates to point at `/auth/confirm`. In `supabase/config.toml`, set the confirmation + recovery templates to a link of the form:
```
{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email
```
(`type=recovery` for the password-reset template.) Set `[auth] site_url = "http://localhost:3000"` and add `http://localhost:3000/auth/confirm` to `additional_redirect_urls`. Run `supabase stop && supabase start` to apply.

Then with `pnpm dev` and `.env` set:
1. Invite yourself: `psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "insert into public.invites(email) values ('me@example.com');"`
2. `/signup` → register `me@example.com` (10+ char password). Open the Inbucket URL from `supabase start`, click the confirm link → lands on `/dashboard`.
3. Sign out → `/login`; visiting `/dashboard` now redirects to `/login`.
4. `/signup` with a NON-invited email → generic invite-only error.

Expected: all four behave as described.

- [ ] **Step 8: Typecheck, build, commit**

Run: `pnpm typecheck && pnpm build`
```bash
git add -A
git commit -m "feat: add auth pages, confirm/signout routes, and authenticated dashboard"
```

---

## Task 11: USDA secret boundary stub (`/api/foods`)

**Files:**
- Create: `app/api/foods/route.ts`
- Test: `tests/api/foods.test.ts`

**Interfaces:**
- Reserves the server-only boundary where `serverEnv.FDC_API_KEY` will be read in a later phase (NOT read yet — YAGNI).
- Produces: a route returning `501` until a later phase implements it — never exposing the key.

- [ ] **Step 1: Write a failing test**

`tests/api/foods.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { GET } from "@/app/api/foods/route";

describe("/api/foods stub", () => {
  it("returns 501 Not Implemented", async () => {
    const res = await GET();
    expect(res.status).toBe(501);
  });
});
```

- [ ] **Step 2: Run; verify it fails**

Run: `pnpm test tests/api/foods.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the stub `app/api/foods/route.ts`**

```ts
import { NextResponse } from "next/server";

// Reserved boundary for USDA FoodData Central (a later phase). The FDC_API_KEY
// will be read server-side ONLY here; it is never sent to the client.
export async function GET() {
  return NextResponse.json(
    { error: "Food search is not implemented yet." },
    { status: 501 },
  );
}
```
Note: the key is intentionally NOT read yet (YAGNI) — the boundary + env slot exist so the data layer bolts on here later without touching secret architecture.

- [ ] **Step 4: Run; verify it passes**

Run: `pnpm test tests/api/foods.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: stub server-only USDA proxy boundary at /api/foods"
```

---

## Task 12: CI pipeline, Dependabot, CodeQL & secret-leak guard

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/codeql.yml`, `.github/dependabot.yml`

**Interfaces:**
- Consumes: the `pnpm` scripts and the Supabase CLI for the RLS/invite tests.
- Produces: required status checks for branch protection (Task 13).

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5  # verify latest stable + SHA-pin at setup time
      - uses: pnpm/action-setup@v4
        with:
          version: 11.9.0
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck

      # Guard: server-only secret must never be referenced from app/ code.
      - name: Guard service-role key out of app/
        run: |
          if grep -rn "SERVICE_ROLE" app/ ; then
            echo "::error::service-role reference found in app/ — keep it in lib/"; exit 1
          fi

      - run: pnpm build
        env:
          NEXT_PUBLIC_SUPABASE_URL: http://127.0.0.1:54321
          NEXT_PUBLIC_SUPABASE_ANON_KEY: build-time-placeholder
          NEXT_PUBLIC_SITE_URL: http://localhost:3000
          SUPABASE_SERVICE_ROLE_KEY: build-time-placeholder

      # Guard: the (placeholder) service-role value must not be inlined in the bundle.
      - name: Guard secret out of client bundle
        run: |
          if grep -rn "build-time-placeholder" .next/static 2>/dev/null ; then
            echo "::error::a server env value leaked into the client bundle"; exit 1
          fi

      - name: Start Supabase (local) for RLS + invite-gate tests
        run: supabase start

      - name: Export local Supabase creds (anchored parse; values may contain '=')
        run: |
          supabase status -o env > /tmp/supa.env
          API_URL=$(grep '^API_URL=' /tmp/supa.env | cut -d= -f2- | tr -d '"')
          ANON=$(grep '^ANON_KEY=' /tmp/supa.env | cut -d= -f2- | tr -d '"')
          SERVICE=$(grep '^SERVICE_ROLE_KEY=' /tmp/supa.env | cut -d= -f2- | tr -d '"')
          test -n "$API_URL" && test -n "$ANON" && test -n "$SERVICE" \
            || { echo "::error::failed to parse Supabase creds"; cat /tmp/supa.env; exit 1; }
          {
            echo "SUPABASE_TEST_URL=$API_URL"
            echo "SUPABASE_TEST_ANON_KEY=$ANON"
            echo "SUPABASE_TEST_SERVICE_ROLE_KEY=$SERVICE"
          } >> "$GITHUB_ENV"

      - run: pnpm test
        env:
          NEXT_PUBLIC_SUPABASE_URL: http://127.0.0.1:54321
          NEXT_PUBLIC_SUPABASE_ANON_KEY: build-time-placeholder
          NEXT_PUBLIC_SITE_URL: http://localhost:3000
          SUPABASE_SERVICE_ROLE_KEY: build-time-placeholder
```
Note: the `supabase` CLI is preinstalled on `ubuntu-latest` runners; if a run reports it missing, add a `supabase/setup-cli@v1` step (verify latest). On first CI run, confirm the exact key names in `supabase status -o env` and adjust the anchored `grep` keys if they differ. The local Supabase migration is applied automatically by `supabase start`.

- [ ] **Step 2: Create `.github/dependabot.yml`**

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule: { interval: weekly }
    open-pull-requests-limit: 10
  - package-ecosystem: github-actions
    directory: "/"
    schedule: { interval: weekly }
```

- [ ] **Step 3: Create `.github/workflows/codeql.yml`**

```yaml
name: CodeQL
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  schedule:
    - cron: "0 6 * * 1"

permissions:
  contents: read
  security-events: write

jobs:
  analyze:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: github/codeql-action/init@v3
        with:
          languages: javascript-typescript
      - uses: github/codeql-action/analyze@v3
```

- [ ] **Step 4: Validate workflow YAML locally**

Run: `pnpm dlx @action-validator/cli .github/workflows/ci.yml` (or visually confirm valid YAML).
Expected: no syntax errors. (CI truly runs once pushed in Task 13.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "ci: add lint/typecheck/build/test pipeline, secret guards, Dependabot, CodeQL"
```

---

## Task 13: GitHub + Vercel + Supabase wiring (deploy)

**Files:** none in-repo beyond a `## Deploy` section appended to `README.md`. Configuration happens in external dashboards + the `gh`/`vercel`/`supabase` CLIs.

**Interfaces:**
- Consumes: everything above.
- Produces: a live Vercel Hobby deployment; a hardened public GitHub repo.

- [ ] **Step 1: Create the production Supabase project & apply schema**

In the Supabase dashboard, create a project, then:
```bash
supabase link --project-ref <your-ref>
supabase db push
```
In Auth settings: enable Email provider; **require email confirmation**; enable **leaked-password protection**; set **minimum password length ≥ 10**. Set **Site URL** to the Vercel domain and add `https://<domain>/auth/confirm` to the redirect allowlist (exact, **no wildcards**). Edit the **Confirm signup** and **Reset password** email templates to use `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email` (and `type=recovery` for reset).

- [ ] **Step 2: Create the GitHub repo and push**

```bash
gh repo create NDilbone/Nutri-Shop-Website --public --source=. --remote=origin
git push -u origin main
```

- [ ] **Step 3: Connect Vercel (Hobby) and set env vars**

In Vercel: New Project → import the repo. Set env vars (Production + Preview):
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SITE_URL` (= `https://<domain>`) — public
- `SUPABASE_SERVICE_ROLE_KEY` — secret
- `FDC_API_KEY` — secret (placeholder fine for v1)

Deploy. Confirm the production `NEXT_PUBLIC_SITE_URL` + Supabase Site URL/redirect URLs all match the real domain.

- [ ] **Step 4: Harden the GitHub repo**

Repo Settings:
- **Code security:** enable Secret scanning + **Push protection**; confirm CodeQL runs (Task 12 workflow); confirm Dependabot enabled.
- **Branches:** protect `main` — require a PR before merging, require the `verify` CI check to pass, dismiss stale approvals.

Document Steps 1–4 in a `## Deploy` section of `README.md`; commit and push.

- [ ] **Step 5: Smoke-test production**

1. Insert an invite row in the production DB (dashboard → Table editor → `invites`).
2. `/signup` with that email → confirm via email → log in → `/dashboard`.
3. DevTools → Network: document response has `Content-Security-Policy` (with a nonce) + the OWASP headers; console shows no CSP violations.
4. View source / search the JS bundle for the service-role key → confirm **absent**.

Expected: invited signup works, headers present, no secret in the client.

- [ ] **Step 6: Commit the README deploy docs**

```bash
git add README.md
git commit -m "docs: add deployment and repo-hardening guide"
git push
```

---

## Self-Review

**1. Spec coverage** — every spec section maps to a task:
- Stack/versions → Task 1 + Global Constraints. Secret hygiene → Tasks 2, 3, 11 + the `app/` import guard (Task 1 eslint) and CI secret guards (Task 12). Four-gate model → Task 7 (Gate 1, request-header nonce), Task 6 (Gates 2–3, getUser), Tasks 4–5 (Gate 4 + invite gate). Auth + invite-only → Tasks 4 (trigger+grants), 9 (actions), 10 (pages + verifyOtp confirm). Data model + RLS → Task 4; isolation + invite-gate tests → Task 5. OWASP headers/CSP → Tasks 7–8 (dev-relaxed style-src, wss connect-src). Validation → Tasks 3, 9. Rate limiting → Supabase Auth settings (Task 13 Step 1); Vercel WAF deferred to roadmap (noted below). USDA slot → Tasks 2, 11. Repo hardening + CI → Tasks 12–13. Deploy → Task 13. Success criteria 1–7 → Tasks 4/5/10/13 verifications.
- Intentional scope edge: Vercel WAF `@vercel/firewall` edge rate limiting is in the spec's security baseline but v1 relies on Supabase-level auth rate limits; edge WAF is a Pro-tier/roadmap item (surfaced, not hidden).

**2. Placeholder scan** — every code step contains real code. The `"latest"` entries in `package.json` (`server-only`, `vitest`, `vite-tsconfig-paths`, `@types/*`) are flagged in Task 1 Step 3 to be replaced with the exact versions printed in Step 1 — the plan forces verification rather than guessing an unverified pin.

**3. Type & name consistency** — `createClient()` (async server / sync browser) consistent (Tasks 3/6/7/9/10). `updateSession(request, requestHeaders)` returns `{ response, userId }` (Task 7) and is called that way. `verifySession`/`requireUser`/`assertOwnership` consistent (Tasks 6/10). `AuthState` shape consistent (Tasks 9/10). `credentialsSchema`/`emailSchema` consistent (Tasks 9/10). `admin()`/`anonClient()`/`makeUser()` consistent (Task 5). Env var names — `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `FDC_API_KEY` — consistent across Tasks 2/3/7/9/12/13.

**4. Verification provenance** — this plan incorporates fixes from an adversarial multi-agent review (Next 16 / Supabase SSR / security / consistency) verified against current official docs: request-header CSP nonce, `verifyOtp` token-hash email flow, Vitest `@/` alias, dev-relaxed CSP + `wss` connect-src, committed invite-gate deny test + auth-admin grants, `getClaims` in proxy, trusted `SITE_URL` redirect base, `revalidatePath` after auth, ESLint flat-config core-web-vitals+typescript, and CI secret-leak guards.
