/** Convert raw SVG markup into a `data:` URI for use as an `<img src>`.
 *
 *  The MFA QR must be rendered as an <img> — NOT via dangerouslySetInnerHTML. GoTrue
 *  returns the QR as raw SVG whose module colors live in inline `style="fill:..."`
 *  attributes (goqrsvg + svgo). Injected into the page DOM, those inline styles are
 *  stripped by the production CSP (`style-src 'self' 'nonce-...'`, no 'unsafe-inline'),
 *  so every rect falls back to the default black fill and the QR renders solid black.
 *  As an <img> data URI the SVG is an isolated image resource the page's style-src does
 *  not govern, so the fills survive. `img-src` already allows `data:` — no CSP change. */
export function svgToDataUri(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
