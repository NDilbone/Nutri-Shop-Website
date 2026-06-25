"use client";
import Dexie, { type Table } from "dexie";
import { generateContentKey } from "./crypto";

export const EPOCH_CURSOR = "1970-01-01T00:00:00.000Z";

export type StoredItem = {
  id: string;
  listId: string;
  updatedAt: string;     // server time — pull high-water mark
  editedAt: string;      // client time — LWW tiebreak
  deletedAt: string | null;
  dirty: 0 | 1;          // numeric so Dexie can index it
  serverKnown: 0 | 1;
  iv: Uint8Array;
  cipher: ArrayBuffer;
};

type MetaRow = { key: string; value: string };
type KeyRow = { id: string; key: CryptoKey };

export class ListDb extends Dexie {
  items!: Table<StoredItem, string>;
  meta!: Table<MetaRow, string>;
  keyv!: Table<KeyRow, string>;

  constructor(userId: string) {
    super(`ns-list-${userId}`);
    this.version(1).stores({
      items: "id, listId, dirty, updatedAt",
      meta: "key",
      keyv: "id",
    });
  }
}

export function openListDb(userId: string): ListDb {
  return new ListDb(userId);
}

export async function loadOrCreateKey(db: ListDb): Promise<CryptoKey> {
  const existing = await db.keyv.get("aes");
  if (existing) return existing.key;
  const key = await generateContentKey();
  try {
    await db.keyv.put({ id: "aes", key }); // non-extractable CryptoKey stored via structured clone
  } catch (e) {
    throw new Error(
      "This browser cannot persist the encryption key in IndexedDB; offline mode is unavailable. " +
        (e instanceof Error ? e.message : String(e)),
    );
  }
  return key;
}

// Stored-or-freshly-minted default list id. An offline-minted id reconciles to
// the server's real default list on first sync (server get-or-create idempotency
// + the shopping_lists_one_default unique index); a two-tab race is harmless.
export async function getOrInitListId(db: ListDb): Promise<string> {
  const existing = await db.meta.get("defaultListId");
  if (existing) return existing.value;
  const id = crypto.randomUUID();
  await db.meta.put({ key: "defaultListId", value: id });
  return id;
}

export async function deleteListDb(userId: string): Promise<void> {
  await Dexie.delete(`ns-list-${userId}`);
}

export async function deleteForeignDbs(currentUserId: string): Promise<void> {
  // Best-effort: indexedDB.databases() is unavailable in some browsers (notably
  // older iOS Safari). Skip cleanup there; the per-user DB name keeps users isolated.
  const idb = indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> };
  if (typeof idb.databases !== "function") return;
  const dbs = await idb.databases();
  const keep = `ns-list-${currentUserId}`;
  await Promise.all(
    dbs
      .map((d) => d.name)
      .filter((n): n is string => !!n && n.startsWith("ns-list-") && n !== keep)
      .map((n) => Dexie.delete(n)),
  );
}
