"use client";

import { useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useOffline } from "@/lib/offline/OfflineProvider";
import { getOrInitListId } from "@/lib/offline/db";
import {
  displayItems,
  addLocalItem,
  toggleLocalItem,
  editLocalItem,
  deleteLocalItem,
  clearCheckedLocal,
} from "@/lib/offline/items";
import { groupItems } from "@/lib/shopping/group";
import type { ShoppingListItem } from "@/lib/shopping/types";
import { CATEGORY_LABEL } from "@/lib/shopping/types";
import { ItemSheet, type ItemDraft } from "./ItemSheet";
import { SyncStatus } from "./SyncStatus";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

export function ListView() {
  // All hooks run unconditionally (rules of hooks); branch on status AFTER them.
  const off = useOffline();
  const ready = off.status === "ready" ? off : null;
  const items = useLiveQuery(
    () => (ready ? displayItems(ready.db, ready.cryptoKey) : Promise.resolve([])),
    [ready],
    [],
  );

  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<ShoppingListItem | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  if (off.status !== "ready") {
    return (
      <SyncStatus
        online={off.online}
        syncing={false}
        pending={0}
        error={off.status === "error" ? off.error : undefined}
      />
    );
  }

  const { db, cryptoKey, online, syncing, pending, sync } = off;
  const { groups, checked } = groupItems(items ?? []);

  async function withSync(fn: () => Promise<void>) {
    await fn();
    sync();
  }

  const onAdd = (input: IdemDraft) =>
    withSync(async () =>
      addLocalItem(db, cryptoKey, await getOrInitListId(db), {
        name: input.name,
        quantity: input.quantity.trim() || null,
        category: input.category || null,
        fdcId: null,
      }),
    );

  const onToggle = (id: string, checked: boolean) =>
    withSync(() => toggleLocalItem(db, cryptoKey, id, checked));

  const onEdit = (id: string, patch: ItemDraft) =>
    withSync(() =>
      editLocalItem(db, cryptoKey, id, {
        name: patch.name,
        quantity: patch.quantity.trim() || null,
        category: patch.category || null,
      }),
    );

  const onDelete = (id: string) => withSync(() => deleteLocalItem(db, cryptoKey, id));

  const onClearChecked = () => withSync(() => clearCheckedLocal(db, cryptoKey));

  function addInline(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setNewName("");
    inputRef.current?.focus();
    void onAdd({ name, quantity: "", category: "" });
  }

  async function saveEdit(draft: ItemDraft) {
    if (!editing) return;
    await onEdit(editing.id, draft);
  }

  async function removeEditing() {
    if (!editing) return;
    await onDelete(editing.id);
  }

  return (
    <main className="p-4">
      <div className="mb-3 flex items-start justify-between">
        <h1 className="text-lg font-semibold">Shopping list</h1>
        <SyncStatus online={online} syncing={syncing} pending={pending} />
      </div>

      <form onSubmit={addInline} className="mb-4 flex gap-2">
        <Input
          ref={inputRef}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Add item…"
          aria-label="Add item"
        />
        <button
          type="submit"
          aria-label="Add"
          className="shrink-0 rounded-md bg-brand px-4 text-lg font-light text-[#08130b]"
        >
          +
        </button>
      </form>

      {groups.length === 0 && checked.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted">Nothing on the list yet.</p>
      ) : null}

      <div className="lg:grid lg:grid-cols-2 lg:gap-x-6 xl:grid-cols-3">
        {groups.map((group) => (
          <section key={group.category} className="mb-4">
            <h2 className="mb-1 text-[11px] uppercase tracking-wide text-muted">
              {CATEGORY_LABEL[group.category]}
            </h2>
            <ul className="divide-y divide-border/50">
              {group.items.map((item) => (
                <li key={item.id} className="flex items-center gap-3 py-2.5">
                  <Checkbox
                    checked={item.checked}
                    onChange={() => void onToggle(item.id, !item.checked)}
                    label={`Check ${item.name}`}
                  />
                  <button
                    type="button"
                    onClick={() => setEditing(item)}
                    className="flex flex-1 justify-between text-left text-sm"
                  >
                    <span>{item.name}</span>
                    {item.quantity ? <span className="text-muted">{item.quantity}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      {checked.length > 0 ? (
        <section className="mb-4">
          <h2 className="mb-1 text-[11px] uppercase tracking-wide text-muted">Checked</h2>
          <ul className="divide-y divide-border/50">
            {checked.map((item) => (
              <li key={item.id} className="flex items-center gap-3 py-2.5">
                <Checkbox
                  checked={item.checked}
                  onChange={() => void onToggle(item.id, !item.checked)}
                  label={`Uncheck ${item.name}`}
                />
                <button
                  type="button"
                  onClick={() => setEditing(item)}
                  className="flex flex-1 justify-between text-left text-sm text-muted line-through"
                >
                  <span>{item.name}</span>
                  {item.quantity ? <span>{item.quantity}</span> : null}
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-3">
            <Button variant="ghost" onClick={() => void onClearChecked()}>
              Clear checked
            </Button>
          </div>
        </section>
      ) : null}

      <ItemSheet
        open={editing !== null}
        onClose={() => setEditing(null)}
        mode="edit"
        item={editing}
        onSubmit={saveEdit}
        onDelete={removeEditing}
      />
    </main>
  );
}

// Local alias matching ItemDraft shape used for inline-add
type IdemDraft = { name: string; quantity: string; category: "" };
