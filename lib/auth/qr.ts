/** Resolve GoTrue's TOTP `qr_code` field to an `<img>` src.
 *
 *  The deployed GoTrue returns `qr_code` ALREADY as a complete `data:image/svg+xml` URI;
 *  some (older / self-hosted) versions return raw `<svg>` markup instead. A `data:` URI must
 *  be used VERBATIM — wrapping it again percent-encodes the whole "data:..." string, so the
 *  `<img>` decodes to that literal text instead of `<svg>` and renders a broken image (the
 *  bug this replaces). Raw SVG is wrapped exactly once.
 *
 *  Rendering the QR as an `<img>` (not via `dangerouslySetInnerHTML`) also matters for CSP:
 *  GoTrue colors the SVG with inline `style="fill:..."` attributes, which the production CSP
 *  (`style-src 'self' 'nonce-...'`, no `'unsafe-inline'`) strips when the markup is injected
 *  into the page — rendering the QR solid black. As an image resource those inline styles
 *  survive. `img-src` already allows `data:`, so no CSP change is needed. */
export function qrCodeImageSrc(qrCode: string): string {
  return qrCode.trimStart().startsWith("data:")
    ? qrCode
    : `data:image/svg+xml,${encodeURIComponent(qrCode)}`;
}
