"use client";

import { useActionState } from "react";
import { signupAction, type AuthState } from "@/app/auth/actions";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

const initial: AuthState = {};

export default function SignupPage() {
  const [state, formAction, pending] = useActionState(signupAction, initial);
  return (
    <main className="mx-auto w-full max-w-[360px] px-6 py-[12vh]">
      <h1 className="mb-2 text-2xl font-semibold">Sign up</h1>
      <p className="mb-6 text-sm text-muted">Invite-only. Use the email you were invited with.</p>
      <form action={formAction} className="grid gap-3">
        <Input name="email" type="email" placeholder="Email" required autoComplete="email" />
        <Input name="password" type="password" placeholder="Password (10+ chars)" required autoComplete="new-password" />
        <Button type="submit" disabled={pending}>{pending ? "…" : "Create account"}</Button>
        {state.error ? <p role="alert" className="text-sm text-danger">{state.error}</p> : null}
        {state.ok ? <p className="text-sm text-protein">Check your email to confirm your account.</p> : null}
      </form>
    </main>
  );
}
