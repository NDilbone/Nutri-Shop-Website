import { ListView } from "./ListView";

// No getItems(): the page renders no list data server-side so its shell is
// cacheable for offline use without storing any authenticated data.
export default function ListPage() {
  return <ListView />;
}
