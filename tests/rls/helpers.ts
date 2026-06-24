import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const SUPABASE_TEST_ENV = {
  url: process.env.SUPABASE_TEST_URL,
  anon: process.env.SUPABASE_TEST_ANON_KEY,
  service: process.env.SUPABASE_TEST_SERVICE_ROLE_KEY,
};

export const HAS_SUPABASE_TEST_ENV =
  !!SUPABASE_TEST_ENV.url && !!SUPABASE_TEST_ENV.anon && !!SUPABASE_TEST_ENV.service;

function need(name: keyof typeof SUPABASE_TEST_ENV): string {
  const v = SUPABASE_TEST_ENV[name];
  if (!v) throw new Error(`Missing required test env: SUPABASE_TEST_${name.toUpperCase()}`);
  return v;
}

export function anonClient(): SupabaseClient {
  return createClient(need("url"), need("anon"), { auth: { persistSession: false } });
}

export function admin(): SupabaseClient {
  return createClient(need("url"), need("service"), { auth: { persistSession: false } });
}

/** Invite + create a confirmed user, then return an anon client signed in as them. */
export async function makeUser(email: string, password: string): Promise<SupabaseClient> {
  const a = admin();
  await a.from("invites").upsert({ email }); // allowlist so the gate permits creation
  const { error: createErr } = await a.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // admin API creates a pre-confirmed user
  });
  if (
    createErr &&
    !/already.*registered|already.*exists/i.test(createErr.message) &&
    (createErr as { status?: number }).status !== 422 &&
    (createErr as { code?: string }).code !== "email_exists"
  ) {
    throw createErr;
  }

  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}
