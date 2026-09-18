/**
 * vault-wallet-hub.tsx
 * ─────────────────────────────────────────────
 * Wallet Hub — the vault entity's wallet/seed feature (previously the flat
 * "Wallet" access item at /vault?tab=wallet), now its own expandable
 * sub-category in the Vault sidebar with three addressable views:
 *
 *   /vault/wallet-hub/overview  — active-wallet switcher + quick stats
 *   /vault/wallet-hub/wallet    — wallet address / seed list per entity
 *   /vault/wallet-hub/settings  — wallet-related settings
 *
 * All three views already existed as internal tabs inside
 * vault-wallet-seed.tsx (VaultWalletSeedContent) — this page just drives
 * that same component from the route param instead of local-only state, so
 * each view gets its own URL and sidebar highlight.
 */
import { useParams, useLocation } from "wouter";
import { Wallet } from "lucide-react";
import { VaultSectionPage } from "@/components/layout/vault-sidebar";
import VaultWalletSeed from "@/pages/user/vault-wallet-seed";

type SubTab = "overview" | "wallet" | "settings";
const VALID_TABS: SubTab[] = ["overview", "wallet", "settings"];

export default function VaultWalletHub() {
  const params = useParams<{ subtab?: string }>();
  const [, navigate] = useLocation();

  const subtab: SubTab = VALID_TABS.includes(params.subtab as SubTab)
    ? (params.subtab as SubTab)
    : "overview";

  return (
    <VaultSectionPage
      title="Wallet Hub"
      description="Seed phrases, wallet addresses, and on-chain balances per entity"
      icon={Wallet}
    >
      <VaultWalletSeed
        initialTab={subtab}
        onTabChange={(t) => navigate(`/vault/wallet-hub/${t}`, { replace: true })}
      />
    </VaultSectionPage>
  );
}
