"use client";

import { useState, useTransition, useRef } from "react";
import type { ShoppingListItem } from "@/lib/shopping/types";
import { CATEGORY_LABEL } from "@/lib/shopping/types";
import { groupItems } from "@/lib/shopping/group";
import { addItemAction, toggleItemAction, editItemAction, deleteItemAction, clearCheckedAction } from "./actions";
import { ItemSheet, type ItemDraft } from "./ItemSheet";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

export function ListView({ initialItems }: { initialItems: ShoppingListItem[] }) {
  const [items, setItems] = useState(initialItems);
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<ShoppingListItem | null>(null);
  const [, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  // Server data is the source of truth: re-sync the local mirror when a revalidate
  // delivers a new prop (render-time reset keyed on prop identity — no effect).
  const [syncedFrom, setSyncedFrom] = useState(initialItems);
  if (initialItems !== syncedFrom) { setSyncedFrom(initialItems); setItems(initialItems); }

  const { groups, checked } = groupItems(items);

  function addInline(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setNewName("");
    inputRef.current?.focus();
    startTransition(async () => { await addItemAction({ name }); });
  }

  function toggle(target: ShoppingListItem) {
    const next = !target.checked;
    setItems((prev) => prev.map((i) => (i.id === target.id ? { ...i, checked: next } : i))); // optimistic
    startTransition(async () => { await toggleItemAction({ id: target.id, checked: next }); });
  }

  function clearChecked() {
    setItems((prev) => prev.filter((i) => !i.checked)); // optimistic
    startTransition(async () => { await clearCheckedAction(); });
  }

  async function saveEdit(draft: ItemDraft) {
    if (!editing) return;
    await editItemAction({
      id: editing.id,
      name: draft.name,
      quantity: draft.quantity.trim() || null,
      category: draft.category || null,
    });
  }

  async function removeEditing() {
    if (!editing) return;
    await deleteItemAction({ id: editing.id });
  }

  return (
    <main className="p-4">
      <h1 className="mb-3 text-lg font-semibold">Shopping list</h1>

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
          <h2 className="mb-1 text-[11px] uppercase tracking-wide text-muted">{CATEGORY_LABEL[group.category]}</h2>
          <ul className="divide-y divide-border/50">
            {group.items.map((item) => (
              <li key={item.id} className="flex items-center gap-3 py-2.5">
                <Checkbox checked={item.checked} onChange={() => toggle(item)} label={`Check ${item.name}`} />
                <button type="button" onClick={() => setEditing(item)} className="flex flex-1 justify-between text-left text-sm">
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
                <Checkbox checked={item.checked} onChange={() => toggle(item)} label={`Uncheck ${item.name}`} />
                <button type="button" onClick={() => setEditing(item)} className="flex flex-1 justify-between text-left text-sm text-muted line-through">
                  <span>{item.name}</span>
                  {item.quantity ? <span>{item.quantity}</span> : null}
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-3">
            <Button variant="ghost" onClick={clearChecked}>Clear checked</Button>
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
