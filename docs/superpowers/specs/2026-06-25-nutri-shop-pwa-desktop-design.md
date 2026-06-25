# Nutri-Shop — Phase 4: PWA install + responsive desktop (design)

**Date:** 2026-06-25
**Author:** NDilbone
**Status:** Approved design, pending implementation plan
**Predecessor:** [`2026-06-24-nutri-shop-shopping-list-design.md`](./2026-06-24-nutri-shop-shopping-list-design.md) (Phase 3) · [`2026-06-24-nutri-shop-macro-tracker-design.md`](./2026-06-24-nutri-shop-macro-tracker-design.md) (Phase 2) · [`2026-06-24-nutri-shop-usda-food-search-design.md`](./2026-06-24-nutri-shop-usda-food-search-design.md) (Phase 1) · foundation [`2026-06-23-nutri-shop-foundation-design.md`](./2026-06-23-nutri-shop-foundation-design.md)

**Scope of this spec:** roadmap Phase 4. Two coupled deliverables that together make Nutri-Shop "a real app you install," not just a website:

1. **PWA install + offline shell** — make the app installable on Android, iOS, and desktop Chromium (Chrome/Edge/Brave) via a web manifest + a service worker, with a branded offline fallback page. The service worker is deliberately kept **out of all authenticated / API / REST caching** (precaches static build assets only). Real offline *data* and sync stay in Phase 5.
2. **Responsive desktop layout** — the phone-first ≤480px column becomes a true desktop app on wide screens: a collapsible left sidebar (replacing the bottom tab bar), a width-capped multi-column content area, and pop-up sheets that present as centered modals instead of bottom sheets. The phone layout is unchanged.

These ship together because "install it on my desktop" is only worth doing if the installed window is actually usable at desktop width.

---

## 1. Goal & non-goals

### Goal
A logged-in, invited user can **install** Nutri-Shop to their home screen / desktop and launch it in its own standalone window on any of their devices — your Android phone, your desktop (Chrome/Edge/Brave), and your fiancé's iPhone — and have it look and feel native on each: a phone column with a bottom tab bar on mobile, a sidebar-driven multi-column app on desktop. Opening the app with no network shows a branded "You're offline" screen, never the browser's error page. No user data is cached by the service worker.

### Non-goals (Phase 4 — deferred)
- **Offline data + sync** (Dexie local store, outbox, last-write-wins) — **Phase 5.** Phase 4 makes the app *installable and shell-cacheable*, but logging food and editing the list still require the network. The schema already carries client-mintable UUID / `updated_at` / `deleted_at` for Phase 5; nothing here pre-empts it.
- **Caching of authenticated pages, RSC payloads, or `/api` responses** in the service worker — explicitly out, this phase and as a standing rule until Phase 5 designs a privacy-safe data cache. See §4.
- **Push notifications / background sync / periodic sync** — later, gated behind a real use case and Phase 6 hardening.
- **A desktop-only feature set** (keyboard shortcuts, multi-pane "dashboard" overview at `/dashboard`) — the responsive work here re-flows the *existing* screens; the `/dashboard` overview remains a separate roadmap item.
- **`beforeinstallprompt` A/B nudges, install analytics, engagement heuristics** — the install affordance is a simple, dismissible button/hint, not a campaign.
- **Light theme / theming** — still deferred; Phase 4 is dark-editorial only.
- **MFA, in-app invite admin, shared/household list** — Phase 6.

---

## 2. Decisions locked

