// HSL triplets ("H S% L%", no hsl() wrapper) — matches the convention already
// used in index.css so these can be applied as runtime overrides of the same
// custom properties (--background, --primary, --sidebar-*, etc).

export interface PaletteVars {
  background: string; foreground: string;
  card: string; cardForeground: string; cardBorder: string;
  popover: string; popoverForeground: string; popoverBorder: string;
  primary: string; primaryForeground: string;
  secondary: string; secondaryForeground: string;
  muted: string; mutedForeground: string;
  accent: string; accentForeground: string;
  border: string; input: string; ring: string;
  sidebarBackground: string; sidebarForeground: string;
  sidebarPrimary: string; sidebarPrimaryForeground: string;
  sidebarAccent: string; sidebarAccentForeground: string;
  sidebarBorder: string; sidebarRing: string;
}

export interface Palette {
  id: string;
  name: string;
  description: string;
  swatch: [string, string, string]; // 3 representative hex-ish CSS colors for the picker UI
  isLight?: boolean;
  vars: PaletteVars;
}

export const PALETTES: Palette[] = [
  {
    id: "ash",
    name: "Ash",
    description: "Neutral cool gray — quiet, high-legibility default",
    swatch: ["hsl(220 10% 9%)", "hsl(210 12% 62%)", "hsl(220 10% 16%)"],
    vars: {
      background: "220 10% 7%", foreground: "210 15% 92%",
      card: "220 10% 9%", cardForeground: "210 15% 92%", cardBorder: "220 10% 18%",
      popover: "220 10% 9%", popoverForeground: "210 15% 92%", popoverBorder: "220 10% 18%",
      primary: "210 12% 62%", primaryForeground: "220 15% 8%",
      secondary: "220 8% 40%", secondaryForeground: "0 0% 100%",
      muted: "220 10% 14%", mutedForeground: "210 10% 58%",
      accent: "220 10% 16%", accentForeground: "210 20% 90%",
      border: "220 10% 18%", input: "220 10% 11%", ring: "210 12% 62%",
      sidebarBackground: "220 12% 6%", sidebarForeground: "210 12% 75%",
      sidebarPrimary: "210 12% 62%", sidebarPrimaryForeground: "220 15% 8%",
      sidebarAccent: "220 10% 14%", sidebarAccentForeground: "210 20% 92%",
      sidebarBorder: "220 10% 16%", sidebarRing: "210 12% 62%",
    },
  },
  {
    id: "soft-olive",
    name: "Soft Olive",
    description: "Muted olive green — calm, earthy accent",
    swatch: ["hsl(80 8% 10%)", "hsl(78 30% 52%)", "hsl(78 22% 14%)"],
    vars: {
      background: "80 8% 8%", foreground: "70 20% 90%",
      card: "80 8% 10%", cardForeground: "70 20% 90%", cardBorder: "80 12% 19%",
      popover: "80 8% 10%", popoverForeground: "70 20% 90%", popoverBorder: "80 12% 19%",
      primary: "78 30% 52%", primaryForeground: "80 15% 8%",
      secondary: "40 25% 45%", secondaryForeground: "0 0% 100%",
      muted: "80 8% 15%", mutedForeground: "75 12% 58%",
      accent: "78 25% 16%", accentForeground: "78 35% 85%",
      border: "80 10% 19%", input: "80 8% 12%", ring: "78 30% 52%",
      sidebarBackground: "80 10% 6%", sidebarForeground: "75 14% 76%",
      sidebarPrimary: "78 30% 52%", sidebarPrimaryForeground: "80 15% 8%",
      sidebarAccent: "78 22% 14%", sidebarAccentForeground: "78 35% 90%",
      sidebarBorder: "80 10% 16%", sidebarRing: "78 30% 52%",
    },
  },
  {
    id: "soft-brown",
    name: "Soft Brown",
    description: "Warm muted terracotta — approachable, grounded",
    swatch: ["hsl(25 12% 10%)", "hsl(28 35% 55%)", "hsl(28 22% 14%)"],
    vars: {
      background: "25 12% 8%", foreground: "30 25% 92%",
      card: "25 12% 10%", cardForeground: "30 25% 92%", cardBorder: "25 15% 19%",
      popover: "25 12% 10%", popoverForeground: "30 25% 92%", popoverBorder: "25 15% 19%",
      primary: "28 35% 55%", primaryForeground: "25 15% 8%",
      secondary: "15 25% 42%", secondaryForeground: "0 0% 100%",
      muted: "25 12% 15%", mutedForeground: "28 14% 58%",
      accent: "28 25% 17%", accentForeground: "30 35% 86%",
      border: "25 12% 19%", input: "25 12% 12%", ring: "28 35% 55%",
      sidebarBackground: "25 14% 6%", sidebarForeground: "28 16% 76%",
      sidebarPrimary: "28 35% 55%", sidebarPrimaryForeground: "25 15% 8%",
      sidebarAccent: "28 22% 14%", sidebarAccentForeground: "30 35% 90%",
      sidebarBorder: "25 12% 16%", sidebarRing: "28 35% 55%",
    },
  },
  {
    id: "light-navy",
    name: "Light Navy Blue",
    description: "Bright enterprise light mode with navy accents",
    swatch: ["hsl(210 30% 97%)", "hsl(215 60% 40%)", "hsl(213 45% 92%)"],
    isLight: true,
    vars: {
      background: "210 30% 97%", foreground: "220 40% 14%",
      card: "0 0% 100%", cardForeground: "220 40% 14%", cardBorder: "210 25% 88%",
      popover: "0 0% 100%", popoverForeground: "220 40% 14%", popoverBorder: "210 25% 88%",
      primary: "215 60% 40%", primaryForeground: "0 0% 100%",
      secondary: "215 30% 55%", secondaryForeground: "0 0% 100%",
      muted: "210 25% 93%", mutedForeground: "215 15% 40%",
      accent: "213 45% 92%", accentForeground: "215 60% 30%",
      border: "210 25% 87%", input: "210 25% 91%", ring: "215 60% 40%",
      sidebarBackground: "210 30% 96%", sidebarForeground: "220 30% 25%",
      sidebarPrimary: "215 60% 40%", sidebarPrimaryForeground: "0 0% 100%",
      sidebarAccent: "213 45% 90%", sidebarAccentForeground: "215 60% 30%",
      sidebarBorder: "210 25% 86%", sidebarRing: "215 60% 40%",
    },
  },
  {
    id: "deep-ocean",
    name: "Deep Ocean",
    description: "Cool teal-blue — crisp, focused, technical",
    swatch: ["hsl(195 12% 7%)", "hsl(195 65% 55%)", "hsl(195 28% 17%)"],
    vars: {
      background: "195 12% 7%",
      foreground: "205 20% 92%",
      card: "195 12% 9%",
      cardForeground: "205 20% 92%",
      cardBorder: "195 14% 18%",
      popover: "195 12% 9%",
      popoverForeground: "205 20% 92%",
      popoverBorder: "195 14% 18%",
      primary: "195 65% 55%",
      primaryForeground: "195 15% 8%",
      secondary: "225 25% 42%",
      secondaryForeground: "0 0% 100%",
      muted: "195 12% 14%",
      mutedForeground: "195 12% 58%",
      accent: "195 28% 17%",
      accentForeground: "195 40% 87%",
      border: "195 14% 18%",
      input: "195 12% 11%",
      ring: "195 65% 55%",
      sidebarBackground: "195 14% 6%",
      sidebarForeground: "195 14% 76%",
      sidebarPrimary: "195 65% 55%",
      sidebarPrimaryForeground: "195 15% 8%",
      sidebarAccent: "195 25% 15%",
      sidebarAccentForeground: "195 35% 90%",
      sidebarBorder: "195 14% 16%",
      sidebarRing: "195 65% 55%",
    },
  },
  {
    id: "crimson-ember",
    name: "Crimson Ember",
    description: "Deep red accent — bold, high-energy",
    swatch: ["hsl(350 12% 7%)", "hsl(350 62% 55%)", "hsl(350 28% 17%)"],
    vars: {
      background: "350 12% 7%",
      foreground: "0 20% 92%",
      card: "350 12% 9%",
      cardForeground: "0 20% 92%",
      cardBorder: "350 14% 18%",
      popover: "350 12% 9%",
      popoverForeground: "0 20% 92%",
      popoverBorder: "350 14% 18%",
      primary: "350 62% 55%",
      primaryForeground: "350 15% 8%",
      secondary: "20 25% 42%",
      secondaryForeground: "0 0% 100%",
      muted: "350 12% 14%",
      mutedForeground: "350 12% 58%",
      accent: "350 28% 17%",
      accentForeground: "350 40% 87%",
      border: "350 14% 18%",
      input: "350 12% 11%",
      ring: "350 62% 55%",
      sidebarBackground: "350 14% 6%",
      sidebarForeground: "350 14% 76%",
      sidebarPrimary: "350 62% 55%",
      sidebarPrimaryForeground: "350 15% 8%",
      sidebarAccent: "350 25% 15%",
      sidebarAccentForeground: "350 35% 90%",
      sidebarBorder: "350 14% 16%",
      sidebarRing: "350 62% 55%",
    },
  },
  {
    id: "royal-violet",
    name: "Royal Violet",
    description: "Rich violet — premium, confident",
    swatch: ["hsl(265 12% 7%)", "hsl(265 58% 55%)", "hsl(265 28% 17%)"],
    vars: {
      background: "265 12% 7%",
      foreground: "275 20% 92%",
      card: "265 12% 9%",
      cardForeground: "275 20% 92%",
      cardBorder: "265 14% 18%",
      popover: "265 12% 9%",
      popoverForeground: "275 20% 92%",
      popoverBorder: "265 14% 18%",
      primary: "265 58% 55%",
      primaryForeground: "265 15% 8%",
      secondary: "295 25% 42%",
      secondaryForeground: "0 0% 100%",
      muted: "265 12% 14%",
      mutedForeground: "265 12% 58%",
      accent: "265 28% 17%",
      accentForeground: "265 40% 87%",
      border: "265 14% 18%",
      input: "265 12% 11%",
      ring: "265 58% 55%",
      sidebarBackground: "265 14% 6%",
      sidebarForeground: "265 14% 76%",
      sidebarPrimary: "265 58% 55%",
      sidebarPrimaryForeground: "265 15% 8%",
      sidebarAccent: "265 25% 15%",
      sidebarAccentForeground: "265 35% 90%",
      sidebarBorder: "265 14% 16%",
      sidebarRing: "265 58% 55%",
    },
  },
  {
    id: "cyber-pink",
    name: "Cyber Pink",
    description: "Neon magenta — high-contrast, playful",
    swatch: ["hsl(320 12% 7%)", "hsl(320 68% 55%)", "hsl(320 28% 17%)"],
    vars: {
      background: "320 12% 7%",
      foreground: "330 20% 92%",
      card: "320 12% 9%",
      cardForeground: "330 20% 92%",
      cardBorder: "320 14% 18%",
      popover: "320 12% 9%",
      popoverForeground: "330 20% 92%",
      popoverBorder: "320 14% 18%",
      primary: "320 68% 55%",
      primaryForeground: "320 15% 8%",
      secondary: "350 25% 42%",
      secondaryForeground: "0 0% 100%",
      muted: "320 12% 14%",
      mutedForeground: "320 12% 58%",
      accent: "320 28% 17%",
      accentForeground: "320 40% 87%",
      border: "320 14% 18%",
      input: "320 12% 11%",
      ring: "320 68% 55%",
      sidebarBackground: "320 14% 6%",
      sidebarForeground: "320 14% 76%",
      sidebarPrimary: "320 68% 55%",
      sidebarPrimaryForeground: "320 15% 8%",
      sidebarAccent: "320 25% 15%",
      sidebarAccentForeground: "320 35% 90%",
      sidebarBorder: "320 14% 16%",
      sidebarRing: "320 68% 55%",
    },
  },
  {
    id: "forest",
    name: "Forest",
    description: "Deep green accent — grounded, natural",
    swatch: ["hsl(140 12% 7%)", "hsl(140 45% 55%)", "hsl(140 28% 17%)"],
    vars: {
      background: "140 12% 7%",
      foreground: "150 20% 92%",
      card: "140 12% 9%",
      cardForeground: "150 20% 92%",
      cardBorder: "140 14% 18%",
      popover: "140 12% 9%",
      popoverForeground: "150 20% 92%",
      popoverBorder: "140 14% 18%",
      primary: "140 45% 55%",
      primaryForeground: "140 15% 8%",
      secondary: "170 25% 42%",
      secondaryForeground: "0 0% 100%",
      muted: "140 12% 14%",
      mutedForeground: "140 12% 58%",
      accent: "140 28% 17%",
      accentForeground: "140 40% 87%",
      border: "140 14% 18%",
      input: "140 12% 11%",
      ring: "140 45% 55%",
      sidebarBackground: "140 14% 6%",
      sidebarForeground: "140 14% 76%",
      sidebarPrimary: "140 45% 55%",
      sidebarPrimaryForeground: "140 15% 8%",
      sidebarAccent: "140 25% 15%",
      sidebarAccentForeground: "140 35% 90%",
      sidebarBorder: "140 14% 16%",
      sidebarRing: "140 45% 55%",
    },
  },
  {
    id: "amber-gold",
    name: "Amber Gold",
    description: "Warm amber accent — energetic, rewarding",
    swatch: ["hsl(38 12% 7%)", "hsl(38 70% 55%)", "hsl(38 28% 17%)"],
    vars: {
      background: "38 12% 7%",
      foreground: "48 20% 92%",
      card: "38 12% 9%",
      cardForeground: "48 20% 92%",
      cardBorder: "38 14% 18%",
      popover: "38 12% 9%",
      popoverForeground: "48 20% 92%",
      popoverBorder: "38 14% 18%",
      primary: "38 70% 55%",
      primaryForeground: "38 15% 8%",
      secondary: "68 25% 42%",
      secondaryForeground: "0 0% 100%",
      muted: "38 12% 14%",
      mutedForeground: "38 12% 58%",
      accent: "38 28% 17%",
      accentForeground: "38 40% 87%",
      border: "38 14% 18%",
      input: "38 12% 11%",
      ring: "38 70% 55%",
      sidebarBackground: "38 14% 6%",
      sidebarForeground: "38 14% 76%",
      sidebarPrimary: "38 70% 55%",
      sidebarPrimaryForeground: "38 15% 8%",
      sidebarAccent: "38 25% 15%",
      sidebarAccentForeground: "38 35% 90%",
      sidebarBorder: "38 14% 16%",
      sidebarRing: "38 70% 55%",
    },
  },
  {
    id: "indigo-night",
    name: "Indigo Night",
    description: "Deep indigo-blue — calm, professional",
    swatch: ["hsl(235 12% 7%)", "hsl(235 55% 55%)", "hsl(235 28% 17%)"],
    vars: {
      background: "235 12% 7%",
      foreground: "245 20% 92%",
      card: "235 12% 9%",
      cardForeground: "245 20% 92%",
      cardBorder: "235 14% 18%",
      popover: "235 12% 9%",
      popoverForeground: "245 20% 92%",
      popoverBorder: "235 14% 18%",
      primary: "235 55% 55%",
      primaryForeground: "235 15% 8%",
      secondary: "265 25% 42%",
      secondaryForeground: "0 0% 100%",
      muted: "235 12% 14%",
      mutedForeground: "235 12% 58%",
      accent: "235 28% 17%",
      accentForeground: "235 40% 87%",
      border: "235 14% 18%",
      input: "235 12% 11%",
      ring: "235 55% 55%",
      sidebarBackground: "235 14% 6%",
      sidebarForeground: "235 14% 76%",
      sidebarPrimary: "235 55% 55%",
      sidebarPrimaryForeground: "235 15% 8%",
      sidebarAccent: "235 25% 15%",
      sidebarAccentForeground: "235 35% 90%",
      sidebarBorder: "235 14% 16%",
      sidebarRing: "235 55% 55%",
    },
  },
  {
    id: "light-sand",
    name: "Light Sand",
    description: "Warm neutral light mode — approachable, soft",
    swatch: ["hsl(35 30% 97%)", "hsl(35 45% 42%)", "hsl(35 45% 92%)"],
    isLight: true,
    vars: {
      background: "35 30% 97%",
      foreground: "45 40% 14%",
      card: "0 0% 100%",
      cardForeground: "45 40% 14%",
      cardBorder: "35 25% 88%",
      popover: "0 0% 100%",
      popoverForeground: "45 40% 14%",
      popoverBorder: "35 25% 88%",
      primary: "35 45% 42%",
      primaryForeground: "0 0% 100%",
      secondary: "65 30% 55%",
      secondaryForeground: "0 0% 100%",
      muted: "35 25% 93%",
      mutedForeground: "35 15% 40%",
      accent: "35 45% 92%",
      accentForeground: "35 45% 32%",
      border: "35 25% 87%",
      input: "35 25% 91%",
      ring: "35 45% 42%",
      sidebarBackground: "35 30% 96%",
      sidebarForeground: "35 30% 25%",
      sidebarPrimary: "35 45% 42%",
      sidebarPrimaryForeground: "0 0% 100%",
      sidebarAccent: "35 45% 90%",
      sidebarAccentForeground: "35 45% 32%",
      sidebarBorder: "35 25% 86%",
      sidebarRing: "35 45% 42%",
    },
  },
  {
    id: "light-mint",
    name: "Light Mint",
    description: "Fresh green-teal light mode — clean, airy",
    swatch: ["hsl(160 30% 97%)", "hsl(160 40% 42%)", "hsl(160 45% 92%)"],
    isLight: true,
    vars: {
      background: "160 30% 97%",
      foreground: "170 40% 14%",
      card: "0 0% 100%",
      cardForeground: "170 40% 14%",
      cardBorder: "160 25% 88%",
      popover: "0 0% 100%",
      popoverForeground: "170 40% 14%",
      popoverBorder: "160 25% 88%",
      primary: "160 40% 42%",
      primaryForeground: "0 0% 100%",
      secondary: "190 30% 55%",
      secondaryForeground: "0 0% 100%",
      muted: "160 25% 93%",
      mutedForeground: "160 15% 40%",
      accent: "160 45% 92%",
      accentForeground: "160 40% 32%",
      border: "160 25% 87%",
      input: "160 25% 91%",
      ring: "160 40% 42%",
      sidebarBackground: "160 30% 96%",
      sidebarForeground: "160 30% 25%",
      sidebarPrimary: "160 40% 42%",
      sidebarPrimaryForeground: "0 0% 100%",
      sidebarAccent: "160 45% 90%",
      sidebarAccentForeground: "160 40% 32%",
      sidebarBorder: "160 25% 86%",
      sidebarRing: "160 40% 42%",
    },
  },
  {
    id: "light-rose",
    name: "Light Rose",
    description: "Soft pink light mode — friendly, warm",
    swatch: ["hsl(340 30% 97%)", "hsl(340 45% 42%)", "hsl(340 45% 92%)"],
    isLight: true,
    vars: {
      background: "340 30% 97%",
      foreground: "350 40% 14%",
      card: "0 0% 100%",
      cardForeground: "350 40% 14%",
      cardBorder: "340 25% 88%",
      popover: "0 0% 100%",
      popoverForeground: "350 40% 14%",
      popoverBorder: "340 25% 88%",
      primary: "340 45% 42%",
      primaryForeground: "0 0% 100%",
      secondary: "10 30% 55%",
      secondaryForeground: "0 0% 100%",
      muted: "340 25% 93%",
      mutedForeground: "340 15% 40%",
      accent: "340 45% 92%",
      accentForeground: "340 45% 32%",
      border: "340 25% 87%",
      input: "340 25% 91%",
      ring: "340 45% 42%",
      sidebarBackground: "340 30% 96%",
      sidebarForeground: "340 30% 25%",
      sidebarPrimary: "340 45% 42%",
      sidebarPrimaryForeground: "0 0% 100%",
      sidebarAccent: "340 45% 90%",
      sidebarAccentForeground: "340 45% 32%",
      sidebarBorder: "340 25% 86%",
      sidebarRing: "340 45% 42%",
    },
  },
  {
    id: "light-slate",
    name: "Light Slate",
    description: "Cool neutral light mode — minimal, enterprise",
    swatch: ["hsl(220 30% 97%)", "hsl(220 35% 42%)", "hsl(220 45% 92%)"],
    isLight: true,
    vars: {
      background: "220 30% 97%",
      foreground: "230 40% 14%",
      card: "0 0% 100%",
      cardForeground: "230 40% 14%",
      cardBorder: "220 25% 88%",
      popover: "0 0% 100%",
      popoverForeground: "230 40% 14%",
      popoverBorder: "220 25% 88%",
      primary: "220 35% 42%",
      primaryForeground: "0 0% 100%",
      secondary: "250 30% 55%",
      secondaryForeground: "0 0% 100%",
      muted: "220 25% 93%",
      mutedForeground: "220 15% 40%",
      accent: "220 45% 92%",
      accentForeground: "220 35% 32%",
      border: "220 25% 87%",
      input: "220 25% 91%",
      ring: "220 35% 42%",
      sidebarBackground: "220 30% 96%",
      sidebarForeground: "220 30% 25%",
      sidebarPrimary: "220 35% 42%",
      sidebarPrimaryForeground: "0 0% 100%",
      sidebarAccent: "220 45% 90%",
      sidebarAccentForeground: "220 35% 32%",
      sidebarBorder: "220 25% 86%",
      sidebarRing: "220 35% 42%",
    },
  },
  {
    id: "light-violet",
    name: "Light Violet",
    description: "Bright violet accent on white — creative, modern",
    swatch: ["hsl(265 30% 97%)", "hsl(265 50% 42%)", "hsl(265 45% 92%)"],
    isLight: true,
    vars: {
      background: "265 30% 97%",
      foreground: "275 40% 14%",
      card: "0 0% 100%",
      cardForeground: "275 40% 14%",
      cardBorder: "265 25% 88%",
      popover: "0 0% 100%",
      popoverForeground: "275 40% 14%",
      popoverBorder: "265 25% 88%",
      primary: "265 50% 42%",
      primaryForeground: "0 0% 100%",
      secondary: "295 30% 55%",
      secondaryForeground: "0 0% 100%",
      muted: "265 25% 93%",
      mutedForeground: "265 15% 40%",
      accent: "265 45% 92%",
      accentForeground: "265 50% 32%",
      border: "265 25% 87%",
      input: "265 25% 91%",
      ring: "265 50% 42%",
      sidebarBackground: "265 30% 96%",
      sidebarForeground: "265 30% 25%",
      sidebarPrimary: "265 50% 42%",
      sidebarPrimaryForeground: "0 0% 100%",
      sidebarAccent: "265 45% 90%",
      sidebarAccentForeground: "265 50% 32%",
      sidebarBorder: "265 25% 86%",
      sidebarRing: "265 50% 42%",
    },
  },
];

