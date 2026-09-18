import { useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

const BASE = (import.meta.env.BASE_URL ?? "").replace(/\/$/, "");

/**
 * Global SSE connection that keeps the React Query cache in sync with the server.
 *
 * Features:
 * - Passes auth token via ?token= (EventSource cannot send custom headers)
 * - Auto-reconnects with exponential backoff (1s → 2s → 4s → … → 30s max)
 * - Resumes on tab visibility change (avoids stale data after tab sleep)
 * - Handles all server-broadcast event types
 */
export function useRealtime() {
  const qc = useQueryClient();
  const esRef = useRef<EventSource | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCount = useRef(0);
  const unmounted = useRef(false);

  const connect = useCallback(() => {
    if (unmounted.current) return;

    // Clean up any existing connection before making a new one
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    const token = localStorage.getItem("ayzen_token");
    if (!token) return;

    const url = `${BASE}/api/events?token=${encodeURIComponent(token)}`;
    const es = new EventSource(url);
    esRef.current = es;

    const invalidate = (keys: string[][]) =>
      keys.forEach(key => qc.invalidateQueries({ queryKey: key }));

    // ── Event handlers ────────────────────────────────────────────────────────
    es.addEventListener("connected", () => {
      // Successful connection — reset backoff counter
      retryCount.current = 0;
    });

    es.addEventListener("tasks_updated", () =>
      invalidate([["tasks"], ["userStats"], ["project"]]));

    es.addEventListener("projects_updated", () =>
      invalidate([["projects"], ["project"]]));

    es.addEventListener("users_updated", () =>
      invalidate([["users"], ["me"], ["userStats"]]));

    es.addEventListener("leaderboard_updated", () =>
      invalidate([["leaderboard"]]));

    es.addEventListener("inbox_updated", () =>
      invalidate([["broadcasts"]]));

    es.addEventListener("vault_updated", () =>
      invalidate([["vaultEntries"]]));

    es.addEventListener("wallets_updated", () =>
      invalidate([["wallets"]]));

    // Vault wallet real-time deposits (ETH/BSC/Polygon/Plasma/Arbitrum) —
    // see services/deposit-watcher.ts. "detected" fires the moment a tx is
    // seen on-chain (still pending); "confirmed" fires once it's credited.
    es.addEventListener("deposit_detected", () =>
      invalidate([["deposits"], ["wallets"]]));

    es.addEventListener("deposit_confirmed", () =>
      invalidate([["deposits"], ["wallets"], ["ayzen-balance"]]));

    es.addEventListener("credits_updated", () =>
      invalidate([["credits"], ["userStats"]]));

    es.addEventListener("subscription_updated", () =>
      invalidate([["subscription"], ["userStats"]]));

    es.addEventListener("local_accounts_updated", () =>
      invalidate([["localAccounts"]]));

    es.addEventListener("submissions_updated", () =>
      invalidate([["tasks"], ["userStats"], ["project"]]));

    es.addEventListener("data_updated", () => qc.invalidateQueries());

    // ── Auto-reconnect with exponential backoff ───────────────────────────────
    es.onerror = () => {
      es.close();
      esRef.current = null;
      if (unmounted.current) return;

      const delay = Math.min(1000 * Math.pow(2, retryCount.current++), 30_000);
      retryRef.current = setTimeout(connect, delay);
    };
  }, [qc]);

  useEffect(() => {
    unmounted.current = false;
    connect();

    // Reconnect when the user returns to the tab (browser may have closed the
    // SSE connection while the tab was hidden/sleeping)
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        if (retryRef.current) { clearTimeout(retryRef.current); retryRef.current = null; }
        connect();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      unmounted.current = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (retryRef.current) clearTimeout(retryRef.current);
      esRef.current?.close();
      esRef.current = null;
    };
  }, [connect]);
}

/**
 * Hook for components that need to subscribe to a specific SSE event
 * and run a custom callback (e.g., project detail live refresh).
 */
export function useSSEEvent(
  event: string,
  callback: (data: any) => void,
  deps: React.DependencyList = [],
) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    const token = localStorage.getItem("ayzen_token");
    if (!token) return;

    const url = `${BASE}/api/events?token=${encodeURIComponent(token)}`;
    const es = new EventSource(url);
    let retries = 0;

    const handler = (e: MessageEvent) => {
      try { callbackRef.current(JSON.parse(e.data)); } catch {}
    };
    es.addEventListener(event, handler);

    let retryTimer: ReturnType<typeof setTimeout>;
    es.onerror = () => {
      es.close();
      const delay = Math.min(1000 * Math.pow(2, retries++), 30_000);
      retryTimer = setTimeout(() => {}, delay); // placeholder; component cleanup handles it
    };

    return () => {
      clearTimeout(retryTimer);
      es.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
