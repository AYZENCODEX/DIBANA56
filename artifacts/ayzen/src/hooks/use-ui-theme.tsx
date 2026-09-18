import { createContext, useContext, useState, useEffect, useCallback, useMemo, ReactNode } from "react";
import { useLocation } from "wouter";
import { useAuth } from "./use-auth";
import { getPalette, applyContrast, type Palette, type PaletteVars } from "@/lib/theme-palettes";
import { findBestPageMatch } from "@/lib/route-config";

export interface UiTheme {
  id: number;
  paletteId: string; // built-in palette id, or "custom:<id>" for an uploaded theme
  contrast: "normal" | "high";
  density: "compact" | "comfortable" | "spacious";
  textSize: "sm" | "md" | "lg";
  fontFamily: "mono" | "sans" | "serif";
  radius: "sharp" | "soft" | "round";
  sidebarWidth: "narrow" | "default" | "wide";
  sidebarAnimationSpeed: "off" | "fast" | "normal" | "slow";
  updatedAt: string;
}

export interface CustomTheme extends Palette {
  dbId: number;
}

/** A per-page override — every field is optional; unset fields fall back to
 *  the global theme. `pageKey` is a route pattern from route-config.tsx
 *  (e.g. "/vault" or "/projects/:id"), so one override applies to every
 *  concrete URL that pattern matches (all project detail pages, etc). */
export type ThemeOverridableFields = Partial<Pick<UiTheme,
  "paletteId" | "contrast" | "density" | "textSize" | "fontFamily" | "radius" | "sidebarWidth" | "sidebarAnimationSpeed"
>>;

export interface PageThemeOverride extends ThemeOverridableFields {
  dbId: number;
  pageKey: string;
  updatedAt: string;
}

const DEFAULT_THEME: UiTheme = {
  id: 0, paletteId: "ash", contrast: "normal", density: "comfortable",
  textSize: "md", fontFamily: "mono", radius: "soft",
  sidebarWidth: "default", sidebarAnimationSpeed: "normal", updatedAt: "",
};

const TEXT_SIZE_PX: Record<UiTheme["textSize"], string> = { sm: "14px", md: "16px", lg: "18px" };
const SIDEBAR_WIDTH_REM: Record<UiTheme["sidebarWidth"], string> = { narrow: "14rem", default: "16rem", wide: "19rem" };
const ROW_PADDING: Record<UiTheme["density"], { row: string; group: string }> = {
  compact: { row: "0.375rem", group: "0.25rem" },
  comfortable: { row: "0.5rem", group: "0.375rem" },
  spacious: { row: "0.75rem", group: "0.5rem" },
};

// Animation duration by speed — "off" collapses instantly, matching the old
// boolean's "false" state exactly.
const ANIM_DURATION_MS: Record<UiTheme["sidebarAnimationSpeed"], string> = {
  off: "0ms", fast: "150ms", normal: "260ms", slow: "420ms",
};

// Font stacks — no new webfonts fetched at runtime; sans/serif fall back to
// system stacks so switching is instant with zero network cost.
const FONT_STACKS: Record<UiTheme["fontFamily"], { sans: string; mono: string }> = {
  mono:  { sans: "'Space Mono', 'Inter', monospace, sans-serif", mono: "'Space Mono', monospace" },
  sans:  { sans: "'Inter', system-ui, -apple-system, sans-serif", mono: "'Inter', system-ui, sans-serif" },
  serif: { sans: "'IBM Plex Serif', Georgia, 'Times New Roman', serif", mono: "Georgia, 'Times New Roman', serif" },
};

// Border-radius scale — "soft" mirrors the shipped defaults so picking it
// back never changes anything visually.
const RADIUS_SCALE: Record<UiTheme["radius"], { sm: string; md: string; lg: string; xl: string }> = {
  sharp: { sm: "0px", md: "0px", lg: "2px", xl: "2px" },
  soft:  { sm: "2px", md: "4px", lg: "8px", xl: "12px" },
  round: { sm: "6px", md: "10px", lg: "16px", xl: "22px" },
};

const STORAGE_KEY = "ayzen_ui_theme_cache";
const CUSTOM_STORAGE_KEY = "ayzen_ui_custom_themes_cache";
const PAGE_OVERRIDE_STORAGE_KEY = "ayzen_ui_page_overrides_cache";
const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

