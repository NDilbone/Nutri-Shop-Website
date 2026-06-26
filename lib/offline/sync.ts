// lib/offline/sync.ts
"use client";
import type { ListDb, StoredItem } from "./db";
import { EPOCH_CURSOR } from "./db";
import { decryptContent, encryptContent } from "./crypto";
import { toServerItem } from "./payload";
import { reconcile } from "./reconcile";
import { syncShoppingList } from "@/app/(app)/list/actions";
import type { ServerItemRow } from "@/lib/dal/shopping-list";

let inFlight = false;

export async function getDirtyCount(db: ListDb): Promise<number> {
  return db.items.where("dirty").equals(1).count();
}

async function readCursor(db: ListDb): Promise<string> {
  return (await db.meta.get("pullCursor"))?.value ?? EPOCH_CURSOR;
}

export async function runSync(db: ListDb, key: CryptoKey): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    // 1. Collect + decrypt dirty rows.
    const dirty = await db.items.where("dirty").equals(1).toArray();
    const dirtyItems = await Promise.all(
      dirty.map(async (r) => {
        const c = await decryptContent(key, r.iv, r.cipher);
        return toServerItem({
          id: r.id, listId: r.listId, editedAt: r.editedAt, deletedAt: r.deletedAt,
          name: c.name, quantity: c.quantity, category: c.category, fdcId: c.fdcId, checked: c.checked,
        });
      }),
    );

    // 2. Push + pull in one round trip.
    const cursor = await readCursor(db);
    const result = await syncShoppingList({ dirtyItems, cursor });

    // 3. Clear dirty on pushed rows — but ONLY if the row has not been edited
    //    again locally since we snapshotted it (editedAt unchanged). A row edited
    //    mid-sync stays dirty and re-pushes next run. This must NOT rely on the
    //    pulled echo to clear dirty: the echo carries the same edited_at we pushed,
    //    so reconcile() (strict >) would return "keep-local" and dirty would never
    //    clear. Clearing dirty here flips reconcile to the "overwrite" branch so
    //    the echo can stamp the server updated_at onto the row.
    await db.transaction("rw", db.items, async () => {
      for (const r of dirty) {
        const cur = await db.items.get(r.id);
        if (cur && cur.editedAt === r.editedAt) {
          await db.items.update(r.id, { dirty: 0, serverKnown: 1 });
        }
      }
    });

    // 4. Reconcile pulled rows (incl. the echo of just-pushed rows — now dirty:0,
    //    so reconcile overwrites them with the server-stamped updated_at).
    await applyServerChanges(db, key, result.items);

    // 5. Advance cursor.
    await db.meta.put({ key: "pullCursor", value: result.cursor });
  } finally {
    inFlight = false;
  }
}

async function applyServerChanges(db: ListDb, key: CryptoKey, items: ServerItemRow[]): Promise<void> {
  for (const s of items) {
    const local = await db.items.get(s.id);
    const action = reconcile(
      local ? { id: local.id, editedAt: local.editedAt, deletedAt: local.deletedAt, dirty: local.dirty === 1 } : null,
      { id: s.id, editedAt: s.edited_at, deletedAt: s.deleted_at },
    );
    if (action === "keep-local") continue;
    const { iv, cipher } = await encryptContent(key, {
      name: s.name, quantity: s.quantity, category: s.category, fdcId: s.fdc_id, checked: s.checked,
    });
    const row: StoredItem = {
      id: s.id, listId: s.list_id, updatedAt: s.updated_at, editedAt: s.edited_at,
      deletedAt: s.deleted_at, dirty: 0, serverKnown: 1, iv, cipher,
    };
    await db.items.put(row);
  }

  // Converge meta.defaultListId onto the server's real default list id once items
  // are known (replaces any client-minted offline id from getOrInitListId). All of
  // a user's items share the single default list, so this is a stable no-op once
  // converged — it must run unconditionally, not only when nothing is stored yet,
  // or a once-minted offline id stays sticky and never converges.
  const first = items[0];
  if (first !== undefined) {
    await db.meta.put({ key: "defaultListId", value: first.list_id });
  }
}
