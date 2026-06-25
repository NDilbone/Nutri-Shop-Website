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
