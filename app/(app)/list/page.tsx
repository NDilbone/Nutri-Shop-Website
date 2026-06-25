import { getItems } from "@/lib/dal/shopping-list";
import { ListView } from "./ListView";

export default async function ListPage() {
  const items = await getItems();
  return <ListView initialItems={items} />;
}
