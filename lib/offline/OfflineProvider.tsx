"use client";
import { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import { openListDb, loadOrCreateKey, deleteListDb, deleteForeignDbs, type ListDb } from "./db";
import { runSync, getDirtyCount } from "./sync";
import { signOutDecision } from "./signout-decision";
import { useOnlineStatus } from "./useOnlineStatus";

type OfflineReady = {
  status: "ready";
  db: ListDb;
  cryptoKey: CryptoKey;
  online: boolean;
  syncing: boolean;
  pending: number;
  sync: () => void;
  signOutAndWipe: () => Promise<void>;
};
type OfflineError = {
  status: "error";
  error: string;
  online: boolean;
  signOutAndWipe: () => Promise<void>;
};
type OfflineCtx = OfflineReady | OfflineError;

const Ctx = createContext<OfflineCtx | null>(null);

function postSignOut() {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = "/auth/signout";
  document.body.appendChild(form);
  form.submit();
}

export function useOffline(): OfflineCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useOffline must be used within OfflineProvider");
  return v;
}

export function OfflineProvider({ userId, children }: { userId: string; children: React.ReactNode }) {
  const online = useOnlineStatus();
  const [ready, setReady] = useState<{ db: ListDb; cryptoKey: CryptoKey } | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [pending, setPending] = useState(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // One-time setup: open DB, load key, purge foreign DBs. (Imperative browser
  // setup — not derived state. Cleanup on unmount/user change.)
  useEffect(() => {
    let cancelled = false;
    const db = openListDb(userId);
    (async () => {
      try {
        await deleteForeignDbs(userId);
        const cryptoKey = await loadOrCreateKey(db);
        if (!cancelled) setReady({ db, cryptoKey });
      } catch (e) {
        if (!cancelled) setSetupError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
      db.close();
    };
  }, [userId]);

  const doSync = useCallback(async () => {
    if (!ready || !navigator.onLine) return;
    setSyncing(true);
    try {
      await runSync(ready.db, ready.cryptoKey);
    } finally {
      setSyncing(false);
      setPending(await getDirtyCount(ready.db));
    }
  }, [ready]);

  const sync = useCallback(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void doSync(), 400);
  }, [doSync]);

  // Foreground triggers: initial-when-ready-online, online event, tab visible.
  // The initial sync is deferred with setTimeout so the effect body itself does
  // not call setState synchronously (which would cause cascading renders).
  useEffect(() => {
    if (!ready) return;
    const initialTimer = setTimeout(() => void doSync(), 0);
    const onOnline = () => void doSync();
    const onVisible = () => { if (document.visibilityState === "visible") void doSync(); };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    void getDirtyCount(ready.db).then(setPending);
    return () => {
      clearTimeout(initialTimer);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ready, doSync]);

  const signOutAndWipe = useCallback(async () => {
    if (!ready) { postSignOut(); return; }
    const dirty = await getDirtyCount(ready.db);
    const decision = signOutDecision(dirty, navigator.onLine);
    if (decision === "sync-then-wipe") await doSync();
    if (decision === "confirm-then-wipe") {
      const ok = window.confirm(`${dirty} unsynced change(s) will be lost. Sign out anyway?`);
      if (!ok) return;
    }
    await deleteListDb(userId);
    postSignOut();
  }, [ready, doSync, userId]);

  // Setup failed (e.g. a browser that cannot persist the key): keep the rest of
  // the app working online-only; /list and the sign-out control read status === "error".
  if (setupError) {
    return (
      <Ctx.Provider
        value={{
          status: "error",
          error: setupError,
          online,
          signOutAndWipe: async () => { postSignOut(); },
        }}
      >
        {children}
      </Ctx.Provider>
    );
  }
  if (!ready) return null; // brief: DB opening + key load
  return (
    <Ctx.Provider value={{ status: "ready", db: ready.db, cryptoKey: ready.cryptoKey, online, syncing, pending, sync, signOutAndWipe }}>
      {children}
    </Ctx.Provider>
  );
}
