"use client";

import type { ReactNode } from "react";

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title?: string; children: ReactNode }) {
  return (
    <div className={`fixed inset-0 z-50 ${open ? "" : "pointer-events-none"}`} aria-hidden={!open} inert={!open}>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className={`absolute inset-0 bg-black/50 transition-opacity ${open ? "opacity-100" : "opacity-0"}`}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title ?? "Dialog"}
        className={`absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-border bg-surface-2 p-4 pb-6 shadow-2xl transition-transform duration-200 ${
          open ? "translate-y-0" : "translate-y-full"
        }`}
      >
        <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-border" />
        {children}
      </div>
    </div>
  );
}
