"use client";

import { useActionState } from "react";
import { signupAction, type AuthState } from "@/app/auth/actions";

const initial: AuthState = {};

export default function SignupPage() {
  const [state, formAction, pending] = useActionState(signupAction, initial);
  return (
    <main className="max-w-[360px] mx-auto my-[10vh] p-6">
      <h1>Sign up</h1>
      <p className="text-[13px] opacity-80">Invite-only. Use the email you were invited with.</p>
      <form action={formAction} className="grid gap-3">
        <input name="email" type="email" placeholder="Email" required autoComplete="email" />
        <input name="password" type="password" placeholder="Password (10+ chars)" required autoComplete="new-password" />
        <button type="submit" disabled={pending}>{pending ? "…" : "Create account"}</button>
        {state.error ? <p role="alert" className="text-red-600">{state.error}</p> : null}
        {state.ok ? <p>Check your email to confirm your account.</p> : null}
      </form>
    </main>
  );
}
