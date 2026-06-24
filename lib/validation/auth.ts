import { z } from "zod";

export const credentialsSchema = z.object({
  email: z.email(),
  password: z.string().min(10, "Password must be at least 10 characters").max(200),
});

export const emailSchema = z.object({ email: z.email() });
