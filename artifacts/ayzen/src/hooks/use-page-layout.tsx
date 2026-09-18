import { useState, useEffect, useCallback, useMemo } from "react";
import { useAuth } from "./use-auth";

export interface LayoutSectionRow {
  id: number;
  pageKey: string;
  sectionKey: string;
  sortOrder: number;
  visible: boolean;
  label: string;
  updatedAt: string;
}

export interface LayoutPageInfo {
  pageKey: string;
  label: string;
  sectionCount: number;
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

/** Lists every page registered in the Layout Builder — for the page picker. */
export function useLayoutPages() {
  const { token } = useAuth();
  const [pages, setPages] = useState<LayoutPageInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refetch = useCallback(async () => {
    if (!token) return;
    setIsLoading(true);
    try {
      const r = await fetch(`${BASE}/api/admin/layout/pages`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setPages(await r.json());
      else console.error("[layout-builder] fetch pages failed:", await readError(r, "Failed to load pages"));
    } catch (e: any) { console.error("[layout-builder] fetch pages failed:", e?.message ?? e); }
    finally { setIsLoading(false); }
  }, [token]);

  useEffect(() => { refetch(); }, [refetch]);
  return { pages, isLoading, refetch };
}

/**
 * Full editor for one page's section order + visibility — used by the
 * Layout Builder UI (drag to reorder, switch to toggle, then save()).
 */
export function useLayoutEditor(pageKey: string) {
  const { token } = useAuth();
  const [sections, setSections] = useState<LayoutSectionRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const fetchSections = useCallback(async () => {
    if (!token || !pageKey) return;
    setIsLoading(true);
    try {
      const r = await fetch(`${BASE}/api/admin/layout/${pageKey}`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setSections(await r.json());
      else console.error("[layout-builder] fetch failed:", await readError(r, "Failed to load layout"));
    } catch (e: any) { console.error("[layout-builder] fetch failed:", e?.message ?? e); }
    finally { setIsLoading(false); }
  }, [token, pageKey]);

  useEffect(() => { fetchSections(); }, [fetchSections]);

  const save = useCallback(async (updated: LayoutSectionRow[]) => {
    if (!token) return { ok: false as const, error: "Not signed in" };
    try {
      const r = await fetch(`${BASE}/api/admin/layout/${pageKey}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          sections: updated.map((s, i) => ({ sectionKey: s.sectionKey, sortOrder: i, visible: s.visible })),
        }),
      });
      if (!r.ok) return { ok: false as const, error: await readError(r, "Failed to save layout") };
      setSections(await r.json());
      return { ok: true as const };
    } catch (e: any) {
      return { ok: false as const, error: e?.message ?? "Network error" };
    }
  }, [token, pageKey]);

  return { sections, setSections, isLoading, refetch: fetchSections, save };
}

/**
 * Lightweight reader for a page to call directly: returns the ordered list
 * of visible section keys, falling back to `defaultOrder` (the page's
 * current hardcoded order) while loading or if nothing's configured yet —
 * so the page never renders with zero sections.
 */
export function usePageLayoutOrder(pageKey: string, defaultOrder: string[]): string[] {
  const { token } = useAuth();
  const [rows, setRows] = useState<{ sectionKey: string; sortOrder: number; visible: boolean }[] | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch(`${BASE}/api/layout/${pageKey}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then((data) => { if (!cancelled) setRows(data); })
      .catch(() => { if (!cancelled) setRows(null); });
    return () => { cancelled = true; };
  }, [token, pageKey]);

  return useMemo(() => {
    if (!rows || rows.length === 0) return defaultOrder;
    const visible = rows.filter(r => r.visible).map(r => r.sectionKey);
    return visible.length > 0 ? visible : defaultOrder;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);
}
