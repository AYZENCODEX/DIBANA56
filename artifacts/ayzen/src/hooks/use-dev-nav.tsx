import { createContext, useContext, useState, useEffect, useCallback, useMemo, ReactNode } from "react";
import { useAuth } from "./use-auth";

export type NavType = "dev" | "user" | "admin" | "moderator" | "team_leader";

export interface DevNavItem {
  id: number;
  navType: NavType;
  parentId: number | null;
  level: number;
  label: string;
  icon: string;
  href: string | null;
  content: string | null;
  pluginSlug: string | null;
  enabled: boolean;
  sortOrder: number;
  isSeed: boolean;
  updatedAt: string;
}

export interface DevNavTreeLeaf extends DevNavItem {
  children: DevNavTreeLeaf[];
}

interface NavConfigResult {
  items: DevNavItem[];
  tree: DevNavTreeLeaf[];
  isLoading: boolean;
  refetch: () => void;
  addItem: (data: { parentId?: number; label: string; icon: string; href?: string }) => Promise<DevNavItem | null>;
  updateItem: (id: number, data: Partial<Pick<DevNavItem, "label" | "icon" | "href" | "enabled" | "sortOrder" | "content">>) => Promise<{ ok: boolean; error?: string }>;
  removeItem: (id: number) => Promise<{ ok: boolean; error?: string }>;
}

async function readError(r: Response, fallback: string): Promise<string> {
  try {
    const body = await r.json();
    return body?.error || `${fallback} (HTTP ${r.status})`;
  } catch {
    return `${fallback} (HTTP ${r.status})`;
  }
}

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

function buildTree(items: DevNavItem[]): DevNavTreeLeaf[] {
  const byParent = new Map<number | null, DevNavItem[]>();
  for (const item of items) {
    const key = item.parentId ?? null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(item);
  }
  const attach = (parentId: number | null): DevNavTreeLeaf[] =>
    (byParent.get(parentId) ?? [])
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(item => ({ ...item, children: attach(item.id) }));
  return attach(null);
}

/**
 * Generic hook backing every role's configurable sidebar (Dev/User/Admin/
 * Moderator/Team Leader) — same fetch/add/update/remove shape the Dev
 * sidebar used, now parameterized by navType so any role's nav can be
 * fetched or edited. Only devs/admins can write (enforced server-side too).
 */
export function useNavConfig(navType: NavType): NavConfigResult {
  const { token, isDev, isAdmin } = useAuth();
  const [items, setItems] = useState<DevNavItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const fetchItems = useCallback(async () => {
    if (!token) return;
    setIsLoading(true);
    try {
      const r = await fetch(`${BASE}/api/admin/nav/${navType}`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setItems(await r.json());
      else console.error("[dev-nav] fetch failed:", await readError(r, "Failed to load nav items"));
    } catch (e: any) { console.error("[dev-nav] fetch failed:", e?.message ?? e); }
    finally { setIsLoading(false); }
  }, [token, navType]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  const addItem = useCallback(async (data: { parentId?: number; label: string; icon: string; href?: string }) => {
    if (!token) return null;
    try {
      const r = await fetch(`${BASE}/api/admin/nav/${navType}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(data),
      });
      if (!r.ok) { console.error("[dev-nav] add failed:", await readError(r, "Failed to add item")); return null; }
      const created = await r.json();
      await fetchItems();
      return created as DevNavItem;
    } catch (e: any) {
      console.error("[dev-nav] add failed:", e?.message ?? e);
      return null;
    }
  }, [token, navType, fetchItems]);

  const updateItem = useCallback(async (id: number, data: Partial<Pick<DevNavItem, "label" | "icon" | "href" | "enabled" | "sortOrder" | "content">>) => {
    if (!token) return { ok: false, error: "Not signed in" };
    try {
      const r = await fetch(`${BASE}/api/admin/nav/${navType}/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(data),
      });
      if (!r.ok) return { ok: false, error: await readError(r, "Failed to update item") };
      await fetchItems();
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? "Network error" };
    }
  }, [token, navType, fetchItems]);

  const removeItem = useCallback(async (id: number) => {
    if (!token) return { ok: false, error: "Not signed in" };
    try {
      const r = await fetch(`${BASE}/api/admin/nav/${navType}/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return { ok: false, error: await readError(r, "Failed to remove item") };
      await fetchItems();
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? "Network error" };
    }
  }, [token, navType, fetchItems]);

  const tree = useMemo(() => buildTree(items), [items]);

  return { items, tree, isLoading, refetch: fetchItems, addItem, updateItem, removeItem };
}

// ── Back-compat: DevNavProvider/useDevNav (navType fixed to "dev") ─────────
// AppSidebar and existing pages used these before nav config went generic;
// kept working unchanged so nothing else needs touching.
const DevNavContext = createContext<NavConfigResult | null>(null);

export function DevNavProvider({ children }: { children: ReactNode }) {
  const value = useNavConfig("dev");
  return <DevNavContext.Provider value={value}>{children}</DevNavContext.Provider>;
}

export function useDevNav(): NavConfigResult {
  const ctx = useContext(DevNavContext);
  if (!ctx) throw new Error("useDevNav must be used within DevNavProvider");
  return ctx;
}
