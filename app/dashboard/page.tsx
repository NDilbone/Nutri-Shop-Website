import { requireUser } from "@/lib/dal/session";
import { createClient } from "@/lib/supabase/server";

export default async function DashboardPage() {
  const { userId } = await requireUser(); // Gate 2 — redirects if not authed
  const supabase = await createClient();
  // Gate 4 proves itself: RLS lets us read only our own profile row.
  const { data: profile } = await supabase
    .from("profiles")
    .select("id, display_name")
    .eq("id", userId)
    .single();

  return (
    <main style={{ maxWidth: 640, margin: "8vh auto", padding: 24 }}>
      <h1>Dashboard</h1>
      <p>Signed in. Your user id: <code>{userId}</code></p>
      <p>Profile loaded via RLS: <code>{profile?.id ?? "none"}</code></p>
      <form action="/auth/signout" method="post">
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}
