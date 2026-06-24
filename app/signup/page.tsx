"use client";

import { useActionState } from "react";
import { signupAction, type AuthState } from "@/app/auth/actions";

const initial: AuthState = {};

export default function SignupPage() {
  const [state, formAction, pending] = useActionState(signupAction, initial);
  return (
    <main style={{ maxWidth: 360, margin: "10vh auto", padding: 24 }}>
      <h1>Sign up</h1>
      <p style={{ fontSize: 13, opacity: 0.8 }}>Invite-only. Use the email you were invited with.</p>
      <form action={formAction} style={{ display: "grid", gap: 12 }}>
        <input name="email" type="email" placeholder="Email" required autoComplete="email" />
        <input name="password" type="password" placeholder="Password (10+ chars)" required autoComplete="new-password" />
        <button type="submit" disabled={pending}>{pending ? "…" : "Create account"}</button>
        {state.error ? <p role="alert" style={{ color: "crimson" }}>{state.error}</p> : null}
        {state.ok ? <p>Check your email to confirm your account.</p> : null}
      </form>
    </main>
  );
}
