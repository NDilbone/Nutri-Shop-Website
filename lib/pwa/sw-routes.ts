// Pure, node-importable route predicates for the service worker's runtimeCaching.
// Kept free of serwist/webworker imports so they can be unit-tested directly; the
// real SW (app/sw.ts) imports these to drive its NetworkFirst/NetworkOnly matchers.

export type RouteReq = { request: { mode?: string }; url: { pathname: string } };

/** The data-free /list shell navigation — cached (NetworkFirst) so it loads offline. */
export const isListNavigation = ({ request, url }: RouteReq): boolean =>
  request.mode === "navigate" && url.pathname === "/list";

/** Every other navigation — never cached (NetworkOnly); offline falls back to /~offline. */
export const isOtherNavigation = ({ request, url }: RouteReq): boolean =>
  request.mode === "navigate" && url.pathname !== "/list";
