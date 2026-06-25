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
