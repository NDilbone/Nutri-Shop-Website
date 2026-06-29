"use server";

import { requireStepUp } from "@/lib/dal/session";
import {
  createHousehold,
  inviteToHousehold,
  respondToInvite,
  leaveHousehold,
  getPendingInvites,
  type PendingInvite,
} from "@/lib/dal/household";
import {
  householdNameSchema,
  inviteEmailSchema,
  respondInviteSchema,
} from "@/lib/validation/household";

export type ActionResult = { ok: true } | { error: string };

export async function createHouseholdAction(name: string): Promise<ActionResult> {
  await requireStepUp();
  const parsed = householdNameSchema.safeParse(name);
  if (!parsed.success) return { error: "Enter a household name (1–100 characters)." };
  try {
    await createHousehold(parsed.data);
    return { ok: true };
  } catch {
    return { error: "Could not create the household. Are you already in one?" };
  }
}

export async function inviteAction(email: string): Promise<ActionResult> {
  await requireStepUp();
  const parsed = inviteEmailSchema.safeParse(email);
  if (!parsed.success) return { error: "Enter a valid email address." };
  // Always returns ok on a valid email — the RPC is a silent no-op for ineligible
  // targets, so the UI must not reveal whether the address exists.
  try {
    await inviteToHousehold(parsed.data);
    return { ok: true };
  } catch {
    return { error: "Could not send the invite." };
  }
}

export async function respondInviteAction(
  inviteId: string,
  accept: boolean,
): Promise<ActionResult> {
  await requireStepUp();
  const parsed = respondInviteSchema.safeParse({ inviteId, accept });
  if (!parsed.success) return { error: "Invalid invite." };
  try {
    await respondToInvite(parsed.data.inviteId, parsed.data.accept);
    return { ok: true };
  } catch {
    return { error: "Could not respond to the invite." };
  }
}

export async function leaveHouseholdAction(): Promise<ActionResult> {
  await requireStepUp();
  try {
    await leaveHousehold();
    return { ok: true };
  } catch {
    return { error: "Could not leave the household." };
  }
}

/** Read-only fetch for the /list client banner (Task 12). */
export async function getPendingInvitesAction(): Promise<PendingInvite[]> {
  await requireStepUp();
  return getPendingInvites();
}
