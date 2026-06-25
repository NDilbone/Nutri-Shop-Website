"use client";

import { Button } from "@/components/ui/Button";

export function RetryButton() {
  return <Button onClick={() => location.reload()}>Retry</Button>;
}
