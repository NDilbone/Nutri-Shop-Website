"use client";

export function SyncStatus({
  online,
  syncing,
  pending,
  error,
}: {
  online: boolean;
  syncing: boolean;
  pending: number;
  error?: string;
}) {
  if (error) {
    return (
      <div className="mb-3 rounded-md border border-border/50 bg-surface px-3 py-2 text-xs text-muted">
        <span className="font-medium text-foreground">Offline list unavailable.</span>{" "}
        {error}
      </div>
    );
  }

  let label: string;
  let dot = "bg-muted";

  if (!online) {
    label = "Offline";
    dot = "bg-muted";
  } else if (syncing) {
    label = "Syncing…";
    dot = "bg-brand";
  } else if (pending > 0) {
    label = `${pending} pending`;
    dot = "bg-brand/60";
  } else {
    label = "Synced";
    dot = "bg-brand";
  }

  return (
    <div className="mb-3 flex items-center gap-1.5 text-xs text-muted">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden="true" />
      {label}
    </div>
  );
}
