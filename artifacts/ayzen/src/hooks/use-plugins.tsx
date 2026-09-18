import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react";
import { useAuth } from "./use-auth";

export interface Plugin {
  id: number;
  slug: string;
  name: string;
  enabled: boolean;
  config: string | null;
  updatedAt: string;
}

interface PluginsContextType {
  plugins: Plugin[];
  isLoading: boolean;
  isEnabled: (slug: string) => boolean;
  toggle: (slug: string, enabled: boolean) => Promise<void>;
  updateConfig: (slug: string, config: Record<string, unknown>) => Promise<void>;
  refetch: () => void;
}

const PluginsContext = createContext<PluginsContextType | null>(null);

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

export function PluginsProvider({ children }: { children: ReactNode }) {
  const { token, isAdmin } = useAuth();
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const fetchPlugins = useCallback(async () => {
    if (!token) return;
    setIsLoading(true);
    try {
      const r = await fetch(`${BASE}/api/admin/plugins`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setPlugins(await r.json());
    } catch { }
    finally { setIsLoading(false); }
  }, [token]);

  useEffect(() => {
    fetchPlugins();
  }, [fetchPlugins]);

  const isEnabled = useCallback((slug: string) => {
    const p = plugins.find(x => x.slug === slug);
    return p ? p.enabled : true;
  }, [plugins]);

  const toggle = useCallback(async (slug: string, enabled: boolean) => {
    if (!token) return;
    const r = await fetch(`${BASE}/api/admin/plugins/${slug}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ enabled }),
    });
    if (r.ok) {
      const updated = await r.json();
      setPlugins(prev => prev.map(p => p.slug === slug ? updated : p));
    }
  }, [token]);

  const updateConfig = useCallback(async (slug: string, config: Record<string, unknown>) => {
    if (!token) return;
    await fetch(`${BASE}/api/admin/plugins/${slug}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ config }),
    });
    await fetchPlugins();
  }, [token, fetchPlugins]);

  return (
    <PluginsContext.Provider value={{ plugins, isLoading, isEnabled, toggle, updateConfig, refetch: fetchPlugins }}>
      {children}
    </PluginsContext.Provider>
  );
}

export function usePlugins() {
  const ctx = useContext(PluginsContext);
  if (!ctx) throw new Error("usePlugins must be used within PluginsProvider");
  return ctx;
}
