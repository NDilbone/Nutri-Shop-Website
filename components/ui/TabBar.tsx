"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function TabBar() {
  const pathname = usePathname();
  const active = (p: string) => pathname === p || pathname.startsWith(p + "/");
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 flex items-end justify-around border-t border-border bg-surface-2 px-2 pb-2 pt-2">
      <Link href="/today" className={`flex flex-1 flex-col items-center gap-0.5 text-[10px] ${active("/today") ? "text-brand" : "text-muted"}`}>
        <span className="text-lg leading-none">▦</span>Today
      </Link>
      <Link href="/add" aria-label="Add food" className="flex flex-1 flex-col items-center">
        <span className="-mt-5 flex h-12 w-12 items-center justify-center rounded-full bg-brand text-2xl font-light text-[#08130b] shadow-lg">+</span>
      </Link>
      <Link href="/account" className={`flex flex-1 flex-col items-center gap-0.5 text-[10px] ${active("/account") ? "text-brand" : "text-muted"}`}>
        <span className="text-lg leading-none">◔</span>Account
      </Link>
    </nav>
  );
}
