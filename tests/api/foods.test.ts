import { describe, it, expect } from "vitest";
import { GET } from "@/app/api/foods/route";

describe("/api/foods stub", () => {
  it("returns 501 Not Implemented", async () => {
    const res = await GET();
    expect(res.status).toBe(501);
  });
});
