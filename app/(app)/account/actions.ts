"use server";

import { disableTotp } from "@/lib/dal/mfa";
import { requireUser } from "@/lib/dal/session";

/** Member self-disable. requireUser only: the (app) layout already gated the navigation,
 *  and Supabase rejects unenrolling a VERIFIED factor unless the session is aal2 — so a
 *  direct aal1 POST fails safely on its own. */
export async function disableMfaAction(factorId: string): Promise<void> {
  await requireUser();
  await disableTotp(factorId);
}
