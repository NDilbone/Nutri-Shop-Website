// app/(app)/admin/page.tsx
import { requireAdmin } from "@/lib/dal/session";
import { listInvites } from "@/lib/dal/admin";
import { AdminView } from "./AdminView";

export default async function AdminPage() {
  await requireAdmin(); // bounces non-admins to /today
  const invites = await listInvites();

  return (
    <main className="p-4">
      <h1 className="mb-4 text-xl font-semibold">Admin</h1>
      <AdminView invites={invites} />
    </main>
  );
}
