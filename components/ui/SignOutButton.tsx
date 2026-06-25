"use client";
import { useOffline } from "@/lib/offline/OfflineProvider";
import { Button } from "@/components/ui/Button";

export function SignOutButton({ className }: { className?: string }) {
  const { signOutAndWipe } = useOffline();
  return (
    <Button type="button" variant="ghost" className={className} onClick={() => void signOutAndWipe()}>
      Sign out
    </Button>
  );
}
