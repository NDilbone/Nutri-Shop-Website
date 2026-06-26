"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { svgToDataUri } from "@/lib/auth/qr";
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
      {/* Render the QR as an <img> data URI, NOT via innerHTML: GoTrue colors the SVG
          with inline style="fill:..." attributes that the prod CSP (style-src nonce-only)
          strips when injected into the page, rendering it solid black. As an image
          resource the inline fills survive; img-src already allows data:. */}
      <div className="w-fit rounded-md bg-white p-3">
        {/* eslint-disable-next-line @next/next/no-img-element -- QR is an inline data: URI; next/image optimization is inapplicable */}
        <img
          src={svgToDataUri(enroll.qrCodeSvg)}
          alt="Scan this QR code with your authenticator app"
          width={192}
          height={192}
          className="h-48 w-48"
        />
      </div>
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
