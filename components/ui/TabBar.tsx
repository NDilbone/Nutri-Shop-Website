"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/Button";
import { ItemSheet, type ItemDraft } from "@/app/(app)/list/ItemSheet";
import { useOffline } from "@/lib/offline/OfflineProvider";
import { getOrInitListId } from "@/lib/offline/db";
import { addLocalItem } from "@/lib/offline/items";

export function TabBar() {
  const pathname = usePathname();
  const router = useRouter();
  const [chooser, setChooser] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const off = useOffline();
  const active = (p: string) => pathname === p || pathname.startsWith(p + "/");

  async function addToList(draft: ItemDraft) {
    if (off.status !== "ready") return;
    const { db, cryptoKey, sync } = off;
    const listId = await getOrInitListId(db);
    await addLocalItem(db, cryptoKey, listId, {
      name: draft.name,
      quantity: draft.quantity.trim() || null,
      category: draft.category || null,
      fdcId: null,
    });
    sync();
  }

  return (
    <>
      <nav className="fixed inset-x-0 bottom-0 z-40 flex items-end justify-around border-t border-border bg-surface-2 px-2 pb-2 pt-2 lg:hidden">
        <Link href="/today" className={`flex flex-1 flex-col items-center gap-0.5 text-[10px] ${active("/today") ? "text-brand" : "text-muted"}`}>
          <span className="text-lg leading-none">▦</span>Today
        </Link>
        <Link href="/list" className={`flex flex-1 flex-col items-center gap-0.5 text-[10px] ${active("/list") ? "text-brand" : "text-muted"}`}>
          <span className="text-lg leading-none">☑</span>List
        </Link>
        <button type="button" aria-label="Add" onClick={() => setChooser(true)} className="flex flex-1 flex-col items-center">
          <span className="-mt-5 flex h-12 w-12 items-center justify-center rounded-full bg-brand text-2xl font-light text-[#08130b] shadow-lg">+</span>
        </button>
        <Link href="/account" className={`flex flex-1 flex-col items-center gap-0.5 text-[10px] ${active("/account") ? "text-brand" : "text-muted"}`}>
          <span className="text-lg leading-none">◔</span>Account
        </Link>
      </nav>

      <Sheet open={chooser} onClose={() => setChooser(false)} title="Add">
        <div className="grid gap-2">
          <Button onClick={() => { setChooser(false); router.push("/add"); }}>Log food</Button>
          {/* Disable "Add to list" until the offline store is ready: otherwise the
              add silently drops (addToList early-returns when status !== "ready"). */}
          <Button
            variant="ghost"
            disabled={off.status !== "ready"}
            onClick={() => { setChooser(false); setAddOpen(true); }}
          >
            Add to list
          </Button>
          {off.status !== "ready" ? (
            <p className="text-center text-[11px] text-muted">List storage is still loading…</p>
          ) : null}
        </div>
      </Sheet>

      <ItemSheet open={addOpen} onClose={() => setAddOpen(false)} mode="add" onSubmit={addToList} />
    </>
  );
}
