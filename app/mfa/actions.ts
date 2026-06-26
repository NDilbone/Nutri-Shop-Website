"use server";

import { requireUser } from "@/lib/dal/session";
import { enrollTotp, verifyTotp, type EnrollResult } from "@/lib/dal/mfa";

/** Start (or restart) TOTP enrollment. aal1-reachable on purpose. */
export async function startEnrollmentAction(): Promise<EnrollResult> {
  await requireUser();
  return enrollTotp();
}

/** Verify a code for enroll-completion or step-up; promotes the session to aal2. */
export async function completeMfaAction(factorId: string, code: string): Promise<void> {
  await requireUser();
  await verifyTotp(factorId, code);
}
