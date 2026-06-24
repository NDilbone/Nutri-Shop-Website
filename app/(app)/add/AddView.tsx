"use client";

import { useState } from "react";
import type { NormalizedFood } from "@/lib/fdc/cache";
import type { Meal } from "@/lib/nutrition/types";
import { todayLocal } from "@/lib/date";
import { addFoodAction } from "@/app/(app)/today/actions";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { QuickAddSheet } from "./QuickAddSheet";

type Result = { fdcId: number; description: string; dataType: string | null; brandOwner: string | null };
type Source = "All" | "Branded" | "Generic";
const DATATYPES: Record<Source, string> = { All: "", Branded: "Branded", Generic: "Foundation,SR Legacy" };

export function AddView({ date, presetMeal }: { date: string; presetMeal: Meal }) {
  const [q, setQ] = useState("");
  const [source, setSource] = useState<Source>("All");
  const [results, setResults] = useState<Result[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<NormalizedFood | null>(null);
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const loggedOn = date || todayLocal();

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!q.trim()) return;
    setSearching(true);
    try {
      const params = new URLSearchParams({ q: q.trim() });
      if (DATATYPES[source]) params.set("dataType", DATATYPES[source]);
      const res = await fetch(`/api/foods?${params}`, { credentials: "same-origin" });
      const json = await res.json();
      setResults(res.ok ? json.results : []);
    } finally { setSearching(false); }
  }

  async function pick(fdcId: number) {
    setSelected(null);
    setOpen(true);
    const res = await fetch(`/api/foods/${fdcId}`, { credentials: "same-origin" });
    if (res.ok) setSelected(await res.json());
    else { setOpen(false); setToast("Could not load that food."); }
  }

  async function submit({ amountGrams, meal }: { amountGrams: number; meal: Meal }) {
    if (!selected) return;
    const r = await addFoodAction({ fdcId: selected.fdcId, amountGrams, meal, loggedOn });
    setToast("error" in r ? r.error : "Added.");
  }

  return (
    <main className="p-4">
      <h1 className="mb-3 text-lg font-semibold">Add food</h1>
      <form onSubmit={runSearch} className="mb-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search foods…" aria-label="Search foods" />
      </form>
      <div className="mb-3">
        <Segmented
          options={(["All", "Branded", "Generic"] as Source[]).map((s) => ({ value: s, label: s }))}
          value={source} onChange={(s) => setSource(s)}
        />
      </div>

      {searching ? <p className="text-sm text-muted">Searching…</p> : null}
      <ul className="divide-y divide-border">
        {results.map((r) => (
          <li key={r.fdcId}>
            <button type="button" onClick={() => pick(r.fdcId)} className="w-full py-3 text-left">
              <div className="text-sm">{r.description}</div>
              <div className="text-[11px] text-muted">{r.brandOwner ? `${r.brandOwner} · ` : ""}{r.dataType ?? ""}</div>
            </button>
          </li>
        ))}
      </ul>

      <QuickAddSheet
        open={open}
        onClose={() => setOpen(false)}
        food={selected}
        initialMeal={presetMeal}
        initialGrams={selected?.nutrition.serving?.amount ?? 100}
        mode="add"
        onSubmit={submit}
      />

      {toast ? <p role="status" className="fixed inset-x-0 bottom-24 mx-auto w-fit rounded-md bg-surface px-4 py-2 text-sm text-text shadow-lg">{toast}</p> : null}
    </main>
  );
}
