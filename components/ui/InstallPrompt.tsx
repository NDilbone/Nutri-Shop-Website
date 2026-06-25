"use client";

import { useState, useSyncExternalStore } from "react";
import { getInstallState } from "@/lib/pwa/install";

const DISMISS_KEY = "ns:install-dismissed";

type BIPEvent = Event & { prompt: () => Promise<void> };

// --- window-global install event store (survives re-renders, set up once) ---
let deferred: BIPEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function ensureGlobalListeners() {
  if (typeof window === "undefined") return;
  const w = window as unknown as { __nsInstallInit?: boolean };
  if (w.__nsInstallInit) return;
  w.__nsInstallInit = true;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as BIPEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    installed = true;
    deferred = null;
    emit();
  });
}

function subscribe(cb: () => void) {
  ensureGlobalListeners();
  listeners.add(cb);
  return () => listeners.delete(cb);
}
const getSnapshot = () => `${deferred ? "1" : "0"}:${installed ? "1" : "0"}`;
const getServerSnapshot = () => "0:0";

// SSR-safe "are we on the client yet" — no effect, no hydration mismatch.
const useIsClient = () =>
  useSyncExternalStore(() => () => {}, () => true, () => false);

export function InstallPrompt() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const isClient = useIsClient();
  const [dismissed, setDismissed] = useState(false);
  const [read, setRead] = useState(false);

  // render-time init of persisted dismissal (client only, once)
  if (isClient && !read) {
    setRead(true);
    setDismissed(localStorage.getItem(DISMISS_KEY) === "1");
  }

  if (!isClient) return null;

  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  const ua = window.navigator.userAgent;
  const isIosSafari =
    /iP(hone|ad|od)/.test(ua) && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);

  const state = getInstallState({
    standalone,
    isIosSafari,
    canPrompt: snap.startsWith("1"),
    dismissed,
  });
  if (state === "hidden") return null;

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, "1");
    setDismissed(true);
  };

  return (
    <div className="fixed inset-x-0 bottom-24 z-30 mx-auto flex w-fit max-w-[92vw] items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-sm shadow-2xl lg:bottom-6 lg:left-6 lg:right-auto lg:mx-0">
      {state === "chromium-button" ? (
        <button
          type="button"
          className="rounded-md bg-brand px-3 py-1.5 font-medium text-[#08130b]"
          onClick={async () => {
            const evt = deferred;
            if (!evt) return;
            await evt.prompt();
            deferred = null;
            emit();
          }}
        >
          Install Nutri-Shop
        </button>
      ) : (
        <span className="text-muted">
          Install: tap <span aria-hidden>⎙</span> Share → “Add to Home Screen”
        </span>
      )}
      <button type="button" aria-label="Dismiss" className="text-muted" onClick={dismiss}>
        ✕
      </button>
    </div>
  );
}
