"use client";

import { useActionState } from "react";
import { loginAction, type AuthState } from "@/app/auth/actions";

const initial: AuthState = {};

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(loginAction, initial);
  return (
    <main className="max-w-[360px] mx-auto my-[10vh] p-6">
      <h1>Log in</h1>
      <form action={formAction} className="grid gap-3">
        <input name="email" type="email" placeholder="Email" required autoComplete="email" />
        <input name="password" type="password" placeholder="Password" required autoComplete="current-password" />
        <button type="submit" disabled={pending}>{pending ? "…" : "Log in"}</button>
        {state.error ? <p role="alert" className="text-red-600">{state.error}</p> : null}
      </form>
      <p><a href="/signup">Have an invite? Sign up</a></p>
    </main>
  );
}
