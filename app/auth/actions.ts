"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { credentialsSchema, emailSchema } from "@/lib/validation/auth";

export type AuthState = { error?: string; ok?: boolean };

// Trusted redirect base for auth emails — NEVER derived from the request Origin
// header (attacker-controllable). Supabase's redirect allowlist is the backstop.
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export async function loginAction(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = credentialsSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) return { error: "Enter a valid email and password." };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return { error: "Invalid login." }; // do not leak which field failed

  revalidatePath("/", "layout"); // re-render cached layouts with the new auth state
  redirect("/today");
}

export async function signupAction(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = credentialsSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) return { error: "Enter a valid email and password (10+ chars)." };

  const supabase = await createClient();
  const { error } = await supabase.auth.signUp({
    ...parsed.data,
    options: { emailRedirectTo: `${siteUrl}/auth/confirm` },
  });
  // The DB invite-gate trigger rejects non-invited emails; keep the message generic.
  if (error) return { error: "Signup is invite-only or the email is already registered." };
  return { ok: true };
}

export async function requestPasswordResetAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const parsed = emailSchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) return { error: "Enter a valid email." };

  const supabase = await createClient();
  await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${siteUrl}/auth/confirm`,
  });
  // Always report success — do not reveal whether the email exists.
  return { ok: true };
}
