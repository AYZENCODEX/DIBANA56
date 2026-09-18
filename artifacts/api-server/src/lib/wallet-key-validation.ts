/**
 * lib/wallet-key-validation.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Validates a wallet seed phrase (BIP-39 mnemonic) or a raw EVM private key
 * before it's accepted into the Vault entity form — used by
 * POST /vault/validate-key (routes/vault.ts) so the UI can tell the user
 * "wrong phrase" / "wrong private key" instead of silently saving garbage
 * that only fails later when something tries to derive an address from it.
 *
 * Read-only / offline: no RPC calls, no network — pure BIP-39 + secp256k1
 * checks via ethers v6 (already a project dependency, see chain-balance.ts).
 */
import { ethers } from "ethers";

export type WalletKeyType = "mnemonic" | "private-key";

export interface WalletKeyValidationResult {
  valid: boolean;
  /** Best-guess classification of what the user typed, even when invalid —
   *  lets the UI say "that looks like a seed phrase, but ..." vs
   *  "that looks like a private key, but ...". Null only when the input is
   *  empty or is neither shape (e.g. random text). */
  type: WalletKeyType | null;
  /** Derived address, only present when valid — lets the UI show what
   *  wallet the entered credential actually resolves to before saving. */
  address?: string;
  error?: string;
}

const HEX_PRIVATE_KEY_RE = /^(0x)?[0-9a-fA-F]{64}$/;

export function validateWalletKey(raw: string): WalletKeyValidationResult {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { valid: false, type: null, error: "Enter a seed phrase or private key" };

  const words = trimmed.split(/\s+/).filter(Boolean);

  // Looks like a mnemonic — BIP-39 seed phrases are always 12/15/18/21/24 words.
  if (words.length > 1) {
    if (![12, 15, 18, 21, 24].includes(words.length)) {
      return {
        valid: false,
        type: "mnemonic",
        error: `Seed phrases are 12–24 words (in steps of 3) — got ${words.length} words`,
      };
    }
    const normalized = words.join(" ").toLowerCase();
    if (!ethers.Mnemonic.isValidMnemonic(normalized)) {
      return { valid: false, type: "mnemonic", error: "Invalid seed phrase — check the word spelling and order" };
    }
    try {
      const wallet = ethers.HDNodeWallet.fromPhrase(normalized);
      return { valid: true, type: "mnemonic", address: wallet.address };
    } catch (err: any) {
      return { valid: false, type: "mnemonic", error: err?.message ?? "Invalid seed phrase" };
    }
  }

  // Single token — treat as a raw private key.
  if (!HEX_PRIVATE_KEY_RE.test(trimmed)) {
    return {
      valid: false,
      type: words.length === 1 ? "private-key" : null,
      error: "Not a valid seed phrase (12–24 words) or a 64-character hex private key",
    };
  }
  try {
    const pk = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
    const wallet = new ethers.Wallet(pk);
    return { valid: true, type: "private-key", address: wallet.address };
  } catch (err: any) {
    return { valid: false, type: "private-key", error: err?.message ?? "Invalid private key" };
  }
}