/** Resolves a theme's paletteId to an actual Palette — built-in or uploaded. */
export function resolvePalette(paletteId: string, customThemes: CustomTheme[]): Palette {
  if (paletteId.startsWith("custom:")) {
    const found = customThemes.find(c => c.id === paletteId);
    if (found) return found;
  }
  return getPalette(paletteId);
}

function applyThemeToDom(theme: UiTheme, customThemes: CustomTheme[]) {
  const palette = resolvePalette(theme.paletteId, customThemes);
  const vars: PaletteVars = applyContrast(palette.vars, theme.contrast, !!palette.isLight);
  const root = document.documentElement;

  const set = (name: string, value: string) => root.style.setProperty(name, value);
  set("--background", vars.background);
  set("--foreground", vars.foreground);
  set("--card", vars.card);
  set("--card-foreground", vars.cardForeground);
  set("--card-border", vars.cardBorder);
  set("--popover", vars.popover);
  set("--popover-foreground", vars.popoverForeground);
  set("--popover-border", vars.popoverBorder);
  set("--primary", vars.primary);
  set("--primary-foreground", vars.primaryForeground);
  set("--secondary", vars.secondary);
  set("--secondary-foreground", vars.secondaryForeground);
  set("--muted", vars.muted);
  set("--muted-foreground", vars.mutedForeground);
  set("--accent", vars.accent);
  set("--accent-foreground", vars.accentForeground);
  set("--border", vars.border);
  set("--input", vars.input);
  set("--ring", vars.ring);
  set("--sidebar-background", vars.sidebarBackground);
  set("--sidebar-foreground", vars.sidebarForeground);
  set("--sidebar-primary", vars.sidebarPrimary);
  set("--sidebar-primary-foreground", vars.sidebarPrimaryForeground);
  set("--sidebar-accent", vars.sidebarAccent);
  set("--sidebar-accent-foreground", vars.sidebarAccentForeground);
  set("--sidebar-border", vars.sidebarBorder);
  set("--sidebar-ring", vars.sidebarRing);

  set("--sidebar-w", SIDEBAR_WIDTH_REM[theme.sidebarWidth]);
  set("--sidebar-row-py", ROW_PADDING[theme.density].row);
  set("--sidebar-group-py", ROW_PADDING[theme.density].group);
  set("--sidebar-anim-duration", ANIM_DURATION_MS[theme.sidebarAnimationSpeed] ?? "260ms");
  root.style.fontSize = TEXT_SIZE_PX[theme.textSize];

  // Font — indirection vars consumed by index.css (--font-sans / --font-mono).
  const fonts = FONT_STACKS[theme.fontFamily] ?? FONT_STACKS.mono;
  set("--ui-font-sans", fonts.sans);
  set("--ui-font-mono", fonts.mono);

  // Style / corner radius — indirection vars consumed by index.css.
  const radii = RADIUS_SCALE[theme.radius] ?? RADIUS_SCALE.soft;
  set("--ui-radius-sm", radii.sm);
  set("--ui-radius-md", radii.md);
  set("--ui-radius-lg", radii.lg);
  set("--ui-radius-xl", radii.xl);

  root.setAttribute("data-palette", theme.paletteId);
  root.setAttribute("data-contrast", theme.contrast);
  root.classList.toggle("theme-light-palette", !!palette.isLight);
}

interface UiThemeContextType {
  theme: UiTheme;
  customThemes: CustomTheme[];
  isLoading: boolean;
  update: (patch: Partial<Pick<UiTheme, "paletteId" | "contrast" | "density" | "textSize" | "fontFamily" | "radius" | "sidebarWidth" | "sidebarAnimationSpeed">>) => Promise<void>;
  uploadCustomTheme: (payload: { name: string; description?: string; isLight?: boolean; swatch?: [string, string, string]; vars: PaletteVars }) => Promise<CustomTheme | null>;
  deleteCustomTheme: (id: string) => Promise<void>;
  refreshCustomThemes: () => Promise<void>;
  /** All saved per-page overrides (any authenticated user gets these, same
   *  as customThemes, so the effective theme can be resolved for everyone). */
  pageOverrides: PageThemeOverride[];
  /** Current route pathname, kept in sync by <ThemeRouteSync/> mounted inside
   *  the wouter Router. Consumers rarely need to read this directly. */
  activePath: string;
  setActivePath: (path: string) => void;
  /** Theme actually applied right now: global theme + matching page override. */
  effectiveTheme: UiTheme;
  /** The override row (if any) that applies to a given page pattern — used
   *  by the Theme Studio "Per-Page Overrides" editor. */
  getOverrideForPage: (pageKey: string) => PageThemeOverride | undefined;
  savePageOverride: (pageKey: string, patch: ThemeOverridableFields) => Promise<void>;
  deletePageOverride: (pageKey: string) => Promise<void>;
}

