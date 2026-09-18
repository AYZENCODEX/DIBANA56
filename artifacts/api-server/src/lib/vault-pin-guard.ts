/**
 * lib/vault-pin-guard.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The Vault Security PIN (vault_security.vault_pin_hash) is the single most
 * powerful credential in Vault — see schema/vault-security.ts's field
 * comment. On top of whatever a given action already requires (an
 * authenticator code, a passkey ceremony, the current Vault password), it
 * must ALSO be supplied correctly for:
 *   - creating/changing the Vault Security PIN itself (routes/vault-security.ts)
 *   - Vault 2FA enable/disable (routes/vault-security.ts)
 *   - Vault password set/change/disable (routes/vault-security.ts)
 *   - passkey create/delete (routes/passkey.ts — passkeys double as Vault
 *     re-auth step 1, so changing them is a Vault-security action too)
 *   - Vault re-auth step 2 and step 3 (routes/vault-reauth.ts)
 *
 * requireVaultPin() is the one place that check happens, so lockout
 * behavior and error shape stay identical everywhere it's enforced.
 *
 * Exception: while no Vault PIN has been set yet (a brand-new account, or
 * one mid-setup), this check is skipped — requireVaultPin() below returns
 * ok:true whenever vaultPinHash is still NULL. Nothing can require a
 * credential that doesn't exist yet; this is what lets /vault/security stay
 * reachable and other Vault-security actions completable before the
 * mandatory PIN is created. Once it is set, this guard applies everywhere
 * unconditionally.
 */
import { db, vaultSecurityTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { verifyPassword } from "./password";

const FAILED_ATTEMPT_LIMIT = 5;
const LOCKOUT_MS = 60_000;
const failedAttempts = new Map<number, { count: number; lockedUntil: number }>();

export function isVaultPinLockedOut(userId: number): number {
  const entry = failedAttempts.get(userId);
  if (!entry) return 0;
  const remaining = entry.lockedUntil - Date.now();
  return remaining > 0 ? remaining : 0;
}

function recordFailure(userId: number): void {
  const entry = failedAttempts.get(userId) ?? { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= FAILED_ATTEMPT_LIMIT) {
    entry.lockedUntil = Date.now() + LOCKOUT_MS;
    entry.count = 0;
  }
  failedAttempts.set(userId, entry);
}

export function clearVaultPinFailures(userId: number): void {
  failedAttempts.delete(userId);
}

export async function hasVaultPin(userId: number): Promise<boolean> {
  const [row] = await db.select({ vaultPinHash: vaultSecurityTable.vaultPinHash })
    .from(vaultSecurityTable).where(eq(vaultSecurityTable.userId, userId)).limit(1);
  return !!row?.vaultPinHash;
}

export type VaultPinCheckResult =
  | { ok: true }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Verifies `pin` against this user's Vault Security PIN. Returns { ok: true }
 * when either the PIN is correct OR no Vault PIN has been set yet (nothing
 * to gate on — see file header). Callers should short-circuit their
 * response with `res.status(result.status).json(result.body)` on failure.
 */
export async function requireVaultPin(userId: number, pin: unknown): Promise<VaultPinCheckResult> {
  const lockedMs = isVaultPinLockedOut(userId);
  if (lockedMs > 0) {
    return {
      ok: false,
      status: 429,
      body: {
        error: "Too many attempts",
        code: "VAULT_PIN_LOCKED",
        solution: `Wait ${Math.ceil(lockedMs / 1000)}s before trying again.`,
        retryAfterMs: lockedMs,
      },
    };
  }

  const [row] = await db.select({ vaultPinHash: vaultSecurityTable.vaultPinHash })
    .from(vaultSecurityTable).where(eq(vaultSecurityTable.userId, userId)).limit(1);

  if (!row?.vaultPinHash) {
    // Nothing set yet — this is only reachable before the mandatory
    // first-time PIN setup completes. Nothing to check against.
    return { ok: true };
  }

  if (typeof pin !== "string" || !/^\d{4}$/.test(pin)) {
    return {
      ok: false,
      status: 400,
      body: { error: "Vault PIN is required", code: "VAULT_PIN_REQUIRED" },
    };
  }

  const matches = await verifyPassword(pin, row.vaultPinHash);
  if (!matches) {
    recordFailure(userId);
    return {
      ok: false,
      status: 401,
      body: { error: "Incorrect Vault PIN", code: "WRONG_VAULT_PIN" },
    };
  }

  clearVaultPinFailures(userId);
  return { ok: true };
}
