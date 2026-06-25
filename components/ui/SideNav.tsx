"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";

const NAV = [
  { href: "/today", label: "Today", icon: "▦" },
  { href: "/list", label: "List", icon: "☑" },
  { href: "/account", label: "Account", icon: "◔" },
];
const KEY = "ns:nav-collapsed";

// SSR-safe "are we hydrated yet" — no effect. getServerSnapshot => false keeps the
// hydration render identical to the server output (collapsed = false).
const useIsClient = () =>
  useSyncExternalStore(() => () => {}, () => true, () => false);

export function SideNav() {
  const pathname = usePathname();
  const router = useRouter();
  const isClient = useIsClient();
  const [collapsed, setCollapsed] = useState(false);
  const [read, setRead] = useState(false);

  // Apply the persisted collapse value only AFTER hydration (gated on isClient), never
  // during the hydration render — otherwise a collapsed user would hydrate to w-16 while
  // the server emitted w-56, a React 19 hydration mismatch. Render-time set, no effect.
  if (isClient && !read) {
    setRead(true);
    setCollapsed(localStorage.getItem(KEY) === "1");
  }

  const active = (p: string) => pathname === p || pathname.startsWith(p + "/");
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem(KEY, next ? "1" : "0");
  };

  return (
    <nav
      className={`sticky top-0 hidden h-dvh shrink-0 flex-col gap-1 border-r border-border bg-surface-2 p-3 lg:flex ${
        collapsed ? "w-16" : "w-56"
      }`}
    >
      <div className="mb-3 flex items-center justify-between">
        {!collapsed && <span className="px-1 font-bold text-brand">Nutri-Shop</span>}
        <button type="button" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={toggle} className="rounded-md px-2 py-1 text-muted hover:text-text">
          {collapsed ? "»" : "«"}
        </button>
      </div>

      {NAV.map((n) => (
        <Link
          key={n.href}
          href={n.href}
          title={n.label}
          className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm ${active(n.href) ? "bg-surface text-brand" : "text-muted hover:text-text"}`}
        >
          <span className="text-lg leading-none">{n.icon}</span>
          {!collapsed && <span>{n.label}</span>}
        </Link>
      ))}

      <button
        type="button"
        onClick={() => router.push("/add")}
        title="Log food"
        className="mt-auto flex items-center justify-center gap-2 rounded-md bg-brand px-3 py-2 text-sm font-medium text-[#08130b]"
      >
        <span className="text-lg leading-none">＋</span>
        {!collapsed && <span>Log food</span>}
      </button>
    </nav>
  );
}
