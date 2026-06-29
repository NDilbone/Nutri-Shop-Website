// lib/offline/sync.ts
"use client";
import type { ListDb, StoredItem } from "./db";
import { EPOCH_CURSOR, upsertLocalLists, readLocalLists, deleteListAndItems } from "./db";
import { decryptContent, encryptContent } from "./crypto";
import { toServerItem } from "./payload";
import { reconcile } from "./reconcile";
import { toLocalListMeta, accessibleListIds, listsToPrune, partitionPushable, personalListId } from "./lists";
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
    // 1. Collect + decrypt dirty rows, but only those whose list is still accessible.
    //    A list we lost access to (left/removed) must not poison the push batch — its
    //    dirty rows are dropped here and pruned below.
    const accessibleLocal = accessibleListIds(await readLocalLists(db));
    const bootstrap = accessibleLocal.size === 0;
    const dirtyAll = await db.items.where("dirty").equals(1).toArray();
    // On a brand-new client the lists store is empty (no sync yet); allow all so the
    // first push still works (the server remaps a placeholder id to the personal list).
    const { push: dirty } =
      bootstrap
        ? { push: dirtyAll }
        : partitionPushable(dirtyAll.map((r) => ({ ...r, listId: r.listId })), accessibleLocal);

    const dirtyItems = await Promise.all(
      dirty.map(async (r) => {
        const c = await decryptContent(key, r.iv, r.cipher);
        return toServerItem({
          id: r.id, listId: r.listId, editedAt: r.editedAt, deletedAt: r.deletedAt,
          name: c.name, quantity: c.quantity, category: c.category, fdcId: c.fdcId, checked: c.checked,
        });
      }),
    );

    // 2. Push + pull + accessible lists in one round trip.
    const cursor = await readCursor(db);
    const result = await syncShoppingList({ dirtyItems, cursor, bootstrap });

    // 3. Persist the accessible lists, then prune any local list (and its items) no
    //    longer returned — this is how leave/remove clears a device.
    const localMeta = toLocalListMeta(result.lists);
    await upsertLocalLists(db, localMeta);
    // Converge meta.defaultListId onto the real personal list id (replaces the removed
    // Phase-5 items[0] convergence). Keyed to the PERSONAL list specifically, so
    // getOrInitListId() and the personal add target resolve to the server's real id and
    // post-first-sync personal adds are never stranded under a placeholder id.
    const personalId = personalListId(localMeta);
    if (personalId) await db.meta.put({ key: "defaultListId", value: personalId });
    const accessibleServer = accessibleListIds(result.lists);
    const localIds = (await readLocalLists(db)).map((l) => l.id);
    for (const goneId of listsToPrune(localIds, accessibleServer)) {
      await deleteListAndItems(db, goneId);
    }

    // 4. Clear dirty on pushed rows whose editedAt is unchanged since the snapshot
    //    (Phase-5 invariant — flips reconcile to "overwrite" so the echo can stamp
    //    the server updated_at). Rows dropped in step 1 are skipped naturally.
    await db.transaction("rw", db.items, async () => {
      for (const r of dirty) {
        const cur = await db.items.get(r.id);
        if (cur && cur.editedAt === r.editedAt) {
          await db.items.update(r.id, { dirty: 0, serverKnown: 1 });
        }
      }
    });

    // 5. Reconcile pulled rows (incl. the echo of just-pushed rows).
    await applyServerChanges(db, key, result.items);

    // 6. Advance cursor.
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
  // NOTE: the Phase-5 `meta.defaultListId = items[0].list_id` convergence is removed —
  // the lists store (step 3) is now the source of truth for list ids, and items[0] may
  // belong to the shared list, which would have mis-set the personal default.
}
