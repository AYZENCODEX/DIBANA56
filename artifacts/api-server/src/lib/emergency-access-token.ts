/**
 * lib/emergency-access-token.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Bearer tokens for emergency_access_grants — same SHA-256-hash-at-rest
 * principle as lib/api-key-crypto.ts's AYZEN developer API keys: the raw
 * token is shown to the trusted contact exactly once (in the approval
 * email), only its hash is ever persisted, and a leaked DB never yields a
 * usable token.
 */
import crypto from "crypto";

export const EMERGENCY_TOKEN_PREFIX = "ayzn_emrg_";

export interface GeneratedEmergencyToken {
  plaintext: string;
  hash: string;
}

export function generateEmergencyAccessToken(): GeneratedEmergencyToken {
  const random = crypto.randomBytes(32).toString("base64url");
  const plaintext = `${EMERGENCY_TOKEN_PREFIX}${random}`;
  return { plaintext, hash: hashEmergencyAccessToken(plaintext) };
}

export function hashEmergencyAccessToken(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext, "utf8").digest("hex");
}

export function generateInviteToken(): string {
  return crypto.randomBytes(24).toString("hex");
}
