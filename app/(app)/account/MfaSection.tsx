"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { EnrollForm } from "@/app/mfa/EnrollForm";
import { disableMfaAction } from "./actions";

export function MfaSection({
  isAdmin,
  hasFactor,
  factorId,
}: {
  isAdmin: boolean;
  hasFactor: boolean;
  factorId: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [enrolling, setEnrolling] = useState(false);

  const disable = () =>
    startTransition(async () => {
      setError(null);
      try {
        await disableMfaAction(factorId!);
        router.refresh();
      } catch {
        setError("Could not disable MFA.");
      }
    });

  return (
    <Card className="mt-4 p-4 text-sm">
      <p className="mb-2 font-medium">Two-factor authentication</p>

      {isAdmin && (
        <p className="text-muted">
          Enabled — required for admins. To switch devices, reset it from the{" "}
          <span className="text-text">Admin</span> screen.
        </p>
      )}

      {!isAdmin && hasFactor && (
        <div className="space-y-3">
          <p className="text-muted">Enabled.</p>
          <Button type="button" variant="danger" disabled={pending} onClick={disable}>
            Disable MFA
          </Button>
        </div>
      )}

      {!isAdmin && !hasFactor && !enrolling && (
        <div className="space-y-3">
          <p className="text-muted">Off. Add an authenticator app for extra account security.</p>
          <Button type="button" onClick={() => setEnrolling(true)}>Enable MFA</Button>
        </div>
      )}

      {!isAdmin && !hasFactor && enrolling && <EnrollForm redirectTo="/account" />}

      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </Card>
  );
}
