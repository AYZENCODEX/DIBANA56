/**
 * lib/gas-health-api.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Live gas-health (native-coin balance + real-time tx-capacity simulation)
 * for Vault entities and the built-in AYZEN wallet — thin wrapper around
 * GET /vault/gas-overview, GET /vault/:id/gas, and GET /wallets/gas-overview
 * (routes/vault.ts, routes/wallets.ts / lib/gas-health.ts), following the
 * same hand-written customFetch pattern as wallet-worth-api.ts.
 */
import { customFetch } from "@workspace/api-client-react";

export type GasRisk = "critical" | "warning" | "healthy" | "unknown";

export interface GasChainSnapshot {
  chain: string;
  address: string;
  nativeSymbol: string;
  balance: number;
  balanceUsd: number;
  gasPriceGwei: number;
  nativeSendCapacity: number;
  erc20TransferCapacity: number;
  risk: GasRisk;
  error?: string;
}

export interface EntityGasSummary {
  id: number;
  projectName: string;
  totalUsd: number;
  risk: GasRisk;
  chains: GasChainSnapshot[];
}

export interface VaultGasOverview {
  totalUsd: number;
  entityCount: number;
  atRiskCount: number;
  atRisk: EntityGasSummary[];
  entities: EntityGasSummary[];
}

export interface EntityGasDetail {
  totalUsd: number;
  risk: GasRisk;
  chains: GasChainSnapshot[];
  message?: string;
}

export interface BuiltinWalletGasOverview {
  address: string;
  totalUsd: number;
  risk: GasRisk;
  chains: GasChainSnapshot[];
}

/** Gas health across every one of the user's vault entities — for the Gas tab on the entity list / Wallet Hub. */
export function getVaultGasOverview(): Promise<VaultGasOverview> {
  return customFetch("/api/vault/gas-overview") as Promise<VaultGasOverview>;
}

/** Gas health for one vault entity — for the Gas tab on that entity's own detail page. */
export function getEntityGas(vaultEntryId: number): Promise<EntityGasDetail> {
  return customFetch(`/api/vault/${vaultEntryId}/gas`) as Promise<EntityGasDetail>;
}

/** Gas health for the built-in AYZEN custodial wallet — for Wallet Hub → Gas. */
export function getBuiltinWalletGas(): Promise<BuiltinWalletGasOverview> {
  return customFetch("/api/wallets/gas-overview") as Promise<BuiltinWalletGasOverview>;
}
