/**
 * lib/oidc-pkce.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 2, Phase 3d: PKCE Enforcement.
 *
 * Phase 3a-f already validated the AUTHORIZE-time half of PKCE (the
 * `code_challenge` shape and that `code_challenge_method` is exactly
 * `"S256"`, never `"plain"`) and Phase 3b-e persisted that challenge bound
 * to the issued code. This file is the TOKEN-time half: given the
 * `code_verifier` a client sends to `/oidc/token`, decide whether it is the
 * one thing that actually produces the challenge that was persisted.
 *
 * Scope discipline (this is 3d, not 3c or 4):
 *   - Does not look up, consume, or know anything about
 *     `oidc_authorization_codes` rows — it takes the already-resolved
 *     `codeChallenge`/`codeChallengeMethod` as plain arguments (same
 *     DB-free-pure-function discipline every earlier phase's core check
 *     used: `validateOidcRedirectUri`, `checkAuthorizationCodeBinding`,
 *     etc.). Phase 3c's `routes/oidc-token.ts` is the only caller, and it
 *     supplies those two fields from the row `consumeAuthorizationCode()`
 *     (3c-e) already fetched — this file never issues its own query.
 *   - Only `"S256"` is ever accepted as a real method. `"plain"` is
 *     recognized only well enough to name it in
 *     `unsupported_method` — see 3d-c's own note below for why silently
 *     falling back to it would defeat 3a-f's original decision.
 *
 * 3.2 GLOBAL SECURITY REQUIREMENTS, applied here:
 *   - "reject missing verifier"   -> 3d-e / `missing_verifier`.
 *   - "reject incorrect verifier" -> 3d-e / `challenge_mismatch`.
 *   - "do not silently downgrade" -> 3d-c: an unsupported/missing method on
 *     the STORED row is rejected outright, never treated as if it were
 *     S256 or as if PKCE could be skipped for this code.
 */
import crypto from "node:crypto";

/**
 * 3d-b: Challenge Calculation.
 *
 * RFC 7636 §4.2: `code_challenge = BASE64URL-ENCODE(SHA256(ASCII(code_verifier)))`.
 * `code_verifier` is itself defined (§4.1) as an ASCII string drawn from
 * `[A-Za-z0-9-._~]`, so `"ascii"` encoding here is exact per spec, not an
 * approximation — there is no multi-byte input this function needs to
 * account for. `"base64url"` output (no padding) matches exactly what
 * `code_challenge` was validated to look like in 3a-f (43 characters,
 * `[A-Za-z0-9\-_]`, no `=`).
 */
export function computeS256Challenge(codeVerifier: string): string {
  return crypto.createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}

/**
 * 3d-d: Constant-Safe Comparison.
 *
 * Same precedent as `lib/api-key-crypto.ts`'s `safeCompareHash()` — a
 * length check up front (an unavoidable, non-secret-dependent leak: string
 * length is not the secret here, the verifier is) followed by
 * `crypto.timingSafeEqual` so a byte-by-byte early-exit comparison can
 * never turn "how many leading characters of my guessed verifier's derived
 * challenge matched" into a practical timing oracle.
 */
function safeCompareStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** 3d-e: the distinct rejection reasons `/oidc/token` (Phase 3c) needs to log — all map to the same public `invalid_grant` OAuth error (see routes/oidc-token.ts), same "one public code, richer internal detail" shape Phase 2C/2D established for `invalid_client`/`invalid_scope`. */
export type PkceVerificationResult =
  | { ok: true }
  | { ok: false; reason: "missing_verifier" | "unsupported_method" | "challenge_mismatch" };

/**
 * 3d-a/3d-c/3d-d/3d-e composed: verify a token request's `code_verifier`
 * against the `code_challenge`/`code_challenge_method` that were persisted
 * for this code back at authorize-time (3b-e).
 *
 * `codeVerifier` is `string | undefined` (3d-a: reading it off the parsed
 * token request is `lib/oidc-token-request.ts`'s job, not this function's —
 * this is the pure check layered on top, same split every earlier phase's
 * "-request.ts parses, -validation.ts checks" pair used).
 *
 * Order: missing verifier is checked first (3d-e) — a request with no
 * verifier at all should never even attempt a hash comparison, both because
 * there is nothing to hash and because it keeps "you sent nothing" and "you
 * sent the wrong thing" as distinguishable log reasons. `codeChallengeMethod`
 * is checked next (3d-c) — this codebase only ever writes `"S256"` via 3a-f's
 * validation, so a stored row with anything else should be structurally
 * unreachable, but this function treats that as a hard, explicit rejection
 * rather than an assumption it silently trusts, exactly per section 3.2's
 * "do not silently downgrade". Only once both of those pass is the actual
 * SHA-256 challenge computed and compared (3d-b/3d-d).
 */
export function verifyPkce(
  codeVerifier: string | undefined,
  codeChallenge: string,
  codeChallengeMethod: string,
): PkceVerificationResult {
  if (!codeVerifier) {
    return { ok: false, reason: "missing_verifier" };
  }
  if (codeChallengeMethod !== "S256") {
    return { ok: false, reason: "unsupported_method" };
  }
  const expected = computeS256Challenge(codeVerifier);
  if (!safeCompareStrings(expected, codeChallenge)) {
    return { ok: false, reason: "challenge_mismatch" };
  }
  return { ok: true };
}
