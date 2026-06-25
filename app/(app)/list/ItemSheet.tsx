"use client";

import { useState } from "react";
import type { Category, ShoppingListItem } from "@/lib/shopping/types";
import { CATEGORIES, CATEGORY_LABEL } from "@/lib/shopping/types";
import { Sheet } from "@/components/ui/Sheet";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";

export type ItemDraft = { name: string; quantity: string; category: Category | "" };

export function ItemSheet({
  open, onClose, mode, item, onSubmit, onDelete,
}: {
  open: boolean;
  onClose: () => void;
  mode: "add" | "edit";
  item?: ShoppingListItem | null;
  onSubmit: (draft: ItemDraft) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState("");
  const [category, setCategory] = useState<Category | "">("");
  const [pending, setPending] = useState(false);

  // Re-seed inputs when the sheet (re)opens for a given item. Done during render,
  // keyed on a stable string, to avoid an effect (and the React-19 set-state-in-effect rule).
  const seedKey = `${open ? "o" : "c"}:${item?.id ?? "new"}`;
  const [seededKey, setSeededKey] = useState<string | null>(null);
  if (open && seedKey !== seededKey) {
    setSeededKey(seedKey);
    setName(item?.name ?? "");
    setQuantity(item?.quantity ?? "");
    setCategory(item?.category ?? "");
  }

  async function submit() {
    if (!name.trim()) return;
    setPending(true);
    try { await onSubmit({ name: name.trim(), quantity, category }); onClose(); }
    finally { setPending(false); }
  }

  return (
    <Sheet open={open} onClose={onClose} title={mode === "edit" ? "Edit item" : "Add to list"}>
      <div className="grid gap-3">
        <Field label="Item">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Chicken breast" />
        </Field>
        <Field label="Quantity (optional)">
          <Input value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="e.g. 2 lbs" />
        </Field>
        <Field label="Category (optional)">
          <Select value={category} onChange={(e) => setCategory(e.target.value as Category | "")}>
            <option value="">Uncategorized</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
          </Select>
        </Field>
        {item?.fdcId != null ? <p className="text-xs text-muted">Linked to USDA food #{item.fdcId}</p> : null}
        <Button onClick={submit} disabled={pending || !name.trim()}>
          {pending ? "…" : mode === "edit" ? "Save" : "Add"}
        </Button>
        {mode === "edit" && onDelete ? (
          <Button
            variant="danger"
            onClick={async () => { setPending(true); try { await onDelete(); onClose(); } finally { setPending(false); } }}
          >
            Delete item
          </Button>
        ) : null}
      </div>
    </Sheet>
  );
}
