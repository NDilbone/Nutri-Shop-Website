import Link from "next/link";
import { requireUser, verifyAdmin } from "@/lib/dal/session";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { SignOutButton } from "@/components/ui/SignOutButton";

export default async function AccountPage() {
  const { userId } = await requireUser();
  const isAdmin = await verifyAdmin();
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
