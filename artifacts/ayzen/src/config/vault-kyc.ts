import type { ElementType } from "react";
import { ShieldCheck, Building2, Wallet, Tag } from "lucide-react";

// KYC entity category config — the "box picker" shown as step 1 of the
// KYC create dialog (components/kyc-entries.tsx), same shape/role as
// LOCAL_ACCOUNT_DEFAULT_CATEGORIES in vault-local.ts.
//
// Fixed list per product spec (not user-manageable like local account
// categories) — add a platform here to add it to the box picker.

export interface KycCategory {
  id: string;
  name: string;
  color: string; // hex, used inline for the box icon/border
}

export const KYC_CATEGORIES: KycCategory[] = [
  { id: "bitget",   name: "Bitget",   color: "#00F0FF" },
  { id: "binance",  name: "Binance",  color: "#F0B90B" },
  { id: "kucoin",   name: "KuCoin",   color: "#24AE8F" },
  { id: "gateio",   name: "Gate.io",  color: "#17E6A1" },
  { id: "redotpay", name: "RedotPay", color: "#FF3B30" },
  { id: "fasset",   name: "Fasset",   color: "#6E56CF" },
  { id: "mepass",   name: "MePass",   color: "#22C55E" },
  { id: "bybit",    name: "Bybit",    color: "#F7A600" },
  { id: "avalanche",name: "Avalanche",color: "#E84142" },
  { id: "other",    name: "Other",    color: "#8b5cf6" },
];

export function getKycCategoryMeta(name: string): KycCategory {
  return KYC_CATEGORIES.find(c => c.name === name)
    ?? { id: "other", name, color: "#8b5cf6" };
}

// Icon used in the box picker / list badges — single icon for all
// categories today (platform-specific icons can be added per-id later
// the same way LOCAL_ACCOUNT_PLATFORM_META does it, if needed).
export const KYC_CATEGORY_ICON: ElementType = Building2;
export { ShieldCheck as KycIcon, Wallet as KycWalletIcon, Tag as KycTagIcon };
