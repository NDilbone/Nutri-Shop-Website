import "./globals.css";
import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Inter } from "next/font/google";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "Nutri-Shop",
  description: "Private nutrition tracker",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Nutri-Shop", statusBarStyle: "black-translucent" },
  icons: {
    icon: "/icons/icon-192.png",
    apple: "/icons/apple-touch-icon-180.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#0f1411",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Reading a request-time API keeps this layout dynamic so Next.js injects the
  // CSP nonce (set on the request header in proxy.ts) onto its own scripts.
  await headers();
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
