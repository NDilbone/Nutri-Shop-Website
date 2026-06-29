"use client";

import { useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useOffline } from "@/lib/offline/OfflineProvider";
import { getOrInitListId, readLocalLists } from "@/lib/offline/db";
import {
  displayItems, addLocalItem, toggleLocalItem, editLocalItem, deleteLocalItem,
  clearCheckedLocal, moveLocalItem,
} from "@/lib/offline/items";
import { personalListId as pickPersonalId, householdList as pickHousehold, splitByList, type DisplayItem } from "@/lib/offline/lists";
import { groupItems } from "@/lib/shopping/group";
import { CATEGORY_LABEL } from "@/lib/shopping/types";
import { ItemSheet, type ItemDraft } from "./ItemSheet";
import { SyncStatus } from "./SyncStatus";
import { PendingInviteBanner } from "./PendingInviteBanner";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

export function ListView() {
  const off = useOffline();
  const ready = off.status === "ready" ? off : null;
  const items = useLiveQuery(
    () => (ready ? displayItems(ready.db, ready.cryptoKey) : Promise.resolve([] as DisplayItem[])),
    [ready],
    [] as DisplayItem[],
  );
  const lists = useLiveQuery(() => (ready ? readLocalLists(ready.db) : Promise.resolve([])), [ready], []);

  const [editing, setEditing] = useState<DisplayItem | null>(null);

  if (off.status !== "ready") {
    return (
      <main className="p-4">
        <SyncStatus online={off.online} syncing={false} pending={0} error={off.status === "error" ? off.error : undefined} />
      </main>
    );
  }

  const { db, cryptoKey, online, syncing, pending, sync } = off;
  const personalId = pickPersonalId(lists ?? []);
  const household = pickHousehold(lists ?? []);
  const { personal, household: householdItems } = splitByList(items ?? [], personalId, household?.id ?? null);

  const withSync = async (fn: () => Promise<void>) => { await fn(); sync(); };

  const addTo = (listIdPromise: Promise<string> | string, draft: { name: string; quantity: string; category: string }) =>
    withSync(async () =>
      addLocalItem(db, cryptoKey, await listIdPromise, {
        name: draft.name, quantity: draft.quantity.trim() || null,
        category: (draft.category || null) as DisplayItem["category"], fdcId: null,
      }),
    );

  const onToggle = (id: string, checked: boolean) => withSync(() => toggleLocalItem(db, cryptoKey, id, checked));
  const onClear = (listId: string) => withSync(() => clearCheckedLocal(db, cryptoKey, listId));
  const onMove = (id: string, listId: string) => withSync(() => moveLocalItem(db, cryptoKey, id, listId));

  async function saveEdit(draft: ItemDraft) {
    if (!editing) return;
    await withSync(() => editLocalItem(db, cryptoKey, editing.id, {
      name: draft.name, quantity: draft.quantity.trim() || null, category: draft.category || null,
    }));
  }
  async function removeEditing() {
    if (!editing) return;
    await withSync(() => deleteLocalItem(db, cryptoKey, editing.id));
  }

  return (
    <main className="p-4">
      <div className="mb-3 flex items-start justify-between">
        <h1 className="text-lg font-semibold">Shopping list</h1>
        <SyncStatus online={online} syncing={syncing} pending={pending} />
      </div>

      <PendingInviteBanner online={online} />

      <ListSection
        title="Personal"
        items={personal}
        onAddName={(name) => addTo(personalId ?? getOrInitListId(db), { name, quantity: "", category: "" })}
        onToggle={onToggle}
        onClear={() => { if (!personalId) return; void onClear(personalId); }}
        onOpen={setEditing}
      />

      {household ? (
        <ListSection
          title={`Household · ${household.name}`}
          items={householdItems}
          onAddName={(name) => addTo(household.id, { name, quantity: "", category: "" })}
          onToggle={onToggle}
          onClear={() => onClear(household.id)}
          onOpen={setEditing}
        />
      ) : null}

      <ItemSheet
        open={editing !== null}
        onClose={() => setEditing(null)}
        mode="edit"
        item={editing}
        onSubmit={saveEdit}
        onDelete={removeEditing}
        canMove={household !== null}
        moveTargetLabel={editing && editing.listId === household?.id ? "Move to Personal" : "Move to Household"}
        onMove={editing ? () => {
          const targetId = editing.listId === household?.id ? (personalId ?? "") : (household?.id ?? "");
          if (!targetId) return;
          void onMove(editing.id, targetId);
        } : undefined}
      />
    </main>
  );
}

function ListSection({
  title, items, onAddName, onToggle, onClear, onOpen,
}: {
  title: string;
  items: DisplayItem[];
  onAddName: (name: string) => Promise<void> | void;
  onToggle: (id: string, checked: boolean) => Promise<void> | void;
  onClear: () => Promise<void> | void;
  onOpen: (item: DisplayItem) => void;
}) {
  const [newName, setNewName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { groups, checked } = groupItems(items);

  function addInline(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setNewName("");
    inputRef.current?.focus();
    void onAddName(name);
  }

  return (
    <section className="mb-6">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{title}</h2>

      <form onSubmit={addInline} className="mb-3 flex gap-2">
        <Input ref={inputRef} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Add item…" aria-label={`Add item to ${title}`} />
        <button type="submit" aria-label="Add" className="shrink-0 rounded-md bg-brand px-4 text-lg font-light text-[#08130b]">+</button>
      </form>

      {groups.length === 0 && checked.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">Nothing here yet.</p>
      ) : null}

      {groups.map((group) => (
        <div key={group.category} className="mb-3">
          <h3 className="mb-1 text-[11px] uppercase tracking-wide text-muted">{CATEGORY_LABEL[group.category]}</h3>
          <ul className="divide-y divide-border/50">
            {group.items.map((item) => (
              <li key={item.id} className="flex items-center gap-3 py-2.5">
                <Checkbox checked={item.checked} onChange={() => void onToggle(item.id, !item.checked)} label={`Check ${item.name}`} />
                <button type="button" onClick={() => onOpen(item as DisplayItem)} className="flex flex-1 justify-between text-left text-sm">
                  <span>{item.name}</span>
                  {item.quantity ? <span className="text-muted">{item.quantity}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {checked.length > 0 ? (
        <div className="mb-2">
          <h3 className="mb-1 text-[11px] uppercase tracking-wide text-muted">Checked</h3>
          <ul className="divide-y divide-border/50">
            {checked.map((item) => (
              <li key={item.id} className="flex items-center gap-3 py-2.5">
                <Checkbox checked={item.checked} onChange={() => void onToggle(item.id, !item.checked)} label={`Uncheck ${item.name}`} />
                <button type="button" onClick={() => onOpen(item as DisplayItem)} className="flex flex-1 justify-between text-left text-sm text-muted line-through">
                  <span>{item.name}</span>
                  {item.quantity ? <span>{item.quantity}</span> : null}
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-3">
            <Button variant="ghost" onClick={() => void onClear()}>Clear checked</Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
