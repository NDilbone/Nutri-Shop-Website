import type { ReactNode } from "react";
import { requireUser } from "@/lib/dal/session";
import { TabBar } from "@/components/ui/TabBar";
import { InstallPrompt } from "@/components/ui/InstallPrompt";

export default async function AppLayout({ children }: { children: ReactNode }) {
  await requireUser(); // Gate 2 — server-side, defense in depth beyond proxy.ts
  return (
    <div className="mx-auto min-h-dvh w-full max-w-[480px] pb-24">
      {children}
      <TabBar />
      <InstallPrompt />
    </div>
  );
}
