import { describe, it, expect } from "vitest";
import { addDays, isValidDateStr, formatDayLabel } from "@/lib/date";

describe("addDays", () => {
  it("advances and rolls over months", () => {
    expect(addDays("2026-06-24", 1)).toBe("2026-06-25");
    expect(addDays("2026-06-30", 1)).toBe("2026-07-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });
});

describe("isValidDateStr", () => {
  it("accepts YYYY-MM-DD and rejects junk", () => {
    expect(isValidDateStr("2026-06-24")).toBe(true);
    expect(isValidDateStr("2026-6-4")).toBe(false);
    expect(isValidDateStr("nope")).toBe(false);
    expect(isValidDateStr("2026-13-01")).toBe(false);
  });
});

describe("formatDayLabel", () => {
  it("says Today/Yesterday/Tomorrow, else a weekday label", () => {
    expect(formatDayLabel("2026-06-24", "2026-06-24")).toBe("Today");
    expect(formatDayLabel("2026-06-23", "2026-06-24")).toBe("Yesterday");
    expect(formatDayLabel("2026-06-25", "2026-06-24")).toBe("Tomorrow");
    expect(formatDayLabel("2026-06-20", "2026-06-24")).toMatch(/Jun 20/);
  });
});
