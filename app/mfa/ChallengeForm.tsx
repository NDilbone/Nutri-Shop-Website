"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { completeMfaAction } from "./actions";

export function ChallengeForm({ factorId, redirectTo = "/today" }: { factorId: string; redirectTo?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");

  const submit = () =>
    startTransition(async () => {
      setError(null);
      try {
        await completeMfaAction(factorId, code.trim());
        router.replace(redirectTo);
        router.refresh();
      } catch {
        setError("That code didn't match. Try the current 6-digit code.");
      }
    });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">Enter the current 6-digit code from your authenticator app.</p>
      <Input
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="6-digit code"
        aria-label="Authenticator code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />
      <Button type="button" disabled={pending || code.trim().length < 6} onClick={submit}>Verify</Button>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}
