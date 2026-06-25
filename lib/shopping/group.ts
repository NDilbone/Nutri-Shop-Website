import type { Category, GroupedList, ItemGroup, ShoppingListItem } from "@/lib/shopping/types";
import { CATEGORIES } from "@/lib/shopping/types";

const byCreatedAt = (a: ShoppingListItem, b: ShoppingListItem) => a.createdAt.localeCompare(b.createdAt);

export function groupItems(items: ShoppingListItem[]): GroupedList {
  const checked = items.filter((i) => i.checked).sort(byCreatedAt);

  const unchecked = new Map<Category, ShoppingListItem[]>();
  for (const i of items) {
    if (i.checked) continue;
    const cat: Category = i.category ?? "other";
    const arr = unchecked.get(cat) ?? [];
    arr.push(i);
    unchecked.set(cat, arr);
  }

  const groups: ItemGroup[] = [];
  for (const category of CATEGORIES) {
    const arr = unchecked.get(category);
    if (!arr || arr.length === 0) continue;
    arr.sort(byCreatedAt);
    groups.push({ category, items: arr });
  }

  return { groups, checked };
}
