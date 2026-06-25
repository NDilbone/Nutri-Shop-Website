# Phase 4: PWA install + responsive desktop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Nutri-Shop an installable PWA (Android, iOS, desktop Chromium) with a branded offline shell, and reflow the phone-first UI into a real desktop app on wide screens — without the service worker ever caching authenticated data.

**Architecture:** `@serwist/next` generates a service worker that precaches static build assets only (`runtimeCaching: []`) and serves a precached `/~offline` page for failed document navigations; everything dynamic stays NetworkOnly. The SW build runs under webpack (`next build --webpack`) because Serwist's plugin does not run under Next 16's default Turbopack. The desktop layout is additive Tailwind `lg:` utilities: a collapsible `SideNav` replaces the bottom `TabBar`, the shared `Sheet` primitive becomes a centered modal, and Today/List/Add reflow into multi-column grids.

**Tech Stack:** Next.js 16.2.9 (App Router), React 19, Tailwind v4, `@serwist/next`/`serwist` 9.5.11, `sharp` 0.35.2, Supabase, Vitest (node env), pnpm 11.9, TypeScript 6.

**Spec:** [`docs/superpowers/specs/2026-06-25-nutri-shop-pwa-desktop-design.md`](../specs/2026-06-25-nutri-shop-pwa-desktop-design.md)

## Global Constraints

- **Dependencies pinned to latest stable:** `@serwist/next@9.5.11`, `serwist@9.5.11` (NOT `10.x` — preview), `sharp@0.35.2`. Verify each is still the newest stable before pinning.
- **Identity:** every commit in this repo is authored by **NDilbone**. Before committing, confirm `git config --local user.email` = `208098727+NDilbone@users.noreply.github.com`. Never write "RegEdits" or any AI/Claude attribution into any file, commit, or message.
- **Branch:** all work on `phase-4-pwa-desktop` (already created off `main`; the spec lives there).
- **SW privacy invariant (non-negotiable):** the service worker caches **only** static build assets + `/~offline`. No authenticated HTML, RSC, or `/api` response is ever cached. The sole runtime route is a `NetworkOnly` navigation handler — it writes nothing to the cache and exists only so the offline fallback fires (serwist attaches the fallback plugin per `runtimeCaching` entry, so an empty array would never serve `/~offline`).
- **Build bundler:** production build is `next build --webpack`. `next dev` stays on Turbopack (SW disabled in dev). Local SW testing = `pnpm build && pnpm start`.
- **No `useEffect` for derived/setState:** initialise client state during render (guarded), or via `useSyncExternalStore`. The repo's ESLint enforces the React-19 set-state-in-effect rule; `pnpm lint` must pass (Turbopack build skips ESLint).
- **Every UI task runs all four gates before commit:** `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.
- **Breakpoint:** `lg` (1024px, Tailwind v4 default) is the single switch for sidebar + modal + multi-column.
- **Tests are node-env, `tests/**/*.test.ts`, pure-function only.** Do NOT add jsdom / Testing Library. Presentational changes are verified by `build` + manual screenshots.

---

### Task 1: Proxy / security hardening (extract testable CSP + public-paths, add PWA directives)

Refactor `proxy.ts`'s inline CSP and public-path logic into pure, unit-testable modules, and add the PWA-required CSP directives (`worker-src`, `manifest-src`), the `/~offline` public path, and the `sw.js` matcher exclusion. No runtime behavior change beyond the additions.

**Files:**
- Create: `lib/security/csp.ts`
- Create: `lib/security/public-paths.ts`
- Modify: `proxy.ts` (replace inline CSP + PUBLIC_PATHS + matcher source)
- Test: `tests/security/csp.test.ts`, `tests/security/public-paths.test.ts`, `tests/proxy-matcher.test.ts`

**Interfaces:**
- Produces: `buildCsp(nonce: string, opts: { dev: boolean }, supabaseUrl: string): string`
- Produces: `PUBLIC_PATHS: string[]`, `isPublicPath(pathname: string): boolean`
- Produces: `proxy.ts` still exports `proxy(request)` and `config` (matcher) unchanged in shape.

- [ ] **Step 1: Write failing test for `buildCsp`**

Create `tests/security/csp.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildCsp } from "@/lib/security/csp";

const SUPA = "https://abc.supabase.co";

