/// <reference lib="webworker" />
import { Serwist, NetworkOnly, NetworkFirst } from "serwist";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { isListNavigation, isOtherNavigation } from "@/lib/pwa/sw-routes";

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
  runtimeCaching: [
    {
      // Data-free /list shell: cache it so the page loads offline. It contains no
      // authenticated data (the page renders none server-side); list data comes
      // from the encrypted IndexedDB store at runtime.
      matcher: isListNavigation,
      handler: new NetworkFirst({ cacheName: "list-shell" }),
    },
    {
      // PRIVACY INVARIANT: NetworkOnly writes nothing to the cache — no authed HTML/JSON
      // is ever stored. This route exists ONLY so the fallback plugin (which serwist
      // attaches per runtimeCaching entry) has a strategy whose handlerDidError fires
      // offline and serves the precached /~offline page. An empty runtimeCaching array
      // would never serve the fallback.
      // All other navigations: never cached; offline falls back to /~offline.
      matcher: isOtherNavigation,
      handler: new NetworkOnly(),
    },
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
