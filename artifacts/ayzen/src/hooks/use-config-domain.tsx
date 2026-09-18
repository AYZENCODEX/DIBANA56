import { useState, useEffect, useCallback } from "react";
import { useAuth } from "./use-auth";

export interface ConfigEntry {
  id: number;
  domain: string;
  data: Record<string, unknown>;
  sortOrder: number;
  enabled: boolean;
  isSeed: boolean;
  updatedAt: string;
}

export interface ConfigDomainInfo {
  domain: string;
  label: string;
  count: number;
}

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

async function readError(r: Response, fallback: string): Promise<string> {
  try {
    const body = await r.json();
    return body?.error || `${fallback} (HTTP ${r.status})`;
  } catch {
    return `${fallback} (HTTP ${r.status})`;
  }
}

/**
 * Lists every registered Config Manager domain (for the domain picker).
 */
export function useConfigDomains() {
  const { token } = useAuth();
  const [domains, setDomains] = useState<ConfigDomainInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refetch = useCallback(async () => {
    if (!token) return;
    setIsLoading(true);
    try {
      const r = await fetch(`${BASE}/api/admin/config/domains`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setDomains(await r.json());
      else console.error("[config-manager] fetch domains failed:", await readError(r, "Failed to load domains"));
    } catch (e: any) { console.error("[config-manager] fetch domains failed:", e?.message ?? e); }
    finally { setIsLoading(false); }
  }, [token]);

  useEffect(() => { refetch(); }, [refetch]);
  return { domains, isLoading, refetch };
}

/**
 * Generic CRUD for one Config Manager domain's flat entry list. Any page
 * can call this with its domain slug to read live-editable config instead
 * of importing a static array — see marketplace-azn.tsx for the first
 * page wired this way.
 */
export function useConfigDomain(domain: string) {
  const { token } = useAuth();
  const [entries, setEntries] = useState<ConfigEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const fetchEntries = useCallback(async () => {
    if (!token || !domain) return;
    setIsLoading(true);
    try {
      const r = await fetch(`${BASE}/api/admin/config/${domain}`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setEntries(await r.json());
      else console.error("[config-manager] fetch failed:", await readError(r, "Failed to load config"));
    } catch (e: any) { console.error("[config-manager] fetch failed:", e?.message ?? e); }
    finally { setIsLoading(false); }
  }, [token, domain]);

  useEffect(() => { fetchEntries(); }, [fetchEntries]);

  const addEntry = useCallback(async (data: Record<string, unknown>) => {
    if (!token) return { ok: false as const, error: "Not signed in" };
    try {
      const r = await fetch(`${BASE}/api/admin/config/${domain}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ data }),
      });
      if (!r.ok) return { ok: false as const, error: await readError(r, "Failed to add entry") };
      await fetchEntries();
      return { ok: true as const };
    } catch (e: any) {
      return { ok: false as const, error: e?.message ?? "Network error" };
    }
  }, [token, domain, fetchEntries]);

  const updateEntry = useCallback(async (id: number, patch: { data?: Record<string, unknown>; enabled?: boolean; sortOrder?: number }) => {
    if (!token) return { ok: false as const, error: "Not signed in" };
    try {
      const r = await fetch(`${BASE}/api/admin/config/${domain}/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(patch),
      });
      if (!r.ok) return { ok: false as const, error: await readError(r, "Failed to update entry") };
      await fetchEntries();
      return { ok: true as const };
    } catch (e: any) {
      return { ok: false as const, error: e?.message ?? "Network error" };
    }
  }, [token, domain, fetchEntries]);

  const removeEntry = useCallback(async (id: number) => {
    if (!token) return { ok: false as const, error: "Not signed in" };
    try {
      const r = await fetch(`${BASE}/api/admin/config/${domain}/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return { ok: false as const, error: await readError(r, "Failed to remove entry") };
      await fetchEntries();
      return { ok: true as const };
    } catch (e: any) {
      return { ok: false as const, error: e?.message ?? "Network error" };
    }
  }, [token, domain, fetchEntries]);

  return { entries, isLoading, refetch: fetchEntries, addEntry, updateEntry, removeEntry };
}
