// lib/offline/items.ts
"use client";
import type { ListDb, StoredItem } from "./db";
import { encryptContent, decryptContent, type ContentFields } from "./crypto";
import type { Category } from "@/lib/shopping/types";
import type { DisplayItem } from "./lists";

export type AddInput = {
  name: string;
  quantity: string | null;
  category: Category | null;
  fdcId: number | null;
};

function nowIso() {
  return new Date().toISOString();
}

async function writeContent(
  db: ListDb,
  key: CryptoKey,
  base: Pick<StoredItem, "id" | "listId" | "serverKnown" | "updatedAt">,
  content: ContentFields,
  deletedAt: string | null,
): Promise<void> {
  const { iv, cipher } = await encryptContent(key, content);
  const row: StoredItem = {
    ...base,
    editedAt: nowIso(),
    deletedAt,
    dirty: 1,
    iv,
    cipher,
  };
  await db.items.put(row);
}

export async function addLocalItem(
  db: ListDb,
  key: CryptoKey,
  listId: string,
  input: AddInput,
): Promise<void> {
  await writeContent(
    db,
    key,
    { id: crypto.randomUUID(), listId, serverKnown: 0, updatedAt: "1970-01-01T00:00:00.000Z" },
    { name: input.name, quantity: input.quantity, category: input.category, fdcId: input.fdcId, checked: false },
    null,
  );
}

async function mutateContent(
  db: ListDb,
  key: CryptoKey,
  id: string,
  apply: (c: ContentFields) => ContentFields,
  deletedAt?: string | null,
): Promise<void> {
  const row = await db.items.get(id);
  if (!row) return;
  const content = await decryptContent(key, row.iv, row.cipher);
  await writeContent(
    db,
    key,
    { id: row.id, listId: row.listId, serverKnown: row.serverKnown, updatedAt: row.updatedAt },
    apply(content),
    deletedAt === undefined ? row.deletedAt : deletedAt,
  );
}

export async function toggleLocalItem(db: ListDb, key: CryptoKey, id: string, checked: boolean): Promise<void> {
  await mutateContent(db, key, id, (c) => ({ ...c, checked }));
}

export async function editLocalItem(
  db: ListDb,
  key: CryptoKey,
  id: string,
  patch: Partial<Pick<ContentFields, "name" | "quantity" | "category">>,
): Promise<void> {
  await mutateContent(db, key, id, (c) => ({ ...c, ...patch }));
}

export async function deleteLocalItem(db: ListDb, key: CryptoKey, id: string): Promise<void> {
  await mutateContent(db, key, id, (c) => c, nowIso());
}

export async function clearCheckedLocal(db: ListDb, key: CryptoKey, listId: string): Promise<void> {
  const rows = (await db.items.toArray()).filter((r) => r.deletedAt === null && r.listId === listId);
  for (const row of rows) {
    try {
      const content = await decryptContent(key, row.iv, row.cipher);
      if (content.checked) await deleteLocalItem(db, key, row.id);
    } catch {
      await db.items.delete(row.id);
    }
  }
}

export async function moveLocalItem(db: ListDb, key: CryptoKey, id: string, targetListId: string): Promise<void> {
  const row = await db.items.get(id);
  if (!row) return;
  const content = await decryptContent(key, row.iv, row.cipher);
  await writeContent(
    db,
    key,
    { id: row.id, listId: targetListId, serverKnown: row.serverKnown, updatedAt: row.updatedAt },
    content,
    row.deletedAt,
  );
}

export async function displayItems(db: ListDb, key: CryptoKey): Promise<DisplayItem[]> {
  const rows = (await db.items.toArray()).filter((r) => r.deletedAt === null);
  const out: DisplayItem[] = [];
  for (const row of rows) {
    try {
      const c = await decryptContent(key, row.iv, row.cipher);
      out.push({
        id: row.id,
        listId: row.listId,
        name: c.name,
        quantity: c.quantity,
        category: c.category as Category | null,
        fdcId: c.fdcId,
        checked: c.checked,
        createdAt: row.editedAt,
      });
    } catch {
      // fail closed: a row that won't decrypt is dropped and will be re-pulled
      await db.items.delete(row.id);
    }
  }
  return out;
}
