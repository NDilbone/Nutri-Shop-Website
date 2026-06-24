"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { todayLocal } from "@/lib/date";

export function NormalizeDate() {
  const router = useRouter();
  useEffect(() => {
    router.replace(`/today?date=${todayLocal()}`);
  }, [router]);
  return <main className="p-4 text-muted">Loading today…</main>;
}
