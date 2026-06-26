import Link from "next/link";
import { requireUser, verifyAdmin } from "@/lib/dal/session";
import { getOwnMfaStatus } from "@/lib/dal/mfa";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { SignOutButton } from "@/components/ui/SignOutButton";
import { MfaSection } from "./MfaSection";

export default async function AccountPage() {
  const { userId } = await requireUser();
  const isAdmin = await verifyAdmin();
  const { hasVerifiedFactor, verifiedFactorId } = await getOwnMfaStatus();
  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("profiles").select("id, display_name").eq("id", userId).single();

  return (
    <main className="p-4">
      <h1 className="mb-4 text-xl font-semibold">Account</h1>
      <Card className="p-4 text-sm">
        <p className="text-muted">Signed in as</p>
        <p className="break-all">{profile?.display_name ?? userId}</p>
      </Card>

      <MfaSection isAdmin={isAdmin} hasFactor={hasVerifiedFactor} factorId={verifiedFactorId} />

      <div className="mt-4">
        <SignOutButton />
      </div>
      {isAdmin && (
        <div className="mt-4">
          <Link href="/admin" className="text-sm text-brand underline">
            Admin
          </Link>
        </div>
      )}
    </main>
  );
}
