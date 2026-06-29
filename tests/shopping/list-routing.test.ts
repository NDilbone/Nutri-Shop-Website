import { describe, it, expect } from "vitest";
import { remapUnknownListIds } from "@/lib/shopping/list-routing";

const PERSONAL = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const HOUSEHOLD = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

describe("remapUnknownListIds", () => {
  const known = new Set([PERSONAL, HOUSEHOLD]);

  it("passes through items whose list_id is a known real list", () => {
    const items = [{ list_id: PERSONAL, name: "a" }, { list_id: HOUSEHOLD, name: "b" }];
    expect(remapUnknownListIds(items, known, PERSONAL)).toEqual(items);
  });

  it("rewrites an unknown (client-minted placeholder) list_id to the fallback personal list", () => {
    const items = [{ list_id: "ffffffff-ffff-ffff-ffff-ffffffffffff", name: "x" }];
    expect(remapUnknownListIds(items, known, PERSONAL)).toEqual([{ list_id: PERSONAL, name: "x" }]);
  });

  it("does not mutate the input array or its items", () => {
    const items = [{ list_id: "unknown", name: "x" }];
    const out = remapUnknownListIds(items, known, PERSONAL);
    expect(items[0]!.list_id).toBe("unknown");
    expect(out[0]).not.toBe(items[0]);
  });
});
