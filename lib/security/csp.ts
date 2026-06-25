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
