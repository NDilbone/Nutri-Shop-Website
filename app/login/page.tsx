"use client";

import { useActionState } from "react";
import { loginAction, type AuthState } from "@/app/auth/actions";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

const initial: AuthState = {};

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(loginAction, initial);
  return (
    <main className="mx-auto w-full max-w-[360px] px-6 py-[12vh]">
      <h1 className="mb-6 text-2xl font-semibold">Log in</h1>
      <form action={formAction} className="grid gap-3">
        <Input name="email" type="email" placeholder="Email" required autoComplete="email" />
        <Input name="password" type="password" placeholder="Password" required autoComplete="current-password" />
        <Button type="submit" disabled={pending}>{pending ? "…" : "Log in"}</Button>
        {state.error ? <p role="alert" className="text-sm text-danger">{state.error}</p> : null}
      </form>
      <p className="mt-4 text-sm text-muted"><a href="/signup" className="underline">Have an invite? Sign up</a></p>
    </main>
  );
}
