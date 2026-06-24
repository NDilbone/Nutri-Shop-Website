import { describe, it, expect } from "vitest";
import { formatGrams } from "@/lib/nutrition/display";

describe("formatGrams", () => {
  it("trims trailing zeros", () => {
    expect(formatGrams(150)).toBe("150");
    expect(formatGrams(150.5)).toBe("150.5");
    expect(formatGrams(150.0)).toBe("150");
  });
});