describe("buildCsp", () => {
  it("declares worker-src and manifest-src as 'self' (required for the PWA service worker + manifest)", () => {
    const csp = buildCsp("n0nce", { dev: false }, SUPA);
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("manifest-src 'self'");
  });

  it("uses a nonce'd style-src in production and keeps strict-dynamic scripts", () => {
    const csp = buildCsp("n0nce", { dev: false }, SUPA);
    expect(csp).toContain("style-src 'self' 'nonce-n0nce'");
    expect(csp).toContain("script-src 'self' 'nonce-n0nce' 'strict-dynamic'");
  });

  it("relaxes style-src and allows unsafe-eval in dev", () => {
    const csp = buildCsp("n0nce", { dev: true }, SUPA);
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("'unsafe-eval'");
  });

  it("allows Supabase in connect-src including the websocket origin", () => {
    const csp = buildCsp("n0nce", { dev: false }, SUPA);
    expect(csp).toContain(`connect-src 'self' ${SUPA} wss://abc.supabase.co`);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/security/csp.test.ts`
Expected: FAIL — cannot resolve `@/lib/security/csp`.

- [ ] **Step 3: Implement `lib/security/csp.ts`**

```ts
/** Build the per-request Content-Security-Policy string.
 *  Pure + side-effect free so it can be unit-tested without a request. */
export function buildCsp(nonce: string, opts: { dev: boolean }, supabaseUrl: string): string {
  const { dev } = opts;
  const supaWss = supabaseUrl.replace(/^http/, "ws");
  return [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // dev: React/Next emit nonce-less inline styles → relax; prod: nonce only
    `style-src 'self' ${dev ? "'unsafe-inline'" : `'nonce-${nonce}'`}`,
    `img-src 'self' blob: data:`,
    `font-src 'self'`,
    `connect-src 'self' ${supabaseUrl} ${supaWss}`, // wss for Supabase Realtime/auth
    `worker-src 'self'`,    // PWA: strict-dynamic ignores 'self' for workers, so set explicitly
    `manifest-src 'self'`,  // PWA: explicit allow for /manifest.webmanifest
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `upgrade-insecure-requests`,
  ].join("; ");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test tests/security/csp.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write failing test for `isPublicPath`**

Create `tests/security/public-paths.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isPublicPath } from "@/lib/security/public-paths";

describe("isPublicPath", () => {
  it("treats the offline fallback as public so it precaches/renders without a session", () => {
    expect(isPublicPath("/~offline")).toBe(true);
  });
  it("keeps the existing auth paths public", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/signup")).toBe(true);
    expect(isPublicPath("/auth/confirm")).toBe(true);
  });
  it("gates authenticated app routes", () => {
    expect(isPublicPath("/today")).toBe(false);
    expect(isPublicPath("/list")).toBe(false);
    expect(isPublicPath("/")).toBe(false);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm test tests/security/public-paths.test.ts`
Expected: FAIL — cannot resolve `@/lib/security/public-paths`.

- [ ] **Step 7: Implement `lib/security/public-paths.ts`**

```ts
/** Paths reachable without a session. `/~offline` is the PWA offline fallback —
 *  it must render/precache pre-login and never redirect. */
export const PUBLIC_PATHS = ["/login", "/signup", "/auth", "/~offline"];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `pnpm test tests/security/public-paths.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 9: Refactor `proxy.ts` to use the modules + exclude `sw.js` from the matcher**

Replace the full contents of `proxy.ts` with:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy-session";
import { buildCsp } from "@/lib/security/csp";
import { isPublicPath } from "@/lib/security/public-paths";

export async function proxy(request: NextRequest) {
  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supaUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
  const isDev = process.env.NODE_ENV === "development";

  // 1) per-request CSP nonce (set on the REQUEST headers so Next stamps scripts)
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp(nonce, { dev: isDev }, supaUrl);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  // 2) refresh session (optimistic — DAL re-verifies with getUser later)
  const { response, userId } = await updateSession(request, requestHeaders);
  response.headers.set("Content-Security-Policy", csp); // for the browser

  // 3) optimistic redirects
  const { pathname } = request.nextUrl;
  if (!userId && !isPublicPath(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  if (userId && (pathname === "/login" || pathname === "/signup")) {
    const url = request.nextUrl.clone();
    url.pathname = "/today";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    {
      // also excludes sw.js so the service worker file is never auth-gated/redirected
      source: "/((?!api|_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
```

- [ ] **Step 10: Write failing test for the matcher**

Create `tests/proxy-matcher.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { config } from "@/proxy";

describe("proxy matcher", () => {
  it("excludes service-worker, manifest, favicon and static assets from auth gating", () => {
    const source = (config.matcher[0] as { source: string }).source;
    for (const fragment of ["sw.js", "manifest.webmanifest", "favicon.ico", "_next/static", "_next/image", "api"]) {
      expect(source).toContain(fragment);
    }
  });
});
```

- [ ] **Step 11: Run the full security suite**

Run: `pnpm test tests/security tests/proxy-matcher.test.ts tests/headers.test.ts`
Expected: PASS. Then `pnpm typecheck` and `pnpm lint` clean.

- [ ] **Step 12: Commit**

```bash
git add lib/security proxy.ts tests/security tests/proxy-matcher.test.ts
git commit -m "feat: extract CSP/public-path helpers and add PWA security directives"
```

---

### Task 2: Web app manifest

A typed Next metadata route served at `/manifest.webmanifest`.

**Files:**
- Create: `app/manifest.ts`
- Test: `tests/pwa/manifest.test.ts`

**Interfaces:**
- Produces: `export default function manifest(): MetadataRoute.Manifest` returning the app manifest. Icon URLs `/icons/icon-192.png`, `/icons/icon-512.png`, `/icons/icon-maskable-512.png` are produced by Task 5.

- [ ] **Step 1: Write the failing test**

Create `tests/pwa/manifest.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import manifest from "@/app/manifest";

describe("web manifest", () => {
  const m = manifest();
  it("lands an installed user on /today", () => {
    expect(m.start_url).toBe("/today");
    expect(m.scope).toBe("/");
  });
  it("uses the dark-editorial theme/background color", () => {
    expect(m.theme_color).toBe("#0f1411");
    expect(m.background_color).toBe("#0f1411");
  });
  it("declares a standalone display", () => {
    expect(m.display).toBe("standalone");
  });
  it("ships a maskable icon and the 192/512 set", () => {
    const purposes = (m.icons ?? []).map((i) => i.purpose ?? "any");
    expect(purposes).toContain("maskable");
    const sizes = (m.icons ?? []).map((i) => i.sizes);
    expect(sizes).toEqual(expect.arrayContaining(["192x192", "512x512"]));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/pwa/manifest.test.ts`
Expected: FAIL — cannot resolve `@/app/manifest`.

- [ ] **Step 3: Implement `app/manifest.ts`**

```ts
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Nutri-Shop",
    short_name: "Nutri-Shop",
    description: "Private nutrition tracker & shopping list",
    start_url: "/today",
    scope: "/",
    display: "standalone",
    display_override: ["standalone"],
    background_color: "#0f1411",
    theme_color: "#0f1411",
    orientation: "portrait",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test tests/pwa/manifest.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/manifest.ts tests/pwa/manifest.test.ts
git commit -m "feat: add PWA web manifest"
```

---

### Task 3: Install-state decision logic

The pure function deciding which install affordance to show, so the platform branching is testable without a DOM.

**Files:**
- Create: `lib/pwa/install.ts`
- Test: `tests/pwa/install.test.ts`

**Interfaces:**
- Produces: `type InstallState = "hidden" | "ios-hint" | "chromium-button"`
- Produces: `getInstallState(env: { standalone: boolean; isIosSafari: boolean; canPrompt: boolean; dismissed: boolean }): InstallState`

- [ ] **Step 1: Write the failing test**

Create `tests/pwa/install.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { getInstallState } from "@/lib/pwa/install";

const base = { standalone: false, isIosSafari: false, canPrompt: false, dismissed: false };

describe("getInstallState", () => {
  it("hides when already installed/standalone, even if a prompt is available", () => {
    expect(getInstallState({ ...base, standalone: true, canPrompt: true })).toBe("hidden");
  });
  it("hides when the user dismissed the affordance", () => {
    expect(getInstallState({ ...base, dismissed: true, canPrompt: true })).toBe("hidden");
  });
  it("shows the Chromium install button when a deferred prompt exists", () => {
    expect(getInstallState({ ...base, canPrompt: true })).toBe("chromium-button");
  });
  it("shows the iOS hint on iOS Safari with no prompt event", () => {
    expect(getInstallState({ ...base, isIosSafari: true })).toBe("ios-hint");
  });
  it("hides on a non-iOS browser that can't prompt", () => {
    expect(getInstallState(base)).toBe("hidden");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/pwa/install.test.ts`
Expected: FAIL — cannot resolve `@/lib/pwa/install`.

- [ ] **Step 3: Implement `lib/pwa/install.ts`**

```ts
export type InstallState = "hidden" | "ios-hint" | "chromium-button";

/** Decide which install affordance (if any) to show. Pure → unit-testable.
 *  Precedence: installed/dismissed win; a captured prompt beats the iOS hint. */
export function getInstallState(env: {
  standalone: boolean;   // display-mode standalone OR iOS navigator.standalone
  isIosSafari: boolean;  // iOS + Safari (no beforeinstallprompt support)
  canPrompt: boolean;    // a beforeinstallprompt event was captured
  dismissed: boolean;    // user dismissed our affordance (persisted)
}): InstallState {
  if (env.standalone || env.dismissed) return "hidden";
  if (env.canPrompt) return "chromium-button";
  if (env.isIosSafari) return "ios-hint";
  return "hidden";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test tests/pwa/install.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/pwa/install.ts tests/pwa/install.test.ts
git commit -m "feat: add install-affordance decision logic"
```

---

### Task 4: PWA build core — service worker, offline route, Serwist wiring, webpack build

Install Serwist, create the SW source and offline fallback route, wire `next.config.ts`, switch the build to webpack, add `vercel.json`, and update `.gitignore` and the worker tsconfig. This task's deliverable is a successful `next build --webpack` that emits `public/sw.js`.

**Files:**
- Create: `app/sw.ts`
- Create: `app/~offline/page.tsx`, `app/~offline/RetryButton.tsx`
- Create: `vercel.json`, `tsconfig.sw.json`
- Modify: `next.config.ts`, `package.json`, `tsconfig.json`, `.gitignore`

**Interfaces:**
- Consumes: `/~offline` is public (Task 1).
- Produces: a built `public/sw.js`; `metadata`/`viewport` hooks consumed by Task 6.

- [ ] **Step 1: Install dependencies (verify latest stable first)**

```bash
pnpm add @serwist/next@9.5.11 serwist@9.5.11
```
Confirm `serwist`'s newest STABLE is still `9.5.x` (NOT `10.x`, which is preview) before accepting the version.

- [ ] **Step 2: Create the offline fallback route**

`app/~offline/RetryButton.tsx`:

```tsx
"use client";

import { Button } from "@/components/ui/Button";

export function RetryButton() {
  return <Button onClick={() => location.reload()}>Retry</Button>;
}
```

`app/~offline/page.tsx`:

```tsx
import { RetryButton } from "./RetryButton";

export const metadata = { title: "Offline · Nutri-Shop" };

// Static, data-free: the SW serves this when a document navigation fails offline.
export default function OfflinePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-[480px] flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="text-2xl font-bold text-brand">Nutri-Shop</div>
      <h1 className="text-lg font-semibold">You&apos;re offline</h1>
      <p className="text-sm text-muted">Reconnect to log food and update your shopping list.</p>
      <RetryButton />
    </main>
  );
}
```

- [ ] **Step 3: Create the service worker source**

`app/sw.ts`:

```ts
/// <reference lib="webworker" />
import { Serwist, NetworkOnly } from "serwist";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    // injected by the Serwist build plugin: static assets + the /~offline entry
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}
declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST, // static build assets + /~offline only
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  // PRIVACY INVARIANT: NetworkOnly writes nothing to the cache — no authed HTML/JSON
  // is ever stored. This single navigation route exists ONLY so the fallback plugin
  // (which serwist attaches per runtimeCaching entry) has a strategy whose
  // handlerDidError fires offline and serves the precached /~offline page.
  // An empty runtimeCaching array would never serve the fallback.
  runtimeCaching: [
    { matcher: ({ request }) => request.mode === "navigate", handler: new NetworkOnly() },
  ],
  fallbacks: {
    entries: [
      {
        url: "/~offline",
        matcher: ({ request }) => request.destination === "document",
      },
    ],
  },
});

serwist.addEventListeners();
```

- [ ] **Step 4: Isolate the worker from the DOM-lib typecheck**

The SW needs the `webworker` lib, which clashes with the project's `dom` lib. Keep it out of the main program and check it separately.

Create `tsconfig.sw.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "lib": ["webworker", "ESNext"],
    "types": []
  },
  "include": ["app/sw.ts"],
  "exclude": ["node_modules"]
}
```

> The `exclude` override is **required**: a child config inherits the base `exclude`, which now lists `app/sw.ts`, and `exclude` filters `include` → zero inputs → `tsc` fails with `TS18003`. Redefining `exclude` here drops `app/sw.ts` from the exclusion so the worker project sees exactly one input.

Modify `tsconfig.json` — add `app/sw.ts` to `exclude` so the dom-lib program skips it:

```json
  "exclude": [
    "node_modules",
    "app/sw.ts"
  ]
```

- [ ] **Step 5: Wire `next.config.ts` + switch build to webpack**

Replace `next.config.ts` with:

```ts
import { spawnSync } from "node:child_process";
import type { NextConfig } from "next";
import withSerwistInit from "@serwist/next";

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

// Stable cache-busting revision for the explicitly-precached /~offline document.
const revision =
  process.env.VERCEL_GIT_COMMIT_SHA ||
  spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).stdout?.trim() ||
  "dev";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

const withSerwist = withSerwistInit({
  swSrc: "app/sw.ts",
  swDest: "public/sw.js",
  // SW only in production builds; `next dev` (Turbopack) runs without it.
  disable: process.env.NODE_ENV === "development",
  // Precache the offline fallback explicitly (it is not a hashed build asset).
  additionalPrecacheEntries: [{ url: "/~offline", revision }],
});

export default withSerwist(nextConfig);
```

Update `package.json` scripts — `build` and `typecheck`:

```jsonc
"build": "next build --webpack",
"typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.sw.json",
```

- [ ] **Step 6: Force webpack on Vercel + ignore generated SW artifacts**

Create `vercel.json`:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "buildCommand": "next build --webpack"
}
```

Append to `.gitignore` (under the `# next` group):

```
# serwist (generated at build)
public/sw.js
public/sw.js.map
public/swe-worker-*.js
```

- [ ] **Step 7: Verify the webpack build emits the service worker**

Run (placeholder env mirrors CI):

```bash
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
NEXT_PUBLIC_SUPABASE_ANON_KEY=build-time-placeholder \
NEXT_PUBLIC_SITE_URL=http://localhost:3000 \
SUPABASE_SERVICE_ROLE_KEY=build-time-placeholder \
pnpm build
```
Expected: build succeeds and `public/sw.js` exists (`ls -l public/sw.js`). Verify the precache manifest privacy invariant:

```bash
grep -c "~offline" public/sw.js   # >= 1 — offline fallback is precached
grep -Eo "/_next/static[^\"']*" public/sw.js | head   # static assets present
grep -E "url:\"/(today|list|add|account)\"" public/sw.js && echo "LEAK: app route precached" || echo "ok: no authed route in precache"
```
Expected: `~offline` count ≥ 1; static assets listed; "ok: no authed route in precache". Then `pnpm typecheck` (both projects) and `pnpm lint` clean.

- [ ] **Step 8: Commit**

```bash
git add app/sw.ts "app/~offline" next.config.ts package.json tsconfig.json tsconfig.sw.json vercel.json .gitignore pnpm-lock.yaml
git commit -m "feat: add Serwist service worker, offline fallback, and webpack build"
```

---

### Task 5: Icon generation pipeline

A `sharp` script that turns a single master into the committed PWA icon set, plus a placeholder master so the build is unblocked before the owner supplies art.

**Files:**
- Create: `scripts/gen-icons.mjs`
- Create: `assets/icon-master.svg` (placeholder)
- Create (generated, committed): `public/icons/icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon-180.png`
- Modify: `package.json` (add `sharp` dep + `gen:icons` script)

**Interfaces:**
- Consumes: manifest icon URLs (Task 2) and `metadata.icons` (Task 6) reference these files.

- [ ] **Step 1: Add sharp + the script entry**

```bash
pnpm add -D sharp@0.35.2
```
(`sharp` is already in `pnpm-workspace.yaml` `allowBuilds`, so no native-build prompt.) Add to `package.json` scripts:

```jsonc
"gen:icons": "node scripts/gen-icons.mjs",
```

- [ ] **Step 2: Create a placeholder master**

`assets/icon-master.svg` (on-brand placeholder; the owner swaps this file later, no code change):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" rx="96" fill="#0f1411"/>
  <path d="M168 360V152h28l120 150V152h28v208h-28L196 210v150z" fill="#22c55e"/>
</svg>
```

- [ ] **Step 3: Write the generator**

`scripts/gen-icons.mjs`:

```js
import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const master = path.join(root, "assets", "icon-master.svg");
const outDir = path.join(root, "public", "icons");
const BG = "#0f1411";

if (!existsSync(master)) {
  console.error(`Missing master art: ${master}`);
  process.exit(1);
}
await mkdir(outDir, { recursive: true });

const from = () => sharp(master, { density: 512 });

// "any" icons (contained on the brand background).
for (const size of [192, 512]) {
  await from()
    .resize(size, size, { fit: "contain", background: BG })
    .flatten({ background: BG })
    .png()
    .toFile(path.join(outDir, `icon-${size}.png`));
}

// Apple touch (opaque, no transparency).
await from()
  .resize(180, 180, { fit: "contain", background: BG })
  .flatten({ background: BG })
  .png()
  .toFile(path.join(outDir, "apple-touch-icon-180.png"));

// Maskable: master in the inner 80% safe zone on a solid 512 canvas.
const inner = Math.round(512 * 0.8);
const masked = await from()
  .resize(inner, inner, { fit: "contain", background: BG })
  .png()
  .toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: BG } })
  .composite([{ input: masked, gravity: "center" }])
  .png()
  .toFile(path.join(outDir, "icon-maskable-512.png"));

console.log("Generated public/icons: icon-192, icon-512, icon-maskable-512, apple-touch-icon-180");
```

- [ ] **Step 4: Generate + verify the outputs**

Run: `pnpm gen:icons`
Then verify sizes:

```bash
node -e "import('sharp').then(async ({default:s})=>{for(const f of ['icon-192','icon-512','icon-maskable-512','apple-touch-icon-180']){const m=await s('public/icons/'+f+'.png').metadata();console.log(f,m.width+'x'+m.height)}})"
```
Expected: `icon-192 192x192`, `icon-512 512x512`, `icon-maskable-512 512x512`, `apple-touch-icon-180 180x180`.

- [ ] **Step 5: Commit (master + script + generated outputs)**

```bash
git add scripts/gen-icons.mjs assets/icon-master.svg public/icons package.json pnpm-lock.yaml
git commit -m "feat: add PWA icon generation pipeline and placeholder art"
```

---

### Task 6: Install affordance component + PWA head metadata

The client component that surfaces the install button (Chromium) or iOS hint, mounted in the app shell, plus the PWA `<head>` metadata (manifest link, theme color, apple-web-app, icons).

**Files:**
- Create: `components/ui/InstallPrompt.tsx`
- Modify: `app/layout.tsx` (metadata + viewport)
- Modify: `app/(app)/layout.tsx` (mount `InstallPrompt`)

**Interfaces:**
- Consumes: `getInstallState` (Task 3); icon files (Task 5); manifest route (Task 2).
- Produces: `<InstallPrompt />` (default-less named export).

- [ ] **Step 1: Implement `components/ui/InstallPrompt.tsx`**

Uses a module-level store for the (window-global) install events + render-time init for the persisted dismissal — no `setState`-in-`useEffect`.

```tsx
"use client";

import { useState, useSyncExternalStore } from "react";
import { getInstallState } from "@/lib/pwa/install";

const DISMISS_KEY = "ns:install-dismissed";

type BIPEvent = Event & { prompt: () => Promise<void> };

// --- window-global install event store (survives re-renders, set up once) ---
let deferred: BIPEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function ensureGlobalListeners() {
  if (typeof window === "undefined") return;
  const w = window as unknown as { __nsInstallInit?: boolean };
  if (w.__nsInstallInit) return;
  w.__nsInstallInit = true;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as BIPEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    installed = true;
    deferred = null;
    emit();
  });
}

function subscribe(cb: () => void) {
  ensureGlobalListeners();
  listeners.add(cb);
  return () => listeners.delete(cb);
}
const getSnapshot = () => `${deferred ? "1" : "0"}:${installed ? "1" : "0"}`;
const getServerSnapshot = () => "0:0";

// SSR-safe "are we on the client yet" — no effect, no hydration mismatch.
const useIsClient = () =>
  useSyncExternalStore(() => () => {}, () => true, () => false);

export function InstallPrompt() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const isClient = useIsClient();
  const [dismissed, setDismissed] = useState(false);
  const [read, setRead] = useState(false);

  // render-time init of persisted dismissal (client only, once)
  if (isClient && !read) {
    setRead(true);
    setDismissed(localStorage.getItem(DISMISS_KEY) === "1");
  }

  if (!isClient) return null;

  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  const ua = window.navigator.userAgent;
  const isIosSafari =
    /iP(hone|ad|od)/.test(ua) && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);

  const state = getInstallState({
    standalone,
    isIosSafari,
    canPrompt: snap.startsWith("1"),
    dismissed,
  });
  if (state === "hidden") return null;

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, "1");
    setDismissed(true);
  };

  return (
    <div className="fixed inset-x-0 bottom-24 z-30 mx-auto flex w-fit max-w-[92vw] items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-sm shadow-2xl lg:bottom-6 lg:left-6 lg:right-auto lg:mx-0">
      {state === "chromium-button" ? (
        <button
          type="button"
          className="rounded-md bg-brand px-3 py-1.5 font-medium text-[#08130b]"
          onClick={async () => {
            const evt = deferred;
            if (!evt) return;
            await evt.prompt();
            deferred = null;
            emit();
          }}
        >
          Install Nutri-Shop
        </button>
      ) : (
        <span className="text-muted">
          Install: tap <span aria-hidden>⎙</span> Share → “Add to Home Screen”
        </span>
      )}
      <button type="button" aria-label="Dismiss" className="text-muted" onClick={dismiss}>
        ✕
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Add PWA metadata to `app/layout.tsx`**

Replace the `metadata` export and add a `viewport` export (Next maps these to `<link rel="manifest">`, `theme-color`, `apple-mobile-web-app-*`, and icon `<link>`s):

```tsx
import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Nutri-Shop",
  description: "Private nutrition tracker",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Nutri-Shop", statusBarStyle: "black-translucent" },
  icons: {
    icon: "/icons/icon-192.png",
    apple: "/icons/apple-touch-icon-180.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#0f1411",
};
```

(Keep the existing `import "./globals.css"`, the `Inter` font setup, the `await headers()` call, and the `<html>/<body>` markup unchanged.)

- [ ] **Step 3: Mount `InstallPrompt` in the app shell**

In `app/(app)/layout.tsx`, import and render `<InstallPrompt />` once (final shell wiring lands in Task 8; for now add the import and place it just before the closing tag):

```tsx
import { InstallPrompt } from "@/components/ui/InstallPrompt";
// ...inside the returned tree, after {children}:
<InstallPrompt />
```

- [ ] **Step 4: Verify gates**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build` (with the placeholder env from Task 4 Step 7).
Expected: all green. (No automated render test — `getInstallState` is covered by Task 3; the component is verified in manual e2e.)

- [ ] **Step 5: Commit**

```bash
git add components/ui/InstallPrompt.tsx app/layout.tsx "app/(app)/layout.tsx"
git commit -m "feat: add install prompt and PWA head metadata"
```

---

### Task 7: Responsive Sheet (bottom-sheet on phone, centered modal on desktop)

Make the shared `Sheet` primitive present as a centered modal at `≥lg` so every consumer (ItemSheet, QuickAddSheet, food detail) upgrades automatically. Presentational only; verify via build + screenshots.

**Files:**
- Modify: `components/ui/Sheet.tsx`

**Interfaces:**
- Unchanged props/contract: `Sheet({ open, onClose, title, children })`.

- [ ] **Step 1: Update `components/ui/Sheet.tsx`**

```tsx
"use client";

import type { ReactNode } from "react";

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title?: string; children: ReactNode }) {
  return (
    <div
      className={`fixed inset-0 z-50 ${open ? "" : "pointer-events-none"} lg:flex lg:items-center lg:justify-center lg:p-6`}
      aria-hidden={!open}
      inert={!open}
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className={`absolute inset-0 bg-black/50 transition-opacity ${open ? "opacity-100" : "opacity-0"}`}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title ?? "Dialog"}
        className={`absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-border bg-surface-2 p-4 pb-6 shadow-2xl transition-transform duration-200 ${
          open ? "translate-y-0" : "translate-y-full"
        } lg:static lg:inset-auto lg:w-full lg:max-w-md lg:translate-y-0 lg:rounded-2xl lg:border lg:p-5 lg:transition-opacity lg:duration-150 ${
          open ? "lg:opacity-100" : "lg:opacity-0"
        }`}
      >
        <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-border lg:hidden" />
        {children}
      </div>
    </div>
  );
}
```

Notes: at `lg` the panel becomes `static` inside the flex-centered parent (so it sits centered, not pinned to the bottom), `translate-y-0` cancels the mobile slide, and visibility uses opacity; the drag handle is hidden.

- [ ] **Step 2: Verify**

Run: `pnpm typecheck && pnpm lint && pnpm build`. Then `pnpm start` and confirm in a desktop viewport (≥1024px) that opening any sheet (e.g. tap a logged item on `/today`) shows a centered modal, and at ≤480px it remains a bottom sheet. Capture before/after screenshots.

- [ ] **Step 3: Commit**

```bash
git add components/ui/Sheet.tsx
git commit -m "feat: present Sheet as a centered modal on desktop"
```

---

### Task 8: Desktop sidebar + responsive app shell

Add a collapsible `SideNav` shown at `≥lg`, hide the `TabBar` at `≥lg`, and switch the content wrapper to a sidebar + width-capped column layout.

**Files:**
- Create: `components/ui/SideNav.tsx`
- Modify: `components/ui/TabBar.tsx` (hide at `lg`)
- Modify: `app/(app)/layout.tsx` (shell)

**Interfaces:**
- Consumes: `<InstallPrompt />` (Task 6), `<TabBar />`.
- Produces: `<SideNav />` (named export).

- [ ] **Step 1: Implement `components/ui/SideNav.tsx`**

```tsx
"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";

const NAV = [
  { href: "/today", label: "Today", icon: "▦" },
  { href: "/list", label: "List", icon: "☑" },
  { href: "/account", label: "Account", icon: "◔" },
];
const KEY = "ns:nav-collapsed";

// SSR-safe "are we hydrated yet" — no effect. getServerSnapshot => false keeps the
// hydration render identical to the server output (collapsed = false).
const useIsClient = () =>
  useSyncExternalStore(() => () => {}, () => true, () => false);

export function SideNav() {
  const pathname = usePathname();
  const router = useRouter();
  const isClient = useIsClient();
  const [collapsed, setCollapsed] = useState(false);
  const [read, setRead] = useState(false);

  // Apply the persisted collapse value only AFTER hydration (gated on isClient), never
  // during the hydration render — otherwise a collapsed user would hydrate to w-16 while
  // the server emitted w-56, a React 19 hydration mismatch. Render-time set, no effect.
  if (isClient && !read) {
    setRead(true);
    setCollapsed(localStorage.getItem(KEY) === "1");
  }

  const active = (p: string) => pathname === p || pathname.startsWith(p + "/");
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem(KEY, next ? "1" : "0");
  };

  return (
    <nav
      className={`sticky top-0 hidden h-dvh shrink-0 flex-col gap-1 border-r border-border bg-surface-2 p-3 lg:flex ${
        collapsed ? "w-16" : "w-56"
      }`}
    >
      <div className="mb-3 flex items-center justify-between">
        {!collapsed && <span className="px-1 font-bold text-brand">Nutri-Shop</span>}
        <button type="button" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={toggle} className="rounded-md px-2 py-1 text-muted hover:text-text">
          {collapsed ? "»" : "«"}
        </button>
      </div>

      {NAV.map((n) => (
        <Link
          key={n.href}
          href={n.href}
          title={n.label}
          className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm ${active(n.href) ? "bg-surface text-brand" : "text-muted hover:text-text"}`}
        >
          <span className="text-lg leading-none">{n.icon}</span>
          {!collapsed && <span>{n.label}</span>}
        </Link>
      ))}

      <button
        type="button"
        onClick={() => router.push("/add")}
        title="Log food"
        className="mt-auto flex items-center justify-center gap-2 rounded-md bg-brand px-3 py-2 text-sm font-medium text-[#08130b]"
      >
        <span className="text-lg leading-none">＋</span>
        {!collapsed && <span>Log food</span>}
      </button>
    </nav>
  );
}
```

- [ ] **Step 2: Hide the TabBar at `lg`**

In `components/ui/TabBar.tsx`, add `lg:hidden` to the `<nav>` root className (keep all existing classes):

```tsx
<nav className="fixed inset-x-0 bottom-0 z-40 flex items-end justify-around border-t border-border bg-surface-2 px-2 pb-2 pt-2 lg:hidden">
```

- [ ] **Step 3: Update the app shell `app/(app)/layout.tsx`**

```tsx
import type { ReactNode } from "react";
import { requireUser } from "@/lib/dal/session";
import { TabBar } from "@/components/ui/TabBar";
import { SideNav } from "@/components/ui/SideNav";
import { InstallPrompt } from "@/components/ui/InstallPrompt";

export default async function AppLayout({ children }: { children: ReactNode }) {
  await requireUser(); // Gate 2 — server-side, defense in depth beyond proxy.ts
  return (
    <div className="lg:flex">
      <SideNav />
      <div className="mx-auto min-h-dvh w-full max-w-[480px] pb-24 lg:max-w-[1080px] lg:px-8 lg:pb-10">
        {children}
      </div>
      <TabBar />
      <InstallPrompt />
    </div>
  );
}
```

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`. Then `pnpm start`: at ≥1024px the sidebar shows, the bottom tab bar is hidden, the `«`/`»` toggle collapses to a rail and the choice persists across reload; at ≤480px the tab bar returns and the sidebar is hidden. Screenshot both.

- [ ] **Step 5: Commit**

```bash
git add components/ui/SideNav.tsx components/ui/TabBar.tsx "app/(app)/layout.tsx"
git commit -m "feat: add collapsible desktop sidebar and responsive app shell"
```

---

### Task 9: Per-screen desktop reflow (Today / List / Add)

Add `lg:` multi-column grids to the three content-heavy screens. Layout-only; no data or action changes.

**Files:**
- Modify: `app/(app)/today/page.tsx`
- Modify: `app/(app)/list/ListView.tsx`
- Modify: `app/(app)/add/AddView.tsx`

- [ ] **Step 1: Today — meals beside micros at `lg`**

In `app/(app)/today/page.tsx`, wrap `TodayView` + `NutritionPanel` in a two-column grid (DateNav stays full-width on top):

```tsx
  return (
    <main>
      <DateNav date={parsed.data} />
      <div className="lg:grid lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start lg:gap-6">
        <TodayView data={day} />
        <NutritionPanel totals={day.totals} />
      </div>
    </main>
  );
```

- [ ] **Step 2: List — aisle board at `lg`**

In `app/(app)/list/ListView.tsx`, wrap the category `groups.map(...)` block in a responsive grid. Replace:

```tsx
      {groups.map((group) => (
        <section key={group.category} className="mb-4">
```

with a wrapping `<div>`:

```tsx
      <div className="lg:grid lg:grid-cols-2 lg:gap-x-6 xl:grid-cols-3">
      {groups.map((group) => (
        <section key={group.category} className="mb-4">
```

and close the new `<div>` immediately after the groups `.map(...)` closing `))}` (before the `checked.length > 0` block):

```tsx
      ))}
      </div>
```

(The inline-add form, empty state, and the Checked section stay full-width above/below the grid.)

- [ ] **Step 3: Add — 2-column results at `lg`**

In `app/(app)/add/AddView.tsx`, make the results list a 2-column grid at `lg` and drop the single-column dividers there:

```tsx
      <ul className="divide-y divide-border lg:grid lg:grid-cols-2 lg:gap-x-6 lg:divide-y-0">
        {results.map((r) => (
          <li key={r.fdcId} className="lg:border-b lg:border-border">
```

(Keep the `<button>` inside each `<li>` unchanged.)

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`. Then `pnpm start`: at ≥1024px, Today shows meals beside the micros panel, List shows a 2–3 column aisle board, Add shows a 2-column results grid; at ≤480px all three are single-column as before. Screenshot each at both widths.

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/today/page.tsx" "app/(app)/list/ListView.tsx" "app/(app)/add/AddView.tsx"
git commit -m "feat: reflow Today, List, and Add for desktop widths"
```

---

### Task 10: Whole-branch verification, docs, and manual e2e checklist

Final gates across the branch, README update, and the owner's manual verification list.

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Full local gates**

Run, in order, all green:
```bash
pnpm typecheck
pnpm lint
pnpm test
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=build-time-placeholder NEXT_PUBLIC_SITE_URL=http://localhost:3000 SUPABASE_SERVICE_ROLE_KEY=build-time-placeholder pnpm build
```
Confirm `public/sw.js` exists after the build.

- [ ] **Step 2: Update `README.md`**

Add/adjust documentation (integrate into the existing structure — do not duplicate sections):
- Note the app is an **installable PWA** (Android/desktop Chromium install button; iOS via Share → Add to Home Screen) with an offline fallback page; the service worker caches only static assets (no user data).
- Document that the production build is **`next build --webpack`** (Serwist's SW plugin requires webpack; Next 16 defaults to Turbopack). `next dev` is unchanged.
- Document **`pnpm gen:icons`**: regenerates `public/icons/*` from `assets/icon-master.svg` (replace that file to rebrand).

- [ ] **Step 3: Commit docs**

```bash
git add README.md
git commit -m "docs: document PWA install, webpack build, and icon generation"
```

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin phase-4-pwa-desktop
gh pr create --title "Phase 4: PWA install + responsive desktop" --body "<summary of the spec; link the spec + plan>"
```
Confirm on the PR: CI `verify` (lint/typecheck/`pnpm build --webpack`/test) green, CodeQL green, the Vercel preview builds.

- [ ] **Step 5: Manual e2e (owner, after preview/merge deploy)** — not a code step; a checklist to run against the deployed app:
  1. **Build canary:** deployed `/sw.js` returns `200` JS and registers (DevTools → Application → Service Workers). If `404`, Vercel built under Turbopack → set the Build Command to `next build --webpack` and redeploy.
  2. **Install:** Android Chrome/Brave/Edge (native + our button), desktop Chrome/Edge/Brave (URL-bar icon + our button), iPhone Safari (Share → Add to Home Screen via the hint). Each launches standalone with the right icon/name and `#0f1411` theme.
  3. **Offline:** airplane mode → navigation shows the branded `/~offline` page, not the browser error.
  4. **Privacy:** with network on, authed pages always show live data; DevTools → Application → Cache Storage holds **only** static assets + `/~offline` (no authed HTML/JSON).
  5. **Desktop:** sidebar collapse persists; Today/List/Add show the multi-column reflow; sheets are centered modals; resizing below `lg` restores the tab bar + bottom sheets cleanly.

---

## Self-Review

**Spec coverage:** §3.1 build wiring → T4; §3.2 SW → T4; §3.3 manifest → T2; §3.4 icons → T5; §3.5 install UX → T3+T6; §3.6 offline route → T4; §4 security (worker-src/manifest-src/sw.js matcher/`/~offline` public) → T1; §5.1 sidebar/shell → T8; §5.2 responsive Sheet → T7; §5.3 reflow → T9; §6 file list → all tasks; §7 automated tests → T1/T2/T3, manual e2e → T10; §8 risks (webpack build, Vercel build command, SW privacy) → T4/T10. No uncovered spec requirement.

**Placeholder scan:** every code step contains full code; commands have expected output; README step enumerates exact content to add (not "document appropriately"). No TBD/TODO.

**Type consistency:** `buildCsp(nonce, {dev}, supabaseUrl)`, `isPublicPath(pathname)`, `getInstallState({standalone,isIosSafari,canPrompt,dismissed})`, `manifest(): MetadataRoute.Manifest` — names/signatures match between their defining task, their tests, and their consumers (`proxy.ts`, `InstallPrompt`). SW global `__SW_MANIFEST` typed once in `app/sw.ts`.

**Adversarial verification (folded):** a 6-lens + adjudicator workflow reproduced library behavior against the real `serwist@9.5.11` source and the repo toolchain, confirming and fixing four execution-breaking defects: (1) `runtimeCaching: []` never serves `/~offline` → replaced with a `NetworkOnly` navigation route (T4 S3); (2) `tsconfig.sw.json` `TS18003` from inherited `exclude` → added own `exclude` (T4 S4); (3) `pnpm test -- <path>` runs the whole suite / false-green on red steps → dropped `--` everywhere; (4) `SideNav` localStorage-in-render hydration mismatch → `useIsClient` gate (T8 S1). Seven cosmetic findings were ruled non-blocking (caught by the screenshot/e2e gates); two trivial ones (dead `break-inside-avoid`, redundant Today padding) were cleaned up anyway. Spec §3.2/§5.3/§8 reconciled to match.
