import { z } from "zod";

export const householdNameSchema = z.string().trim().min(1).max(100);

export const inviteEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email());

export const respondInviteSchema = z.object({
  inviteId: z.uuid(),
  accept: z.boolean(),
});
export type RespondInviteInput = z.infer<typeof respondInviteSchema>;
