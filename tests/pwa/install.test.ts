import { describe, it, expect } from "vitest";
import { getInstallState } from "@/lib/pwa/install";

const base = { standalone: false, isIosSafari: false, canPrompt: false, dismissed: false };

describe("getInstallState", () => {
  it("hides when already installed/standalone, even if a prompt is available", () => {
    expect(getInstallState({ ...base, standalone: true, canPrompt: true })).toBe("hidden");
  });
  it("hides when the user dismissed the affordance", () => {
    expect(getInstallState({ ...base, dismissed: true, canPrompt: true })).toBe("hidden");
  });
  it("shows the Chromium install button when a deferred prompt exists", () => {
    expect(getInstallState({ ...base, canPrompt: true })).toBe("chromium-button");
  });
  it("shows the iOS hint on iOS Safari with no prompt event", () => {
    expect(getInstallState({ ...base, isIosSafari: true })).toBe("ios-hint");
  });
  it("hides on a non-iOS browser that can't prompt", () => {
    expect(getInstallState(base)).toBe("hidden");
  });
});
