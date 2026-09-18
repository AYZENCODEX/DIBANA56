import type { PaletteVars } from "./theme-palettes";

// ─── Color conversion — normalizes hex / rgb() / hsl() / oklch() down to the
// "H S% L%" triplet format this app uses everywhere ─────────────────────────

function clamp01(n: number) { return Math.min(1, Math.max(0, n)); }

function rgbToHslTriplet(r: number, g: number, b: number): string {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  const d = max - min;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r: h = ((g - b) / d) % 6; break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4; break;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  return `${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

function hexToHslTriplet(hex: string): string | null {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = h.split("").map(c => c + c).join("");
  if (h.length !== 6 && h.length !== 8) return null;
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return null;
  return rgbToHslTriplet(r, g, b);
}

function srgbGamma(x: number): number {
  x = clamp01(x);
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

// OKLCH → sRGB, per Björn Ottosson's reference formulas.
function oklchToHslTriplet(L: number, C: number, hDeg: number): string {
  const hRad = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;

  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;

  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const b2 = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;

  const R = Math.round(srgbGamma(r) * 255);
  const G = Math.round(srgbGamma(g) * 255);
  const B = Math.round(srgbGamma(b2) * 255);
  return rgbToHslTriplet(R, G, B);
}

/** Best-effort: turns almost any CSS color into our "H S% L%" triplet. */
export function parseColorToHslTriplet(raw: string): string | null {
  const v = raw.trim().replace(/^['"]|['"]$/g, "");
  if (!v) return null;

  // Already a bare "H S% L%" triplet (the classic shadcn/tailwind format).
  const bare = v.match(/^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/);
  if (bare) return `${Math.round(+bare[1])} ${Math.round(+bare[2])}% ${Math.round(+bare[3])}%`;

  if (v.startsWith("#")) return hexToHslTriplet(v);

  const nums = (s: string) => s.match(/-?\d+(?:\.\d+)?%?/g) ?? [];

  if (/^hsla?\(/i.test(v)) {
    const parts = nums(v);
    if (parts.length < 3) return null;
    const h = parseFloat(parts[0]!);
    const s = parseFloat(parts[1]!);
    const l = parseFloat(parts[2]!);
    return `${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%`;
  }

  if (/^rgba?\(/i.test(v)) {
    const parts = nums(v);
    if (parts.length < 3) return null;
    const toByte = (p: string) => (p.endsWith("%") ? Math.round((parseFloat(p) / 100) * 255) : Math.round(parseFloat(p)));
    return rgbToHslTriplet(toByte(parts[0]!), toByte(parts[1]!), toByte(parts[2]!));
  }

  if (/^oklch\(/i.test(v)) {
    const parts = nums(v);
    if (parts.length < 3) return null;
    const L = parts[0]!.endsWith("%") ? parseFloat(parts[0]!) / 100 : parseFloat(parts[0]!);
    const C = parseFloat(parts[1]!);
    const H = parseFloat(parts[2]!);
    return oklchToHslTriplet(L, C, H);
  }

  return null;
}

function lightnessOf(triplet: string): number {
  const m = triplet.match(/(\d+(?:\.\d+)?)%\s*$/);
  return m ? parseFloat(m[1]) : 50;
}

// ─── Variable-name aliasing — maps common theme-generator var names (kebab
// case, shadcn/tweakcn/ui.shadcn.com "New York" style) onto our schema ───────

const DIRECT_ALIASES: Record<string, keyof PaletteVars> = {
  background: "background", foreground: "foreground",
  card: "card", "card-foreground": "cardForeground",
  popover: "popover", "popover-foreground": "popoverForeground",
  primary: "primary", "primary-foreground": "primaryForeground",
  secondary: "secondary", "secondary-foreground": "secondaryForeground",
  muted: "muted", "muted-foreground": "mutedForeground",
  accent: "accent", "accent-foreground": "accentForeground",
  border: "border", input: "input", ring: "ring",
  sidebar: "sidebarBackground", "sidebar-background": "sidebarBackground",
  "sidebar-foreground": "sidebarForeground",
  "sidebar-primary": "sidebarPrimary", "sidebar-primary-foreground": "sidebarPrimaryForeground",
  "sidebar-accent": "sidebarAccent", "sidebar-accent-foreground": "sidebarAccentForeground",
  "sidebar-border": "sidebarBorder", "sidebar-ring": "sidebarRing",
};

/** Builds a full PaletteVars from a loose { "var-name": "raw color" } map,
 *  filling in anything the source theme didn't define with a sane fallback
 *  so incomplete imports (most of them, in practice) still work. */
export function buildPaletteVarsFromMap(raw: Record<string, string>): PaletteVars {
  const hsl: Partial<Record<keyof PaletteVars, string>> = {};
  for (const [key, value] of Object.entries(raw)) {
    const cleanKey = key.replace(/^--/, "").trim();
    const target = DIRECT_ALIASES[cleanKey];
    if (!target) continue;
    const converted = parseColorToHslTriplet(value);
    if (converted) hsl[target] = converted;
  }

  if (!hsl.background || !hsl.foreground || !hsl.primary) {
    throw new Error("Couldn't find background, foreground, and primary colors in this file.");
  }

  const get = (key: keyof PaletteVars, ...fallbacks: (keyof PaletteVars)[]): string => {
    if (hsl[key]) return hsl[key]!;
    for (const f of fallbacks) if (hsl[f]) return hsl[f]!;
    return hsl.background!;
  };

  return {
    background: hsl.background,
    foreground: hsl.foreground,
    card: get("card", "background"),
    cardForeground: get("cardForeground", "foreground"),
    cardBorder: get("border"),
    popover: get("popover", "card", "background"),
    popoverForeground: get("popoverForeground", "foreground"),
    popoverBorder: get("border"),
    primary: hsl.primary,
    primaryForeground: get("primaryForeground"),
    secondary: get("secondary", "primary"),
    secondaryForeground: get("secondaryForeground", "primaryForeground"),
    muted: get("muted", "card", "background"),
    mutedForeground: get("mutedForeground", "foreground"),
    accent: get("accent", "muted"),
    accentForeground: get("accentForeground", "foreground"),
    border: get("border"),
    input: get("input", "border"),
    ring: get("ring", "primary"),
    sidebarBackground: get("sidebarBackground", "background"),
    sidebarForeground: get("sidebarForeground", "foreground"),
    sidebarPrimary: get("sidebarPrimary", "primary"),
    sidebarPrimaryForeground: get("sidebarPrimaryForeground", "primaryForeground"),
    sidebarAccent: get("sidebarAccent", "accent"),
    sidebarAccentForeground: get("sidebarAccentForeground", "accentForeground"),
    sidebarBorder: get("sidebarBorder", "border"),
    sidebarRing: get("sidebarRing", "ring", "primary"),
  };
}

// ─── CSS text parsing ─────────────────────────────────────────────────────────

function extractCssVarBlock(css: string, selectorPattern: RegExp): Record<string, string> {
  const match = css.match(selectorPattern);
  if (!match) return {};
  const body = match[1];
  const out: Record<string, string> = {};
  const re = /--([a-zA-Z0-9-]+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out[m[1].trim()] = m[2].trim();
  return out;
}

/** Parses a raw CSS theme export (`:root { --background: ...; } .dark { ... }`). */
function parseCssTheme(css: string): { light: Record<string, string>; dark: Record<string, string> } {
  const light = extractCssVarBlock(css, /:root\s*{([^}]*)}/);
  const dark = extractCssVarBlock(css, /\.dark\s*{([^}]*)}/) ;
  return { light, dark };
}

export interface ImportedTheme {
  name: string;
  description: string;
  isLight: boolean;
  vars: PaletteVars;
  swatch: [string, string, string];
}

function toSwatch(vars: PaletteVars): [string, string, string] {
  return [`hsl(${vars.background})`, `hsl(${vars.primary})`, `hsl(${vars.accent})`];
}

/** Main entry point — accepts raw file text (.json or .css) from literally
 *  any theme export and normalizes it into our PaletteVars shape. */
export function importTheme(fileText: string, filename: string): ImportedTheme {
  const looksLikeJson = filename.toLowerCase().endsWith(".json") || fileText.trim().startsWith("{");

  if (looksLikeJson) {
    let parsed: any;
    try { parsed = JSON.parse(fileText); } catch {
      // Not actually JSON despite the extension — fall through to CSS parsing.
      return importFromCss(fileText, filename);
    }

    // Shape 1: already our own schema — vars keyed in camelCase.
    if (parsed.vars && parsed.vars.background && parsed.vars.primary) {
      const vars = parsed.vars as PaletteVars;
      // Re-run each value through the converter too, in case someone hand-
      // edited it with hex/rgb instead of an "H S% L%" triplet.
      const normalized: any = {};
      for (const [k, v] of Object.entries(vars)) normalized[k] = parseColorToHslTriplet(String(v)) ?? v;
      return {
        name: parsed.name || filename.replace(/\.(json|css)$/i, ""),
        description: parsed.description || "",
        isLight: parsed.isLight ?? lightnessOf(normalized.background) > 55,
        vars: normalized,
        swatch: Array.isArray(parsed.swatch) && parsed.swatch.length === 3 ? parsed.swatch : toSwatch(normalized),
      };
    }

    // Shape 2: shadcn registry item — { cssVars: { light: {...}, dark: {...} } }
    if (parsed.cssVars && (parsed.cssVars.dark || parsed.cssVars.light)) {
      const map = { ...(parsed.cssVars.light || {}), ...(parsed.cssVars.dark || {}) };
      const vars = buildPaletteVarsFromMap(map);
      return {
        name: parsed.name || filename.replace(/\.(json|css)$/i, ""),
        description: "Imported theme",
        isLight: !parsed.cssVars.dark && lightnessOf(vars.background) > 55,
        vars,
        swatch: toSwatch(vars),
      };
    }

    // Shape 3: a flat map of var-name → color, dumped straight to JSON.
    if (typeof parsed === "object" && parsed !== null) {
      const flat: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") flat[k] = v;
      const vars = buildPaletteVarsFromMap(flat);
      return {
        name: filename.replace(/\.(json|css)$/i, ""),
        description: "Imported theme",
        isLight: lightnessOf(vars.background) > 55,
        vars,
        swatch: toSwatch(vars),
      };
    }

    throw new Error("Unrecognized theme JSON — expected \"vars\", \"cssVars\", or a flat color map.");
  }

  return importFromCss(fileText, filename);
}

function importFromCss(css: string, filename: string): ImportedTheme {
  const { light, dark } = parseCssTheme(css);
  const merged = Object.keys(dark).length > 0 ? { ...light, ...dark } : light;
  if (Object.keys(merged).length === 0) {
    throw new Error("No :root or .dark color variables found in this file.");
  }
  const vars = buildPaletteVarsFromMap(merged);
  return {
    name: filename.replace(/\.(json|css|txt)$/i, ""),
    description: "Imported theme",
    isLight: Object.keys(dark).length === 0 && lightnessOf(vars.background) > 55,
    vars,
    swatch: toSwatch(vars),
  };
}
