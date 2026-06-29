import Link from "next/link";
import { requireUser, verifyAdmin } from "@/lib/dal/session";
import { getOwnMfaStatus } from "@/lib/dal/mfa";
import { createClient } from "@/lib/supabase/server";
import { getMyHousehold, getMembers, getPendingInvites } from "@/lib/dal/household";
import { Card } from "@/components/ui/Card";
import { SignOutButton } from "@/components/ui/SignOutButton";
import { MfaSection } from "./MfaSection";
import { HouseholdSection } from "./HouseholdSection";

export default async function AccountPage() {
  const { userId } = await requireUser();
  const isAdmin = await verifyAdmin();
  const { hasVerifiedFactor, verifiedFactorId } = await getOwnMfaStatus();
  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("profiles").select("id, display_name").eq("id", userId).single();

  const household = await getMyHousehold();
  const members = household ? await getMembers(household.id) : [];
  const invites = await getPendingInvites();

  return (
    <main className="p-4">
      <h1 className="mb-4 text-xl font-semibold">Account</h1>
      <Card className="p-4 text-sm">
        <p className="text-muted">Signed in as</p>
        <p className="break-all">{profile?.display_name ?? userId}</p>
      </Card>

      <MfaSection isAdmin={isAdmin} hasFactor={hasVerifiedFactor} factorId={verifiedFactorId} />

      <HouseholdSection household={household} members={members} invites={invites} memberCount={members.length} />

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
