import { describe, it, expect } from "vitest";
import { svgToDataUri } from "@/lib/auth/qr";

// GoTrue's TOTP qr_code is raw SVG whose module colors live in inline `style="fill:..."`
// attributes. Injected into the page DOM those styles are stripped by the prod CSP
// (style-src nonce-only) — the QR renders solid black. Rendering it as an <img> data URI
// makes it an isolated image resource the page style-src does not govern. This encoder
// must produce a valid, fully percent-encoded data URI that round-trips to the exact SVG.
describe("svgToDataUri", () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">' +
    '<rect width="100" height="100" style="fill:white;stroke:none"/>' +
    '<rect x="10" y="10" width="10" height="10" style="fill:black;stroke:none"/>' +
    "</svg>";

  it("produces an image/svg+xml data URI", () => {
    expect(svgToDataUri(svg)).toMatch(/^data:image\/svg\+xml;utf8,/);
  });

  it("percent-encodes the markup so the payload carries no raw URL-breaking characters", () => {
    const payload = svgToDataUri(svg).replace(/^data:image\/svg\+xml;utf8,/, "");
    expect(payload).not.toContain("<");
    expect(payload).not.toContain(">");
    expect(payload).not.toContain('"');
    expect(payload).not.toContain("#");
  });

  it("round-trips: decoding the payload yields the exact original SVG", () => {
    const payload = svgToDataUri(svg).replace(/^data:image\/svg\+xml;utf8,/, "");
    expect(decodeURIComponent(payload)).toBe(svg);
  });
});
