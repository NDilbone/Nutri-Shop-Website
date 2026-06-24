import "server-only";
import { z } from "zod";

const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
});

const serverSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  FDC_API_KEY: z.string().min(1).optional(),
});

export function parsePublicEnv(raw: Record<string, string | undefined>) {
  return publicSchema.parse(raw);
}

export function parseServerEnv(raw: Record<string, string | undefined>) {
  return serverSchema.parse(raw);
}

let _publicEnv: ReturnType<typeof parsePublicEnv> | undefined;
export function getPublicEnv() {
  return (_publicEnv ??= parsePublicEnv({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  }));
}

let _serverEnv: ReturnType<typeof parseServerEnv> | undefined;
export function getServerEnv() {
  return (_serverEnv ??= parseServerEnv({
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    FDC_API_KEY: process.env.FDC_API_KEY,
  }));
}
