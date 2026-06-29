import { describe, it, expect } from "vitest";
import type { ListMeta } from "@/lib/dal/shopping-list";
import {
  toLocalListMeta, accessibleListIds, listsToPrune, partitionPushable,
  personalListId, householdList,
} from "@/lib/offline/lists";

const P = "11111111-1111-1111-1111-111111111111";
const H = "22222222-2222-2222-2222-222222222222";

describe("offline list helpers", () => {
  const lists: ListMeta[] = [
    { id: P, householdId: null, name: "Shopping list", isDefault: true },
    { id: H, householdId: "hh1", name: "Household list", isDefault: false },
  ];

  it("derives kind from householdId", () => {
    const local = toLocalListMeta(lists);
    expect(local.find((l) => l.id === P)!.kind).toBe("personal");
    expect(local.find((l) => l.id === H)!.kind).toBe("household");
  });

  it("accessibleListIds is the set of returned list ids", () => {
    expect(accessibleListIds(lists)).toEqual(new Set([P, H]));
  });

  it("listsToPrune returns local ids no longer accessible", () => {
    expect(listsToPrune([P, H], new Set([P]))).toEqual([H]); // household revoked
    expect(listsToPrune([P], new Set([P, H]))).toEqual([]);  // nothing to prune
  });

  it("partitionPushable splits dirty rows by current access", () => {
    const dirty = [{ listId: P, id: "a" }, { listId: H, id: "b" }, { listId: "gone", id: "c" }];
    const { push, drop } = partitionPushable(dirty, new Set([P, H]));
    expect(push.map((r) => r.id)).toEqual(["a", "b"]);
    expect(drop.map((r) => r.id)).toEqual(["c"]);
  });

  it("personalListId / householdList select by kind", () => {
    const local = toLocalListMeta(lists);
    expect(personalListId(local)).toBe(P);
    expect(householdList(local)!.id).toBe(H);
    expect(householdList(toLocalListMeta(lists.slice(0, 1)))).toBeNull();
  });
});
