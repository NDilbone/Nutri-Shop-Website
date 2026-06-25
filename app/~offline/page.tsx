import { RetryButton } from "./RetryButton";

export const metadata = { title: "Offline · Nutri-Shop" };

// Static, data-free: the SW serves this when a document navigation fails offline.
export default function OfflinePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-[480px] flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="text-2xl font-bold text-brand">Nutri-Shop</div>
      <h1 className="text-lg font-semibold">You&apos;re offline</h1>
      <p className="text-sm text-muted">Reconnect to log food and update your shopping list.</p>
      <RetryButton />
    </main>
  );
}
