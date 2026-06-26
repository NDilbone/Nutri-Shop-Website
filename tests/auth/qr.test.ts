import { describe, it, expect } from "vitest";
import { qrCodeImageSrc } from "@/lib/auth/qr";

// GoTrue's TOTP `qr_code` field is ALREADY a complete `data:image/svg+xml` URI in the
// deployed version (confirmed against the live project); older/self-hosted versions return
// raw <svg> markup. The <img> src must use a data: URI VERBATIM — wrapping it again
// percent-encodes the whole "data:..." string, so the image decodes to that literal text
// instead of <svg> and renders a broken image. Raw SVG must be wrapped exactly once.
describe("qrCodeImageSrc", () => {
  it("passes a data: URI through unchanged (no double-wrapping)", () => {
    const dataUri =
      'data:image/svg+xml;utf-8,<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>';
    expect(qrCodeImageSrc(dataUri)).toBe(dataUri);
  });

  it("tolerates leading whitespace before the data: scheme", () => {
    const dataUri = "  data:image/svg+xml,<svg/>";
    expect(qrCodeImageSrc(dataUri)).toBe(dataUri);
  });

  it("wraps raw <svg> markup once into a percent-encoded data: URI", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:black"/></svg>';
    expect(qrCodeImageSrc(svg)).toBe(`data:image/svg+xml,${encodeURIComponent(svg)}`);
  });

  it("wrapped raw SVG round-trips and carries no URL-breaking raw characters", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:black"/></svg>';
    const payload = qrCodeImageSrc(svg).replace(/^data:image\/svg\+xml,/, "");
    expect(payload).not.toContain("<");
    expect(payload).not.toContain("#");
    expect(decodeURIComponent(payload)).toBe(svg);
  });
});
