export const CATEGORIES = [
  "produce", "meat", "dairy", "bakery", "frozen", "pantry", "beverages", "household", "other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABEL: Record<Category, string> = {
  produce: "Produce",
  meat: "Meat & Seafood",
  dairy: "Dairy & Eggs",
  bakery: "Bakery",
  frozen: "Frozen",
  pantry: "Pantry",
  beverages: "Beverages",
  household: "Household",
  other: "Other",
};

export type ShoppingListItem = {
  id: string;
  name: string;
  quantity: string | null;
  category: Category | null;
  fdcId: number | null;
  checked: boolean;
  createdAt: string;
};

export type ItemGroup = { category: Category; items: ShoppingListItem[] };

/** Unchecked items grouped by aisle (non-empty groups, aisle order) + all checked items flat. */
export type GroupedList = { groups: ItemGroup[]; checked: ShoppingListItem[] };
