/**
 * lib/password.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * SECURITY FIX — password hashing.
 *
 * BEFORE: routes/auth.ts hashed passwords with
 *     sha256(password + "ayzen_salt")
 * That's a single, hard-coded, shared salt and a fast general-purpose hash —
 * exactly the combination password hashing is supposed to avoid. A leaked
 * users table could be cracked with an off-the-shelf GPU rig and a rainbow
 * table built once for "ayzen_salt" and reused against every account.
 *
 * NOW: bcrypt (via bcryptjs — pure JS, no native build step, works on
 * Replit/Render out of the box) with a unique random salt per password and
 * a deliberately slow work factor.
 *
 * MIGRATION: verifyPassword() still recognizes the old sha256 format so
 * existing users are not locked out. On a successful legacy login, callers
 * should re-hash and save the password with hashPassword() (see
 * `needsRehash` below) so accounts are upgraded transparently over time.
 */

import bcrypt from "bcryptjs";
import crypto from "crypto";

const BCRYPT_ROUNDS = 12;
const LEGACY_SALT = "ayzen_salt";

function legacySha256(password: string): string {
  return crypto.createHash("sha256").update(password + LEGACY_SALT).digest("hex");
}

function isBcryptHash(hash: string): boolean {
  return /^\$2[aby]\$/.test(hash);
}

/** Hash a new password. Always produces the new, safe bcrypt format. */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/**
 * Verify a password against a stored hash, supporting both the current
 * bcrypt format and the legacy sha256 format (for accounts not yet migrated).
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (!storedHash) return false;
  if (isBcryptHash(storedHash)) {
    return bcrypt.compare(password, storedHash);
  }
  // Legacy sha256 comparison — constant-time to avoid timing side-channels.
  const candidate = Buffer.from(legacySha256(password));
  const stored = Buffer.from(storedHash);
  if (candidate.length !== stored.length) return false;
  return crypto.timingSafeEqual(candidate, stored);
}

/** True if a stored hash is still in the legacy sha256 format and should be upgraded. */
export function needsRehash(storedHash: string): boolean {
  return !!storedHash && !isBcryptHash(storedHash);
}
