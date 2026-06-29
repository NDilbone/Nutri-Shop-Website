"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getPendingInvitesAction } from "@/app/(app)/account/household-actions";

export function PendingInviteBanner({ online }: { online: boolean }) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!online) return;
    let cancelled = false;
    getPendingInvitesAction()
      .then((invites) => { if (!cancelled) setCount(invites.length); })
      .catch(() => { /* offline / auth — silently show nothing */ });
    return () => { cancelled = true; };
  }, [online]);

  if (count === 0) return null;
  return (
    <Link href="/account" className="mb-3 block rounded-md border border-brand/40 bg-[#16341f] px-3 py-2 text-xs text-protein">
      You have {count} pending household invite{count > 1 ? "s" : ""} — review on Account.
    </Link>
  );
}
