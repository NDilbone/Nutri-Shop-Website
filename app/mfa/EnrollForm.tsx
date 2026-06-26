"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { startEnrollmentAction, completeMfaAction } from "./actions";

export function EnrollForm({ redirectTo = "/today" }: { redirectTo?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [enroll, setEnroll] = useState<{ factorId: string; qrCodeSvg: string; secret: string } | null>(null);
  const [code, setCode] = useState("");

  const begin = () =>
    startTransition(async () => {
      setError(null);
      try {
        setEnroll(await startEnrollmentAction());
      } catch {
        setError("Could not start setup. Try again.");
      }
    });

  const confirm = () =>
    startTransition(async () => {
      setError(null);
      try {
        await completeMfaAction(enroll!.factorId, code.trim());
        router.replace(redirectTo);
        router.refresh();
      } catch {
        setError("That code didn't match. Try the current 6-digit code.");
      }
    });

  if (!enroll) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Set up an authenticator app (Google Authenticator, 1Password, etc.) to add a second factor.
        </p>
        <Button type="button" disabled={pending} onClick={begin}>Set up authenticator</Button>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* qr_code is SVG markup (not script) — safe to inject; no CSP change. */}
      <div className="rounded-md bg-white p-3" dangerouslySetInnerHTML={{ __html: enroll.qrCodeSvg }} />
      <p className="text-xs text-muted break-all">Can&apos;t scan? Enter this secret manually: <code>{enroll.secret}</code></p>
      <Input
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="6-digit code"
        aria-label="Authenticator code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />
      <Button type="button" disabled={pending || code.trim().length < 6} onClick={confirm}>
        Verify & enable
      </Button>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}