export function getPalette(id: string): Palette {
  return PALETTES.find(p => p.id === id) ?? PALETTES[0];
}

// ── Hex <-> "H S% L%" conversion — powers the palette builder's color pickers,
// which speak hex (native <input type="color">) while the rest of the app
// speaks HSL triplets. ──────────────────────────────────────────────────────
export function hexToHslTriplet(hex: string): string {
  const clean = hex.replace("#", "");
  const bigint = parseInt(clean.length === 3
    ? clean.split("").map(c => c + c).join("")
    : clean, 16);
  const r = ((bigint >> 16) & 255) / 255;
  const g = ((bigint >> 8) & 255) / 255;
  const b = (bigint & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return `${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

export function hslTripletToHex(hsl: string): string {
  const m = hsl.match(/^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/);
  if (!m) return "#000000";
  const h = parseFloat(m[1]) / 360, s = parseFloat(m[2]) / 100, l = parseFloat(m[3]) / 100;
  let r: number, g: number, b: number;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  const toHex = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// Field groups for the palette builder UI — grouped so the color-picker grid
// reads as "background family / card / popover / primary / secondary / muted
// / accent / structural / sidebar" instead of one flat list of 27 swatches.
export const PALETTE_VAR_GROUPS: { label: string; keys: (keyof PaletteVars)[] }[] = [
  { label: "Base", keys: ["background", "foreground"] },
  { label: "Card", keys: ["card", "cardForeground", "cardBorder"] },
  { label: "Popover", keys: ["popover", "popoverForeground", "popoverBorder"] },
  { label: "Primary", keys: ["primary", "primaryForeground"] },
  { label: "Secondary", keys: ["secondary", "secondaryForeground"] },
  { label: "Muted", keys: ["muted", "mutedForeground"] },
  { label: "Accent", keys: ["accent", "accentForeground"] },
  { label: "Structure", keys: ["border", "input", "ring"] },
  {
    label: "Sidebar", keys: [
      "sidebarBackground", "sidebarForeground", "sidebarPrimary", "sidebarPrimaryForeground",
      "sidebarAccent", "sidebarAccentForeground", "sidebarBorder", "sidebarRing",
    ],
  },
];

// Human labels for the above keys, used as <label> text in the builder.
export const PALETTE_VAR_LABELS: Record<keyof PaletteVars, string> = {
  background: "Background", foreground: "Foreground",
  card: "Card", cardForeground: "Card text", cardBorder: "Card border",
  popover: "Popover", popoverForeground: "Popover text", popoverBorder: "Popover border",
  primary: "Primary", primaryForeground: "Primary text",
  secondary: "Secondary", secondaryForeground: "Secondary text",
  muted: "Muted", mutedForeground: "Muted text",
  accent: "Accent", accentForeground: "Accent text",
  border: "Border", input: "Input", ring: "Focus ring",
  sidebarBackground: "Background", sidebarForeground: "Text",
  sidebarPrimary: "Primary", sidebarPrimaryForeground: "Primary text",
  sidebarAccent: "Accent", sidebarAccentForeground: "Accent text",
  sidebarBorder: "Border", sidebarRing: "Focus ring",
};

// ── Contrast adjustment ────────────────────────────────────────────────────
// Nudges an "H S% L%" triplet's lightness by `delta` (clamped 0-100).
function adjustLightness(hsl: string, delta: number): string {
  const m = hsl.match(/^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/);
  if (!m) return hsl;
  const [, h, s, l] = m;
  const newL = Math.max(0, Math.min(100, parseFloat(l) + delta));
  return `${h} ${s}% ${newL}%`;
}

export function applyContrast(vars: PaletteVars, contrast: "normal" | "high", isLight: boolean): PaletteVars {
  if (contrast === "normal") return vars;
  const fg = isLight ? -10 : 6;   // push foreground toward the extreme
  const bg = isLight ? 3 : -3;    // push background toward the extreme
  const bd = isLight ? -14 : 14;  // thicken/brighten borders for visible separation
  return {
    ...vars,
    foreground: adjustLightness(vars.foreground, fg),
    background: adjustLightness(vars.background, bg),
    border: adjustLightness(vars.border, bd),
    sidebarForeground: adjustLightness(vars.sidebarForeground, fg),
    sidebarBorder: adjustLightness(vars.sidebarBorder, bd),
    mutedForeground: adjustLightness(vars.mutedForeground, fg > 0 ? fg - 2 : fg + 2),
  };
}
