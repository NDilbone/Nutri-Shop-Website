"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/dal/session";
import { addInvite, revokeInvite, setUserBanned } from "@/lib/dal/admin";
import { inviteEmailSchema } from "@/lib/validation/admin";

export async function addInviteAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const email = inviteEmailSchema.parse(formData.get("email"));
  await addInvite(email);
  revalidatePath("/admin");
}

export async function revokeInviteAction(email: string): Promise<void> {
  await requireAdmin();
  const parsed = inviteEmailSchema.parse(email);
  await revokeInvite(parsed);
  revalidatePath("/admin");
}

export async function setBanAction(targetUserId: string, banned: boolean): Promise<void> {
  const { userId } = await requireAdmin();
  // Validate the client-supplied id shape (boundary input). Any admin may target any
  // user id by design — this just fails fast on malformed input; banGuard enforces the rest.
  const id = z.uuid().parse(targetUserId);
  await setUserBanned({ actorId: userId, targetUserId: id, banned });
  revalidatePath("/admin");
}
