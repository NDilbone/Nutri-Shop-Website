import "server-only";
import { createClient } from "@/lib/supabase/server";

export class RateLimitError extends Error {
  constructor() {
    super("Rate limit exceeded");
    this.name = "RateLimitError";
  }
}

/** Per-user fixed-window throttle. Identity is taken from the session inside the
 *  SECURITY DEFINER DB function; the limit + window are SQL constants (not passed
 *  here) so a client cannot tune them. No service-role client is needed. */
export async function enforceRateLimit(): Promise<void> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("check_and_increment_rate");
  if (error) throw new Error(`rate limit check failed: ${error.message}`);
  if (data !== true) throw new RateLimitError();
}
