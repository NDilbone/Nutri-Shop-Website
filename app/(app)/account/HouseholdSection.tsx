"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import type { Household, Member, PendingInvite } from "@/lib/dal/household";
import {
  createHouseholdAction, inviteAction, respondInviteAction, leaveHouseholdAction,
} from "./household-actions";

export function HouseholdSection({
  household, members, invites, memberCount,
}: {
  household: Household | null;
  members: Member[];
  invites: PendingInvite[];
  memberCount: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  const run = (fn: () => Promise<{ ok: true } | { error: string }>, after?: () => void) =>
    startTransition(async () => {
      setError(null); setNote(null);
      const res = await fn();
      if ("error" in res) { setError(res.error); return; }
      after?.();
      router.refresh();
    });

  return (
    <Card className="mt-4 p-4 text-sm">
      <p className="mb-2 font-medium">Household</p>

      {invites.length > 0 && (
        <div className="mb-3 space-y-2">
          {invites.map((inv) => (
            <div key={inv.id} className="rounded-md border border-border/60 bg-surface p-3">
              <p className="mb-2">You&apos;ve been invited to <span className="font-medium">{inv.householdName}</span>.</p>
              <div className="flex gap-2">
                <Button type="button" disabled={pending} onClick={() => run(() => respondInviteAction(inv.id, true))}>Accept</Button>
                <Button type="button" variant="ghost" disabled={pending} onClick={() => run(() => respondInviteAction(inv.id, false))}>Decline</Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {!household ? (
        <div className="space-y-3">
          <p className="text-muted">Create a household to share one shopping list with someone you invite.</p>
          <div className="flex gap-2">
            <div className="min-w-0 flex-1">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Household name" aria-label="Household name" />
            </div>
            <div className="shrink-0">
              <Button type="button" disabled={pending} onClick={() => run(() => createHouseholdAction(name), () => setName(""))}>Create</Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <p className="text-muted">Name</p>
            <p>{household.name}</p>
          </div>
          <div>
            <p className="mb-1 text-muted">Members</p>
            <ul className="space-y-1">
              {members.map((m) => <li key={m.userId} className="break-all">{m.displayName ?? m.userId}</li>)}
            </ul>
          </div>
          <div>
            <p className="mb-1 text-muted">Invite by email</p>
            <div className="flex gap-2">
              <div className="min-w-0 flex-1">
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="member@example.com" aria-label="Invite email" />
              </div>
              <div className="shrink-0">
                <Button
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => inviteAction(email), () => { setEmail(""); setNote("If that address belongs to a member, they'll see an invite."); })}
                >
                  Invite
                </Button>
              </div>
            </div>
          </div>
          <Button
            type="button"
            variant="danger"
            disabled={pending}
            onClick={() => {
              const msg = memberCount <= 1
                ? "You're the last member — leaving deletes this household and its shared list. Continue?"
                : "Leave this household? You'll lose access to the shared list.";
              if (window.confirm(msg)) run(() => leaveHouseholdAction());
            }}
          >
            Leave household
          </Button>
        </div>
      )}

      {note && <p className="mt-2 text-xs text-muted">{note}</p>}
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </Card>
  );
}