const UiThemeContext = createContext<UiThemeContextType | null>(null);

export function UiThemeProvider({ children }: { children: ReactNode }) {
  const { token } = useAuth();
  const [theme, setTheme] = useState<UiTheme>(() => {
    try {
      const cached = localStorage.getItem(STORAGE_KEY);
      return cached ? { ...DEFAULT_THEME, ...JSON.parse(cached) } : DEFAULT_THEME;
    } catch { return DEFAULT_THEME; }
  });
  const [customThemes, setCustomThemes] = useState<CustomTheme[]>(() => {
    try {
      const cached = localStorage.getItem(CUSTOM_STORAGE_KEY);
      return cached ? JSON.parse(cached) : [];
    } catch { return []; }
  });
  const [pageOverrides, setPageOverrides] = useState<PageThemeOverride[]>(() => {
    try {
      const cached = localStorage.getItem(PAGE_OVERRIDE_STORAGE_KEY);
      return cached ? JSON.parse(cached) : [];
    } catch { return []; }
  });
  const [activePath, setActivePath] = useState<string>(typeof window !== "undefined" ? window.location.pathname : "/");
  const [isLoading, setIsLoading] = useState(false);

  // Merge the global theme with whichever page override (if any) matches the
  // current route — page-specific fields win, everything else falls back to
  // global. This is what actually gets painted to the DOM.
  const effectiveTheme = useMemo<UiTheme>(() => {
    const key = findBestPageMatch(pageOverrides.map(o => o.pageKey), activePath);
    const override = key ? pageOverrides.find(o => o.pageKey === key) : undefined;
    if (!override) return theme;
    const { dbId, pageKey, updatedAt, ...fields } = override;
    const patch = Object.fromEntries(Object.entries(fields).filter(([, v]) => v != null));
    return { ...theme, ...patch };
  }, [theme, pageOverrides, activePath]);

  // Apply immediately (including the cached/default theme) so there's no flash,
  // then again whenever the effective theme or custom-theme list changes.
  useEffect(() => { applyThemeToDom(effectiveTheme, customThemes); }, [effectiveTheme, customThemes]);

  const refreshCustomThemes = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetch(`${BASE}/api/ui-theme/custom-themes`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) {
        const data: CustomTheme[] = await r.json();
        setCustomThemes(data);
        try { localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(data)); } catch { }
      }
    } catch { }
  }, [token]);

  useEffect(() => {
    if (!token) return;
    setIsLoading(true);
    Promise.all([
      fetch(`${BASE}/api/ui-theme`, { headers: { Authorization: `Bearer ${token}` } }).then(r => (r.ok ? r.json() : null)),
      fetch(`${BASE}/api/ui-theme/custom-themes`, { headers: { Authorization: `Bearer ${token}` } }).then(r => (r.ok ? r.json() : null)),
      fetch(`${BASE}/api/ui-theme/page-overrides`, { headers: { Authorization: `Bearer ${token}` } }).then(r => (r.ok ? r.json() : null)),
    ])
      .then(([themeData, customData, pageData]: [UiTheme | null, CustomTheme[] | null, PageThemeOverride[] | null]) => {
        if (themeData) {
          setTheme({ ...DEFAULT_THEME, ...themeData });
          try { localStorage.setItem(STORAGE_KEY, JSON.stringify(themeData)); } catch { }
        }
        if (customData) {
          setCustomThemes(customData);
          try { localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(customData)); } catch { }
        }
        if (pageData) {
          setPageOverrides(pageData);
          try { localStorage.setItem(PAGE_OVERRIDE_STORAGE_KEY, JSON.stringify(pageData)); } catch { }
        }
      })
      .catch(() => { })
      .finally(() => setIsLoading(false));
  }, [token]);

  const update = useCallback(async (patch: Partial<UiTheme>) => {
    if (!token) return;
    const optimistic = { ...theme, ...patch };
    setTheme(optimistic);
    const r = await fetch(`${BASE}/api/admin/ui-theme`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(patch),
    });
    if (r.ok) {
      const updated = await r.json();
      setTheme({ ...DEFAULT_THEME, ...updated });
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(updated)); } catch { }
    }
  }, [token, theme]);

  const uploadCustomTheme = useCallback(async (payload: { name: string; description?: string; isLight?: boolean; swatch?: [string, string, string]; vars: PaletteVars }) => {
    if (!token) return null;
    const r = await fetch(`${BASE}/api/admin/ui-theme/custom-themes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: "Upload failed" }));
      throw new Error(err.error || "Upload failed");
    }
    const created: CustomTheme = await r.json();
    setCustomThemes(prev => {
      const next = [created, ...prev];
      try { localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(next)); } catch { }
      return next;
    });
    return created;
  }, [token]);

  const deleteCustomTheme = useCallback(async (id: string) => {
    if (!token) return;
    const dbId = id.startsWith("custom:") ? id.split(":")[1] : id;
    const r = await fetch(`${BASE}/api/admin/ui-theme/custom-themes/${dbId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.ok) {
      setCustomThemes(prev => {
        const next = prev.filter(c => c.id !== id);
        try { localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(next)); } catch { }
        return next;
      });
      // If it was active, the server already reset paletteId server-side — resync.
      if (theme.paletteId === id) setTheme(t => ({ ...t, paletteId: "ash" }));
    }
  }, [token, theme.paletteId]);

  const getOverrideForPage = useCallback((pageKey: string) => {
    return pageOverrides.find(o => o.pageKey === pageKey);
  }, [pageOverrides]);

  const savePageOverride = useCallback(async (pageKey: string, patch: ThemeOverridableFields) => {
    if (!token) return;
    const r = await fetch(`${BASE}/api/admin/ui-theme/page-overrides`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ pageKey, ...patch }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: "Save failed" }));
      throw new Error(err.error || "Save failed");
    }
    const saved: PageThemeOverride = await r.json();
    setPageOverrides(prev => {
      const next = [...prev.filter(o => o.pageKey !== pageKey), saved];
      try { localStorage.setItem(PAGE_OVERRIDE_STORAGE_KEY, JSON.stringify(next)); } catch { }
      return next;
    });
  }, [token]);

  const deletePageOverride = useCallback(async (pageKey: string) => {
    if (!token) return;
    const existing = pageOverrides.find(o => o.pageKey === pageKey);
    if (!existing) return;
    const r = await fetch(`${BASE}/api/admin/ui-theme/page-overrides/${existing.dbId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.ok) {
      setPageOverrides(prev => {
        const next = prev.filter(o => o.pageKey !== pageKey);
        try { localStorage.setItem(PAGE_OVERRIDE_STORAGE_KEY, JSON.stringify(next)); } catch { }
        return next;
      });
    }
  }, [token, pageOverrides]);

  return (
    <UiThemeContext.Provider value={{
      theme, customThemes, isLoading, update, uploadCustomTheme, deleteCustomTheme, refreshCustomThemes,
      pageOverrides, activePath, setActivePath, effectiveTheme,
      getOverrideForPage, savePageOverride, deletePageOverride,
    }}>
      {children}
    </UiThemeContext.Provider>
  );
}

export function useUiTheme() {
  const ctx = useContext(UiThemeContext);
  if (!ctx) throw new Error("useUiTheme must be used within UiThemeProvider");
  return ctx;
}

/** Mount once inside the wouter <Router> (below UiThemeProvider) — keeps
 *  activePath in sync with real navigation so per-page overrides apply
 *  instantly on route change, with no extra plumbing anywhere else. */
export function ThemeRouteSync() {
  const [location] = useLocation();
  const { setActivePath } = useUiTheme();
  useEffect(() => { setActivePath(location); }, [location, setActivePath]);
  return null;
}
