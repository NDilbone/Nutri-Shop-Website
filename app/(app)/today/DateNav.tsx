"use client";

import { useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { addDays, todayLocal, formatDayLabel } from "@/lib/date";

const subscribe = () => () => {};

export function DateNav({ date }: { date: string }) {
  const router = useRouter();
  // Client-only "today" anchor, read without an effect. SSR + the first hydration render
  // use the null server snapshot (raw date) → no mismatch; React then re-renders with the
  // client snapshot (local today) → friendly label.
  const today = useSyncExternalStore(subscribe, () => todayLocal(), () => null);
  const go = (d: string) => router.push(`/today?date=${d}`);
  const label = today ? formatDayLabel(date, today) : date; // raw date until mounted, then friendly label

  return (
    <div className="px-4 pt-3">
      <div className="flex items-center justify-center gap-4">
        <button type="button" aria-label="Previous day" onClick={() => go(addDays(date, -1))} className="text-xl text-muted">‹</button>
        <span className="min-w-[140px] text-center text-lg font-semibold">{label}</span>
        <button type="button" aria-label="Next day" onClick={() => go(addDays(date, 1))} className="text-xl text-muted">›</button>
      </div>
      <div className="mt-1 flex justify-center">
        <input
          type="date"
          value={date}
          onChange={(e) => { if (e.target.value) go(e.target.value); }}
          className="bg-transparent text-center text-xs text-muted outline-none"
          aria-label="Jump to date"
        />
      </div>
    </div>
  );
}
