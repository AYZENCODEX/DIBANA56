/**
 * lib/vault-lock.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 5 — Vault Security: Re-auth & Session.
 *
 * Client-side "am I still inside my Vault window" state. The server
 * (routes/vault-reauth.ts) only ever verifies a password + 2FA code was
 * entered correctly — it doesn't issue or track a session of its own.
 * "Staying unlocked" is a local, per-browser UI state, same spirit as the
 * existing account "keep me signed in" toggle in hooks/use-auth.tsx.
 *
 * Vault-login re-auth (see components/vault/vault-unlock-gate.tsx):
 *   Re-verifying your account PASSWORD + 2FA code is required whenever
 *   EITHER of these is true:
 *     - This is the first time Vault has been opened today (local calendar
 *       date), OR
 *     - More than VAULT_UNLOCK_HOURS (3) hours have passed since the last
 *       successful re-auth.
 *   Otherwise Vault opens immediately — nothing more to do for the rest of
 *   that 3-hour / same-day window. Stored in localStorage (not sessionStorage)
 *   so the window survives closing and reopening the tab — re-verifying a
 *   password + 2FA code is heavier than the old PIN, so this should not reset
 *   just because a tab was closed.
 *
 * Entity-view PIN (see components/vault/entity-pin-gate.tsx):
 *   Unrelated, unchanged — still a separate, lighter 4-digit PIN scoped to
 *   the current browser session (sessionStorage, no expiry beyond that), so
 *   re-entering the entity PIN is required again next session but not on
 *   every single entity within one. See lib/vault-security-api.ts kind="entity".
 */

const VAULT_UNLOCK_KEY = "ayzen_vault_reauth_at";
const ENTITY_UNLOCK_KEY = "ayzen_entity_unlock";

export const VAULT_UNLOCK_HOURS = 3;

function readVaultReauthAt(): number | null {
  // Legacy key from the old PIN-based unlock stored an *expiry* timestamp,
  // sometimes in sessionStorage — only the new key/format is honored here,
  // so a stale PIN-era unlock can never satisfy the new password+2FA gate.
  const raw = localStorage.getItem(VAULT_UNLOCK_KEY);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function isSameLocalDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db_ = new Date(b);
  return (
    da.getFullYear() === db_.getFullYear() &&
    da.getMonth() === db_.getMonth() &&
    da.getDate() === db_.getDate()
  );
}

/**
 * True if the last Vault re-auth is still within its window: same calendar
 * day AND within the last VAULT_UNLOCK_HOURS hours. False (re-auth required)
 * if either condition fails, or if Vault has never been unlocked.
 */
export function isVaultUnlocked(): boolean {
  const at = readVaultReauthAt();
  if (!at) return false;
  const now = Date.now();
  if (!isSameLocalDay(at, now)) return false; // first Vault visit of a new day
  return now - at <= VAULT_UNLOCK_HOURS * 60 * 60 * 1000;
}

/** Record a successful password + 2FA Vault re-auth, starting a fresh window. */
export function setVaultUnlocked(): void {
  // Clean up the legacy sessionStorage slot from the old PIN-based unlock, if any.
  sessionStorage.removeItem(VAULT_UNLOCK_KEY);
  localStorage.setItem(VAULT_UNLOCK_KEY, String(Date.now()));
}

/** Re-lock Vault immediately (e.g. a manual "Lock Vault" action, or on logout). */
export function lockVault(): void {
  localStorage.removeItem(VAULT_UNLOCK_KEY);
  sessionStorage.removeItem(VAULT_UNLOCK_KEY);
}

/** True if the entity-view PIN has already been unlocked for this browser session. */
export function isEntityViewUnlocked(): boolean {
  return sessionStorage.getItem(ENTITY_UNLOCK_KEY) === "1";
}

/** Record a successful entity-PIN unlock for the rest of this browser session. */
export function setEntityViewUnlocked(): void {
  sessionStorage.setItem(ENTITY_UNLOCK_KEY, "1");
}

/** Re-lock entity-detail viewing immediately. */
export function lockEntityView(): void {
  sessionStorage.removeItem(ENTITY_UNLOCK_KEY);
}

/** Clears both unlock states — call this on account logout. */
export function clearAllVaultLocks(): void {
  lockVault();
  lockEntityView();
}
