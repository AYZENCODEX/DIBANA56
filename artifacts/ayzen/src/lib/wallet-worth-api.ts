/**
 * lib/wallet-worth-api.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Live multi-chain wallet worth refresh for a Vault entity — thin wrapper
 * around POST /vault/:id/refresh-wallet-worth (routes/vault.ts), following
 * the same hand-written customFetch pattern as vault-ban-api.ts for
 * endpoints not yet in the generated OpenAPI client.
 */
import { customFetch } from "@workspace/api-client-react";

export interface WalletWorthBreakdownRow {
  address: string;
  chain: string;
  balance: number;
  balanceUsd: number;
  error?: string;
}

export interface WalletWorthRefreshResult {
  walletWorthUsd: number;
  walletWorthSyncedAt: string | null;
  breakdown: WalletWorthBreakdownRow[];
}

/** Pulls live balances (ETH/BASE/MATIC/BSC/ARB/OP) for every address on this
 *  entity via read-only RPC, sums the USD worth, and persists it. */
export function refreshWalletWorth(vaultEntryId: number): Promise<WalletWorthRefreshResult> {
  return customFetch(`/api/vault/${vaultEntryId}/refresh-wallet-worth`, { method: "POST" }) as Promise<WalletWorthRefreshResult>;
}
