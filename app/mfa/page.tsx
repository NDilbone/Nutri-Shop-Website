import { redirect } from "next/navigation";
import { requireUser, verifyStepUp } from "@/lib/dal/session";
import { getOwnMfaStatus } from "@/lib/dal/mfa";
import { Card } from "@/components/ui/Card";
import { EnrollForm } from "./EnrollForm";
import { ChallengeForm } from "./ChallengeForm";

export default async function MfaPage() {
  await requireUser(); // session only — NOT requireStepUp (this is where step-up happens)
  const requirement = await verifyStepUp();
  if (requirement === "ok") redirect("/today");

  let body = <EnrollForm />;
  if (requirement === "challenge") {
    const { verifiedFactorId } = await getOwnMfaStatus();
    body = verifiedFactorId ? <ChallengeForm factorId={verifiedFactorId} /> : <EnrollForm />;
  }

  return (
    <main className="mx-auto min-h-dvh w-full max-w-[480px] p-4">
      <h1 className="mb-4 text-xl font-semibold">Two-factor authentication</h1>
      <Card className="p-4">{body}</Card>
    </main>
  );
}
