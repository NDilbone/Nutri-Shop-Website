import type { ContentFields } from "./crypto";

export type DecryptedRow = ContentFields & {
  id: string;
  listId: string;
  editedAt: string;
  deletedAt: string | null;
};

export type ServerItem = {
  id: string;
  list_id: string;
  name: string;
  quantity: string | null;
  category: string | null;
  fdc_id: number | null;
  checked: boolean;
  deleted_at: string | null;
  edited_at: string;
};

export function toServerItem(row: DecryptedRow): ServerItem {
  return {
    id: row.id,
    list_id: row.listId,
    name: row.name,
    quantity: row.quantity,
    category: row.category,
    fdc_id: row.fdcId,
    checked: row.checked,
    deleted_at: row.deletedAt,
    edited_at: row.editedAt,
  };
}

export function nextCursor(serverUpdatedAts: string[], prevCursor: string): string {
  return serverUpdatedAts.reduce(
    (max, t) => (Date.parse(t) > Date.parse(max) ? t : max),
    prevCursor,
  );
}
