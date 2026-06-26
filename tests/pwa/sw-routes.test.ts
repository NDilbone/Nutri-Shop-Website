import { describe, it, expect } from "vitest";
import { isListNavigation, isOtherNavigation, type RouteReq } from "@/lib/pwa/sw-routes";

const req = (mode: string, pathname: string): RouteReq => ({
  request: { mode },
  url: { pathname },
});

describe("sw route matchers", () => {
  describe("isListNavigation", () => {
    it("is true for a navigation to /list (the cached, data-free shell)", () => {
      expect(isListNavigation(req("navigate", "/list"))).toBe(true);
    });
    it("is false for a navigation to another route", () => {
      expect(isListNavigation(req("navigate", "/today"))).toBe(false);
    });
    it("is false for a non-navigation request to /list (privacy: only the shell is cached)", () => {
      expect(isListNavigation(req("cors", "/list"))).toBe(false);
    });
  });

  describe("isOtherNavigation", () => {
    it("is true for a navigation to a non-/list route", () => {
      expect(isOtherNavigation(req("navigate", "/today"))).toBe(true);
    });
    it("is false for a navigation to /list (handled by NetworkFirst, not NetworkOnly)", () => {
      expect(isOtherNavigation(req("navigate", "/list"))).toBe(false);
    });
  });
});
