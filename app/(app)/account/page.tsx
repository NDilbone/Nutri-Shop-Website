import { requireUser } from "@/lib/dal/session";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

export default async function AccountPage() {
  const { userId } = await requireUser();
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
      <form action="/auth/signout" method="post" className="mt-4">
        <Button type="submit" variant="ghost">Sign out</Button>
      </form>
    </main>
  );
}
