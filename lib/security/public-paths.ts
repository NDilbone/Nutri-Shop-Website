/** Paths reachable without a session. `/~offline` is the PWA offline fallback —
 *  it must render/precache pre-login and never redirect. */
export const PUBLIC_PATHS = ["/login", "/signup", "/auth", "/~offline"];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}
