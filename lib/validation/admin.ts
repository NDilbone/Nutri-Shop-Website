import { z } from "zod";

/** Trim + lowercase, then validate as an email. Output is the normalized string. */
export const inviteEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email());
