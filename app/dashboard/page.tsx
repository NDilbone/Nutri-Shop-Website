import { requireUser } from "@/lib/dal/session";
import { createClient } from "@/lib/supabase/server";

export default async function DashboardPage() {
  const { userId } = await requireUser(); // Gate 2 — redirects if not authed
  const supabase = await createClient();
  // Self-keyed read: RLS (Gate 4) enforces ownership. assertOwnership() in the DAL is the reserved guard for future foreign-keyed / multi-row reads.
  const { data: profile } = await supabase
    .from("profiles")
    .select("id, display_name")
    .eq("id", userId)
    .single();

  return (
    <main className="max-w-[640px] mx-auto my-[8vh] p-6">
      <h1>Dashboard</h1>
      <p>Signed in. Your user id: <code>{userId}</code></p>
      <p>Profile loaded via RLS: <code>{profile?.id ?? "none"}</code></p>
      <form action="/auth/signout" method="post">
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}
