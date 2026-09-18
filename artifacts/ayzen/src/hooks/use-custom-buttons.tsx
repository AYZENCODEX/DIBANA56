import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react";
import { useAuth } from "./use-auth";

export type CustomButtonPosition = "bottom-right" | "bottom-left" | "top-right" | "top-left";
export type CustomButtonVariant = "solid" | "outline" | "ghost";
export type CustomButtonColor = "primary" | "secondary" | "accent" | "success" | "warning" | "danger";
export type CustomButtonShape = "pill" | "rounded" | "square";
export type CustomButtonSize = "sm" | "md" | "lg";

export interface CustomButton {
  id: number;
  label: string;
  icon: string;
  href: string;
  external: boolean;
  position: CustomButtonPosition;
  variant: CustomButtonVariant;
  color: CustomButtonColor;
  shape: CustomButtonShape;
  size: CustomButtonSize;
  enabled: boolean;
  sortOrder: number;
  updatedAt: string;
}

export type CustomButtonInput = Partial<Omit<CustomButton, "id" | "updatedAt">> & { label?: string; href?: string };

interface CustomButtonsContextType {
  buttons: CustomButton[];              // enabled-only, for site-wide rendering
  adminButtons: CustomButton[];         // all buttons incl. disabled, for the admin page
  isLoading: boolean;
  refresh: () => Promise<void>;
  refreshAdmin: () => Promise<void>;
  createButton: (data: CustomButtonInput) => Promise<CustomButton | null>;
  updateButton: (id: number, data: CustomButtonInput) => Promise<CustomButton | null>;
  deleteButton: (id: number) => Promise<void>;
}

const CustomButtonsContext = createContext<CustomButtonsContextType | null>(null);

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
const STORAGE_KEY = "ayzen_ui_custom_buttons_cache";

export function CustomButtonsProvider({ children }: { children: ReactNode }) {
  const { token } = useAuth();
  const [buttons, setButtons] = useState<CustomButton[]>(() => {
    try {
      const cached = localStorage.getItem(STORAGE_KEY);
      return cached ? JSON.parse(cached) : [];
    } catch { return []; }
  });
  const [adminButtons, setAdminButtons] = useState<CustomButton[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!token) return;
    setIsLoading(true);
    try {
      const r = await fetch(`${BASE}/api/ui-custom-buttons`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) {
        const data: CustomButton[] = await r.json();
        setButtons(data);
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch { }
      }
    } catch { }
    finally { setIsLoading(false); }
  }, [token]);

  const refreshAdmin = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetch(`${BASE}/api/admin/ui-custom-buttons`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setAdminButtons(await r.json());
    } catch { }
  }, [token]);

  useEffect(() => { refresh(); }, [refresh]);

  const createButton = useCallback(async (data: CustomButtonInput) => {
    if (!token) return null;
    const r = await fetch(`${BASE}/api/admin/ui-custom-buttons`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(data),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: "Failed to create button" }));
      throw new Error(err.error || "Failed to create button");
    }
    const created: CustomButton = await r.json();
    await Promise.all([refresh(), refreshAdmin()]);
    return created;
  }, [token, refresh, refreshAdmin]);

  const updateButton = useCallback(async (id: number, data: CustomButtonInput) => {
    if (!token) return null;
    const r = await fetch(`${BASE}/api/admin/ui-custom-buttons/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(data),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: "Failed to update button" }));
      throw new Error(err.error || "Failed to update button");
    }
    const updated: CustomButton = await r.json();
    await Promise.all([refresh(), refreshAdmin()]);
    return updated;
  }, [token, refresh, refreshAdmin]);

  const deleteButton = useCallback(async (id: number) => {
    if (!token) return;
    const r = await fetch(`${BASE}/api/admin/ui-custom-buttons/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.ok) await Promise.all([refresh(), refreshAdmin()]);
  }, [token, refresh, refreshAdmin]);

  return (
    <CustomButtonsContext.Provider value={{
      buttons, adminButtons, isLoading, refresh, refreshAdmin, createButton, updateButton, deleteButton,
    }}>
      {children}
    </CustomButtonsContext.Provider>
  );
}

export function useCustomButtons() {
  const ctx = useContext(CustomButtonsContext);
  if (!ctx) throw new Error("useCustomButtons must be used within CustomButtonsProvider");
  return ctx;
}
