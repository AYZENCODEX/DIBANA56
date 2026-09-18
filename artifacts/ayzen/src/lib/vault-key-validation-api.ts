/**
 * lib/vault-key-validation-api.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Thin wrapper around POST /vault/validate-key (routes/vault.ts) — checks a
 * seed phrase / private key typed into the entity form BEFORE it's saved,
 * following the same hand-written customFetch pattern as wallet-worth-api.ts
 * for endpoints not yet in the generated OpenAPI client.
 */
import { customFetch } from "@workspace/api-client-react";

export type WalletKeyType = "mnemonic" | "private-key";

export interface WalletKeyValidationResult {
  valid: boolean;
  type: WalletKeyType | null;
  address?: string;
  error?: string;
}

export function validateWalletKey(value: string): Promise<WalletKeyValidationResult> {
  return customFetch("/api/vault/validate-key", {
    method: "POST",
    body: JSON.stringify({ value }),
  }) as Promise<WalletKeyValidationResult>;
}
