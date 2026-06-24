import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy-session";

const PUBLIC_PATHS = ["/login", "/signup", "/auth"];

export async function proxy(request: NextRequest) {
  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supaUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
  const isDev = process.env.NODE_ENV === "development";

  // 1) per-request CSP nonce (set on the REQUEST headers so Next stamps scripts)
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const supaWss = supaUrl.replace(/^http/, "ws");
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
    url.pathname = "/today";
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
