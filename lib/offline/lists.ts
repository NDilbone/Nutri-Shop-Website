import type { ListMeta } from "@/lib/dal/shopping-list";
import type { ShoppingListItem } from "@/lib/shopping/types";

export type ListKind = "personal" | "household";
export type LocalListMeta = { id: string; householdId: string | null; name: string; kind: ListKind };

export type DisplayItem = ShoppingListItem & { listId: string };

export function toLocalListMeta(lists: ListMeta[]): LocalListMeta[] {
  return lists.map((l) => ({
    id: l.id,
    householdId: l.householdId,
    name: l.name,
    kind: l.householdId ? "household" : "personal",
  }));
}

export function accessibleListIds(lists: { id: string }[]): Set<string> {
  return new Set(lists.map((l) => l.id));
}

export function listsToPrune(localIds: string[], accessible: Set<string>): string[] {
  return localIds.filter((id) => !accessible.has(id));
}

export function partitionPushable<T extends { listId: string }>(
  dirty: T[],
  accessible: Set<string>,
): { push: T[]; drop: T[] } {
  const push: T[] = [];
  const drop: T[] = [];
  for (const row of dirty) (accessible.has(row.listId) ? push : drop).push(row);
  return { push, drop };
}

export function personalListId(lists: LocalListMeta[]): string | null {
  return lists.find((l) => l.kind === "personal")?.id ?? null;
}

export function householdList(lists: LocalListMeta[]): LocalListMeta | null {
  return lists.find((l) => l.kind === "household") ?? null;
}

export function splitByList(
  items: DisplayItem[],
  personalId: string | null,
  householdId: string | null,
): { personal: DisplayItem[]; household: DisplayItem[] } {
  const personal = items.filter((i) => i.listId === personalId);
  const household = householdId ? items.filter((i) => i.listId === householdId) : [];
  return { personal, household };
}
