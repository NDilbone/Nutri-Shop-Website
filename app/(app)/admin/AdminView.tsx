// app/(app)/admin/AdminView.tsx
"use client";

import { useRef, useState, useTransition } from "react";
import type { InviteRow } from "@/lib/dal/admin";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { addInviteAction, revokeInviteAction, setBanAction } from "./actions";

export function AdminView({ invites }: { invites: InviteRow[] }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const run = (fn: () => Promise<void>) =>
    startTransition(async () => {
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Action failed.");
      }
    });

  const onAdd = (formData: FormData) =>
    run(async () => {
      await addInviteAction(formData);
      formRef.current?.reset();
    });

  return (
    <div className="space-y-6">
      <form ref={formRef} action={onAdd} className="flex gap-2">
        <Input name="email" type="email" required placeholder="invite email" aria-label="Invite email" />
        <Button type="submit" disabled={pending}>Add</Button>
      </form>

      {error && <p role="alert" className="text-sm text-danger">{error}</p>}

      <ul className="divide-y divide-border">
        {invites.map((inv) => (
          <li key={inv.email} className="flex items-center justify-between gap-3 py-2 text-sm">
            <span className="min-w-0 flex-1 break-all">
              {inv.email}{" "}
              <span className="text-muted">· {inv.status}</span>
            </span>

            {inv.status === "pending" && (
              <Button
                type="button"
                disabled={pending}
                onClick={() => {
                  if (window.confirm(`Revoke the invite for ${inv.email}?`)) run(() => revokeInviteAction(inv.email));
                }}
              >
                Revoke
              </Button>
            )}

            {inv.status === "joined" && inv.user_id && (
              <Button
                type="button"
                disabled={pending}
                onClick={() => {
                  if (window.confirm(`Disable ${inv.email}? They will be logged out and cannot sign back in.`))
                    run(() => setBanAction(inv.user_id!, true));
                }}
              >
                Disable
              </Button>
            )}

            {inv.status === "banned" && inv.user_id && (
              <Button type="button" disabled={pending} onClick={() => run(() => setBanAction(inv.user_id!, false))}>
                Re-enable
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
