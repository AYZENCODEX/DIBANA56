import type { ElementType } from "react";
import { Gamepad2 } from "lucide-react";

// Game entity category config — the "box picker" shown as step 1 of the
// Game create dialog (components/game-entries.tsx), same shape/role as
// KYC_CATEGORIES in vault-kyc.ts / LOCAL_ACCOUNT_DEFAULT_CATEGORIES in
// vault-local.ts.
//
// Fixed list per product spec (not user-manageable) — add a platform here
// to add it to the box picker.

export interface GameCategory {
  id: string;
  name: string;
  color: string; // hex, used inline for the box icon/border
}

export const GAME_CATEGORIES: GameCategory[] = [
  { id: "steam",       name: "Steam",         color: "#1B2838" },
  { id: "epicgames",   name: "Epic Games",    color: "#313131" },
  { id: "playstation", name: "PlayStation",   color: "#0070D1" },
  { id: "xbox",        name: "Xbox",          color: "#107C10" },
  { id: "riotgames",   name: "Riot Games",    color: "#D32936" },
  { id: "mlbb",        name: "Mobile Legends",color: "#F5A623" },
  { id: "freefire",    name: "Free Fire",     color: "#FF6600" },
  { id: "pubgm",       name: "PUBG Mobile",   color: "#F2A900" },
  { id: "roblox",      name: "Roblox",        color: "#00A2FF" },
  { id: "other",       name: "Other",         color: "#8b5cf6" },
];

export function getGameCategoryMeta(name: string): GameCategory {
  return GAME_CATEGORIES.find(c => c.name === name)
    ?? { id: "other", name, color: "#8b5cf6" };
}

// Icon used in the box picker / list badges — single icon for all
// categories today (platform-specific icons can be added per-id later the
// same way LOCAL_ACCOUNT_PLATFORM_META does it, if needed).
export const GAME_CATEGORY_ICON: ElementType = Gamepad2;
export { Gamepad2 as GameIcon };
