import "./globals.css";
import type { ReactNode } from "react";
import { headers } from "next/headers";

export const metadata = { title: "Nutri-Shop", description: "Private nutrition tracker" };

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Reading a request-time API keeps this layout dynamic so Next.js injects the
  // CSP nonce (set on the request header in proxy.ts) onto its own scripts.
  await headers();
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