| # | Decision | Rationale |
|---|----------|-----------|
| PWA toolkit | **`@serwist/next` + `serwist` `9.5.11`** (latest stable; `10.0.0` is preview-only). | Serwist is the maintained successor to next-pwa/Workbox for the App Router; the foundation spec already reserved this exact version. |
| SW caching | **Minimal precache + NetworkOnly + offline fallback.** Precache static build assets only; navigations are NetworkOnly with a precached `/~offline` fallback; API/REST/RSC/auth are NetworkOnly. | The roadmap rule is "SW kept out of auth/REST caching." A private multi-user app must never serve one user's cached authed HTML/JSON to another on a shared install. Rejected Serwist's stock `defaultCache` (NetworkFirst-caches pages, RSC, and `/api` GETs → stale + cross-user leakage risk). |
| Offline UX | **Branded `/~offline` page**, public + static, zero user data. | Installability + a real "you're offline" screen, without caching anything private. |
| Icons | **Owner-supplied master art** at `assets/icon-master.svg` (or a ≥512px PNG) → a `gen:icons` script (using `sharp`, already an approved build dep) emits all sizes into `public/icons/`; outputs are committed. | The owner wants to supply the artwork. Committing the generated outputs keeps CI/Vercel art-free and deterministic. |
| Install affordance | **`beforeinstallprompt`-driven button on Chromium** (Android + desktop) + a **dismissible iOS Safari hint** (Share → Add to Home Screen). Hidden when already installed / running standalone. | Owner is on Android + desktop Chromium (event fires; the native desktop affordance is a tiny address-bar icon that's easy to miss → a visible button matters). Fiancé is on iPhone (no event → manual hint is the only path). |
| Desktop shell | **Labeled left sidebar, collapsible to an icon rail; collapse state persisted in `localStorage`.** Sidebar appears at `≥lg`; the phone bottom tab bar is untouched below `lg`. | Owner's pick. A daily-use desktop app reads better with labels; a collapse gives back width on demand. |
| Content width | Desktop content area **capped ~1080px, centered**; phone stays full-width ≤480. | Avoids an unreadable full-bleed stretch on wide/ultra-wide monitors. |
| Overlays | The existing **`Sheet` becomes responsive**: bottom sheet on phone, **centered modal** on `≥lg`. One change upgrades every consumer (item add/edit, quick-add, food detail). | Owner picked centered modal. Doing it in the shared primitive avoids touching each call site and keeps behavior consistent. |
| Per-screen reflow | At `≥lg`: **Today** = full-width headline macros over a meals-beside-micros two-column; **List** = 2–3 column aisle board; **Add** = 2-column USDA results grid; **Account** = unchanged narrow column. | Uses the horizontal space where it helps (lists, results, side panels) and leaves simple screens alone. |
| Breakpoint | Single **`lg` (1024px)** switch for sidebar + modal + multi-column. Tailwind v4 default `lg`. | One predictable breakpoint; tablets land in the phone layout (a wide centered column), which is fine. |

---

## 3. PWA architecture

### 3.1 Build wiring
`next.config.ts` is wrapped with `withSerwist` from `@serwist/next`:

```ts
import withSerwistInit from "@serwist/next";

const withSerwist = withSerwistInit({
  swSrc: "app/sw.ts",
  swDest: "public/sw.js",
  // SW enabled in dev too, so install + offline can be exercised locally.
  disable: false,
  // reloadOnOnline default; cacheOnNavigation NOT used (NetworkOnly navigations).
});

export default withSerwist(nextConfig);
```

The existing `headers()` block and `reactStrictMode` are preserved; `withSerwist` wraps the final config object.

### 3.2 Service worker (`app/sw.ts`)
A single TypeScript SW compiled by Serwist:

```ts
import { Serwist } from "serwist";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}
declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,   // static build assets only
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [],                     // <-- nothing dynamic is cached
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

Key invariants:
- **`runtimeCaching: []`** — no runtime caches at all. Navigations and fetches go to the network; only the precache (static assets) and the `/~offline` fallback are served from the SW.
- `__SW_MANIFEST` is injected by Serwist at build time and contains only built static assets (`_next/static/*`, fonts, the committed icons, the precached `/~offline` document). It does **not** include authenticated route HTML.
- `skipWaiting`/`clientsClaim` so an updated SW takes over promptly (acceptable: there is no cached private data to invalidate).

### 3.3 Manifest (`app/manifest.ts`)
Next.js typed metadata route → emitted at `/manifest.webmanifest` (already excluded from the `proxy.ts` matcher):

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
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    // screenshots: optional, added if captured (wide + narrow) for a richer install dialog.
  };
}
```

`orientation: "portrait"` is a hint, not a lock; desktop windows ignore it. `start_url: "/today"` lands an installed user on their primary surface (proxy redirects to `/login` if the session is gone — expected).

### 3.4 Icons (`assets/icon-master.*` → `public/icons/`)
- Owner drops a master at `assets/icon-master.svg` (preferred) or a square PNG ≥512px.
- A Node script `scripts/gen-icons.mjs` (invoked via `pnpm gen:icons`) uses `sharp` to produce: `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` (master centered on a `#0f1411` safe-area padded canvas so maskable crop never clips), `apple-touch-icon-180.png`, and `favicon.ico`.
- Generated files are **committed**. CI and Vercel never run the generator (no art in the pipeline). Re-running `gen:icons` after swapping the master regenerates them.
- **This is the only task gated on owner input.** Everything else proceeds without the art; a placeholder master can unblock the build and be swapped later with no code change.

### 3.5 Install UX (`components/ui/InstallPrompt.tsx`, client)
One client component, mounted once in the app shell. Three mutually exclusive states:

1. **Already installed / standalone** (`window.matchMedia("(display-mode: standalone)").matches` or iOS `navigator.standalone`): render nothing.
2. **Chromium installable** — listen for `beforeinstallprompt`, `preventDefault()`, stash the event; render an **Install Nutri-Shop** affordance (a sidebar item on desktop, a slim dismissible banner on mobile). Click → `evt.prompt()`; on `appinstalled` (or after the user dismisses) hide it. Dismissal persisted in `localStorage`.
3. **iOS Safari, not standalone** (iOS UA + no `beforeinstallprompt` support) — render a dismissible hint: "Install: tap Share → Add to Home Screen." Dismissal persisted in `localStorage`.

No analytics, no re-nudging beyond the persisted dismissal.

### 3.6 Offline route (`app/~offline/page.tsx`)
- A folder literally named `~offline` → route `/~offline`. Lives **outside** the `(app)` group so it has **no `requireUser()` gate**, and is added to `PUBLIC_PATHS` in `proxy.ts` so it precaches cleanly even pre-login.
- Pure static, server-rendered, **no data fetching**: brand mark, "You're offline", a one-line "Reconnect to log food and update your list", and a **Retry** button. The page is a Server Component; the Retry button is a tiny client island that calls `location.reload()`. Uses existing dark-editorial tokens.
- Serwist precaches this document; the SW serves it for any failed document navigation.

---

## 4. Security plumbing (load-bearing)

The CSP is strict (per-request nonce + `strict-dynamic`), set on the **request** header in `proxy.ts`. The SW interacts with it in two ways that will silently break the PWA if missed:

| Change | Where | Why |
|--------|-------|-----|
| Add **`worker-src 'self'`** to the CSP directive list. | `proxy.ts` `csp` array | With `script-src ... 'strict-dynamic'`, the `'self'` source is **ignored** for worker script loading, and there is currently no `worker-src`, so it falls back to `script-src` → the SW (`/sw.js`) is blocked. An explicit `worker-src 'self'` is required. |
| Make **`manifest-src 'self'`** explicit. | `proxy.ts` `csp` array | Today the manifest is allowed only via `default-src 'self'`. Explicit is clearer and future-proof. |
| Exclude **`sw.js`** (and Serwist's dev worker file) from the proxy **matcher** negative-lookahead, alongside the existing `manifest.webmanifest`. | `proxy.ts` `config.matcher.source` | An unauthenticated request for `/sw.js` currently matches the proxy → gets redirected to `/login` → registration receives HTML, not JS → the SW never installs. The SW file must bypass auth gating. |
| Add **`/~offline`** to `PUBLIC_PATHS`. | `proxy.ts` | So the offline fallback renders/precaches without a session and never redirects. |

The SW **registration script** that `@serwist/next` injects is emitted through Next's script pipeline, which stamps it with the per-request nonce (the same mechanism `app/layout.tsx` already keeps the layout dynamic for). No inline-script relaxation is introduced.

The service worker scope is the origin root (`/`); it is served from `public/sw.js` as a static asset (`script-src 'self'` via `worker-src 'self'`). No third-party origins are added to any CSP directive.

---

## 5. Responsive desktop layout

The phone layout is the baseline and **does not change**. Everything below is additive, gated at `lg` (1024px) with Tailwind utilities.

### 5.1 Shell (`app/(app)/layout.tsx` + new `components/ui/SideNav.tsx`)
- Below `lg`: render the existing `TabBar` (bottom). Content wrapper stays `max-w-[480px]` centered with `pb-24`.
- At `≥lg`: render `SideNav` (fixed left). Content wrapper becomes a flex row: sidebar + a `max-w-[1080px]` centered content column, no bottom padding (no tab bar).
- `SideNav` (client): brand wordmark, nav items (Today / List / Account) with active state mirroring `TabBar`, a primary **＋ Log food** action, the **Install** affordance slot (§3.5), and a **collapse chevron**. Collapsed = icon-only rail (~64px), labels via `title`/tooltip; expanded = ~220px labeled. Collapse state read/written to `localStorage` (`ns:nav-collapsed`), applied at render time (no layout-shift effect loop — follows the project's render-time-state rule, **no `useEffect` for derived state**).
- The center **＋** behavior is preserved: on desktop the sidebar **＋ Log food** routes to `/add`; the "Add to list" path remains reachable (chooser opens as a centered modal on desktop via the responsive `Sheet`).

Both nav surfaces render in the layout; CSS (`lg:hidden` / `hidden lg:flex`) decides which is visible. No JS user-agent branching for layout.

### 5.2 Responsive `Sheet` (`components/ui/Sheet.tsx`)
- Refactor the single `Sheet` primitive: below `lg` it renders as today (bottom sheet, slide-up, full-width, rounded top). At `≥lg` it renders as a **centered modal** (max-width ~480px, centered, rounded, drop shadow) over the same dimmed backdrop.
- Same props, same `open`/`onClose` contract, same focus-trap/escape/scrim-click behavior. Consumers (`ItemSheet`, `QuickAddSheet`, the USDA food-detail sheet) are unchanged — they inherit the desktop modal automatically.
- Purely presentational change (Tailwind responsive classes on the panel container); no behavioral or accessibility regression.

### 5.3 Per-screen reflow (CSS only, `≥lg`)
- **Today** (`TodayView`): headline macro `StatTile`s stay full-width on top; below, a two-column grid — meals list (wider, ~3fr) beside the micros/`NutritionPanel` (~2fr). One column on phone.
- **List** (`ListView`): the aisle-category groups become a responsive multi-column board (`columns`/grid, 2 at `lg`, 3 at `xl`); the inline **Add item** row spans full width on top; **Clear checked** stays in the header. One column on phone.
- **Add** (`AddView`): the USDA search input spans full width; results render as a 2-column grid at `≥lg`. One column on phone.
- **Account**: unchanged narrow centered column.

No data-flow, Server Action, or query changes — these are layout-only edits to existing client components.

---

## 6. Components & files

**New**
- `app/sw.ts` — service worker source.
- `app/manifest.ts` — typed web manifest.
- `app/~offline/page.tsx` — offline fallback route (public, static).
- `components/ui/SideNav.tsx` — desktop sidebar (client, collapsible).
- `components/ui/InstallPrompt.tsx` — install button + iOS hint (client).
- `scripts/gen-icons.mjs` — `sharp` icon generator (`pnpm gen:icons`).
- `assets/icon-master.svg` — owner-supplied master (placeholder until provided).
- `public/icons/*`, `public/favicon.ico` — committed generated outputs.

**Modified**
- `next.config.ts` — wrap with `withSerwist`.
- `proxy.ts` — `worker-src`/`manifest-src` CSP, `sw.js` matcher exclusion, `/~offline` public.
- `app/layout.tsx` — PWA `<head>` meta (`theme-color`, `apple-mobile-web-app-*`, `apple-touch-icon`, `apple-mobile-web-app-title`).
- `InstallPrompt` is mounted once in `app/(app)/layout.tsx` (the authenticated shell), so it surfaces for logged-in users across both nav surfaces; it self-hides when standalone/installed.
- `app/(app)/layout.tsx` — responsive shell (TabBar ↔ SideNav, content width).
- `components/ui/Sheet.tsx` — responsive bottom-sheet ↔ modal.
- `app/(app)/today/TodayView.tsx`, `app/(app)/list/ListView.tsx`, `app/(app)/add/AddView.tsx` — `lg` multi-column reflow.
- `package.json` — deps (`@serwist/next`, `serwist`, `sharp`), `gen:icons` script.
- `pnpm-workspace.yaml` — `sharp` already in `allowBuilds` (confirm); add nothing new unless a new native dep appears.
- `.gitignore` — ensure `public/sw.js` and Serwist build artifacts (`public/swe-worker-*.js`) are ignored (generated at build), while `public/icons/*` stay committed.

---

## 7. Testing

**Automated (Vitest, offline-safe):**
- `manifest.ts`: returns required fields; `theme_color`/`background_color` = `#0f1411`; `start_url` = `/today`; includes a maskable icon.
- `proxy.ts` / `headers.test.ts` (extend existing): CSP contains `worker-src 'self'` and `manifest-src 'self'`; the matcher source excludes `sw.js`; `/~offline` is treated as public (no redirect).
- `InstallPrompt`: renders the iOS hint under a simulated iOS-Safari-non-standalone environment; renders the install button when a `beforeinstallprompt` event is dispatched; renders nothing in standalone; respects the persisted dismissal flag.
- `Sheet`: renders bottom-sheet classes below `lg` and modal classes at `≥lg` (class-presence assertion via matchMedia mock); `open`/`onClose` contract unchanged.
- `SideNav`: active-state matches pathname; collapse state initializes from `localStorage` without an effect loop.

**Manual e2e (owner, against the deployed app):**
- Install on **Android Chrome/Brave/Edge** (native mini-infobar **and** our Install button), **desktop Chrome/Edge/Brave** (URL-bar icon **and** our sidebar Install button), and **iPhone Safari** (Share → Add to Home Screen following the hint). Each launches standalone with the correct icon, name, and `#0f1411` theme color.
- **Airplane mode** → launching / navigating shows the branded `/~offline` page, not the browser error.
- **Privacy check:** log in as user A, install, then with the network on confirm authenticated pages always reflect live data (NetworkOnly) — nothing stale is served from the SW; DevTools → Application → Cache Storage shows **only static assets + `/~offline`**, no authed HTML/JSON.
- **Desktop layout:** sidebar collapse persists across reloads; Today/List/Add show their multi-column reflow at desktop width; overlays present as centered modals; resizing below `lg` returns the bottom tab bar + bottom sheets with no broken state.

---

## 8. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| SW caches authenticated content → cross-user leak on a shared install. | `runtimeCaching: []`; navigations/API are NetworkOnly; automated assertion that Cache Storage holds only static + `/~offline`; manual privacy check in §7. **This is the phase's primary invariant.** |
| CSP silently blocks the SW (`strict-dynamic` ignores `'self'` for workers). | Explicit `worker-src 'self'` (§4) + a test asserting its presence. |
| Unauthenticated `/sw.js` request redirected to `/login` → SW never installs. | `sw.js` excluded from the proxy matcher (§4) + a matcher test. |
| Stale SW serves an old shell after a deploy. | `skipWaiting` + `clientsClaim`; no private data cached so activation is safe; `reloadOnOnline`. |
| Maskable icon crops the logo. | `gen-icons.mjs` pads the master onto a safe-area `#0f1411` canvas for the maskable variant. |
| Desktop redesign regresses the phone layout. | All desktop rules are `lg:`-gated additive utilities; phone classes untouched; resize check in e2e. |
| Bigger scope than prior single-concern phases (PWA + redesign). | Two clean parts with no shared data layer; PWA is config/SW/manifest, the redesign is layout-only CSS in existing components — independently reviewable; the implementation plan sequences them so either could land alone if needed. |
| `serwist` `10.0.0` tempts an upgrade. | Pinned to `9.5.11` (latest **stable**); `10.x` is preview-only — revisit when it GAs. |

---

## 9. Open items (non-blocking)
- **Owner art** for `assets/icon-master.svg` — placeholder until provided; swap is code-free.
- **Manifest `screenshots`** (wide + narrow) for a richer Chromium install dialog — captured from the running app if feasible; skipped without blocking.
- A future **`/dashboard`** whole-account overview (separate roadmap item) will benefit from this desktop shell but is not in Phase 4.
