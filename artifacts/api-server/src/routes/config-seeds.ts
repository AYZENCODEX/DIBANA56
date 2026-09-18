/**
 * Seed data for Config Manager domains — mirrors the current values in the
 * matching artifacts/ayzen/src/config/*.ts file, so the first load per
 * domain is non-destructive (nothing changes for end users until a dev
 * actually edits an entry). Only domains a page has been wired to fetch
 * from /admin/config/:domain (instead of importing the static file) are
 * live in effect — see CONFIG_DOMAINS below for which ones that is.
 */
export interface ConfigSeedEntry {
  data: Record<string, unknown>;
}

export const CONFIG_SEEDS: Record<string, ConfigSeedEntry[]> = {
  // Wired: artifacts/ayzen/src/pages/user/marketplace-azn.tsx reads this
  // domain via useConfigDomain() with the static AZN_PAYMENT_METHODS array
  // (config/marketplace-azn.ts) kept only as the loading/empty fallback.
  "marketplace-azn-payment-methods": [
    { data: { id: "binance", label: "Binance", icon: "Building2", color: "text-amber-400", border: "border-amber-400/30", bg: "bg-amber-400/10", fee: 2, detailsLabel: "Binance UID / Pay ID", detailsPlaceholder: "e.g. 123456789" } },
    { data: { id: "bkash", label: "bKash", icon: "Banknote", color: "text-pink-400", border: "border-pink-400/30", bg: "bg-pink-400/10", fee: 2, detailsLabel: "bKash Account Number", detailsPlaceholder: "e.g. 01XXXXXXXXX" } },
    { data: { id: "nagad", label: "Nagad", icon: "CreditCard", color: "text-orange-400", border: "border-orange-400/30", bg: "bg-orange-400/10", fee: 2, detailsLabel: "Nagad Account Number", detailsPlaceholder: "e.g. 01XXXXXXXXX" } },
  ],
};

// Domains registered here appear in the Config Manager's domain list even
// before any row exists (so a dev can see + seed them from the UI).
export const CONFIG_DOMAIN_LABELS: Record<string, string> = {
  "marketplace-azn-payment-methods": "AZN Marketplace — Payment Methods",
};
