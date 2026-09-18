/**
 * lib/api-key-crypto.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Drop this at: artifacts/api-server/src/lib/api-key-crypto.ts
 *
 * Generates and verifies AYZEN developer API keys.
 *
 * Same principle as password storage: the raw key is shown to the user
 * exactly ONCE (right after creation) and is never stored anywhere. Only
 * its SHA-256 hash is persisted in `api_keys.key_hash`. On every request we
 * hash the incoming key and look up the hash — if the DB is ever leaked,
 * no usable keys leak with it.
 *
 * Key format:  ayzn_live_<43 random URL-safe base64 characters>
 *   - "ayzn_live_" prefix makes keys grep-able / recognizable (same idea as
 *     stripe's sk_live_, github's ghp_, etc.) and lets us tell an AYZEN API
 *     key apart from a JWT at a glance, without a DB lookup.
 *   - 32 random bytes (~256 bits) of entropy, base64url-encoded.
 */
import crypto from "crypto";

export const API_KEY_PREFIX = "ayzn_live_";

/** How much of the key is safe to store/display in plaintext (prefix shown in the dashboard). */
const DISPLAY_PREFIX_LEN = 8; // characters of the random part shown, e.g. "ayzn_live_ab12cd34"

export interface GeneratedApiKey {
  /** Full secret — return this to the user ONCE, never store it. */
  plaintext: string;
  /** SHA-256 hex hash — store this in the DB. */
  hash: string;
  /** Short, safe-to-display fragment, e.g. "ayzn_live_ab12cd34". */
  displayPrefix: string;
}

export function generateApiKey(): GeneratedApiKey {
  const random = crypto.randomBytes(32).toString("base64url"); // 43 chars, URL-safe
  const plaintext = `${API_KEY_PREFIX}${random}`;
  return {
    plaintext,
    hash: hashApiKey(plaintext),
    displayPrefix: plaintext.slice(0, API_KEY_PREFIX.length + DISPLAY_PREFIX_LEN),
  };
}

export function hashApiKey(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext, "utf8").digest("hex");
}

/** Cheap shape check before bothering the DB — avoids hashing/querying for obviously-not-a-key tokens. */
export function looksLikeApiKey(token: string): boolean {
  return token.startsWith(API_KEY_PREFIX) && token.length > API_KEY_PREFIX.length + 20;
}

/** Constant-time hash comparison (defense in depth; DB equality lookup is already exact-match). */
export function safeCompareHash(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
