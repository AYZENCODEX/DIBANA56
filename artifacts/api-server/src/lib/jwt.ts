/**
 * lib/jwt.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 1, Phase 1A (Crypto Foundation, part A): HS256 → RS256.
 * Verification is now kid-based and deterministic (Phase 1D-b) — see
 * decodeHeader()/tryVerifyRs256() below and resolveVerificationKeys() in
 * lib/jwt-keys.ts.
 *
 * HISTORY
 * This file used to sign tokens with HMAC-SHA256 (HS256) using a single
 * shared secret (AYZEN_JWT_SECRET) — see git history / the OIDC roadmap doc
 * for the full writeup of why that was fine for a single-codebase SPA but
 * blocks real OIDC clients (they'd need the power to forge tokens just to
 * verify them). Tokens are now signed with RS256 against an asymmetric
 * keypair resolved in lib/jwt-keys.ts: AYZEN Central Account holds the
 * private key, every verifier only ever needs the public key.
 *
 * WHAT'S STILL MISSING (later phases, not this file)
 *  - Key rotation / multiple retained public keys (Phase 1B)
 *  - GET /.well-known/jwks.json + /.well-known/openid-configuration (Phase 1B)
 *  - client registry, Authorization Code + PKCE, id_token/UserInfo (Phase 2+)
 *
 * ROLLOUT
 * Deploying this invalidates every previously-issued HS256 token by default
 * — same call the project made for the original unsigned→HS256 migration.
 * Set ALLOW_LEGACY_HS256_TOKENS=true (lib/jwt-keys.ts) for a temporary grace
 * period that also accepts old HS256 tokens; leave it off once real logins
 * have replaced old sessions (they expire within 7 days on their own).
 */

import jwt, { type SignOptions } from "jsonwebtoken";
import {
  getActiveKeypair,
  getLegacyHs256Secret,
  ALLOW_LEGACY_HS256_TOKENS,
  resolveVerificationKeys,
} from "./jwt-keys";
import { logger } from "./logger";

export interface AuthTokenPayload {
  userId: number;
  role: string;
  /**
   * Session id (== the `jti` row in `user_sessions`, see lib/sessions.ts).
   * Every AYZEN "sub-app" (Mail, Vault, Finance, Marketplace, …) is really
   * just a route inside the one SPA, so they already share this token as
   * a single sign-on session for free — `sid` is what lets the account's
   * Security page show/revoke that shared session as a real "device",
   * the same way Google's account page lists signed-in devices, instead
   * of the token being an opaque, unrevocable bearer secret.
   * Optional so tokens minted before this existed keep working.
   */
  sid?: string;
}

const DEFAULT_EXPIRY = "7d";

/** Issue a signed, tamper-proof session token (RS256). Pass `sid` to bind it to a `user_sessions` row (see lib/sessions.ts) so it shows up in — and can be revoked from — the account's device list. */
export function signAuthToken(
  userId: number,
  role: string,
  options?: SignOptions & { sid?: string },
): string {
  const { sid, ...signOpts } = options ?? {};
  const { privateKey, kid } = getActiveKeypair();
  return jwt.sign(
    { userId, role, ...(sid ? { sid } : {}) } satisfies AuthTokenPayload,
    privateKey,
    {
      algorithm: "RS256",
      keyid: kid,
      expiresIn: DEFAULT_EXPIRY,
      ...signOpts,
    },
  );
}

/**
 * Sign/verify a short-lived, tamper-proof "state" value — used by the
 * Feature 15l Google Drive/Dropbox OAuth connect flow (routes/vault-
 * backup-cloud.ts) to carry `userId` through the redirect round-trip to an
 * external provider and back, since that provider's callback can't be
 * trusted to send it un-tampered on its own (and a plain userId query
 * param would let anyone attach a stolen OAuth code to a different
 * account). Reuses the same signing keypair as session tokens above — a
 * separate OAuth-state key would just be one more thing to configure and
 * rotate for no real security gain.
 */
export function signOAuthState(payload: Record<string, unknown>, expiresIn: SignOptions["expiresIn"] = "10m"): string {
  const { privateKey, kid } = getActiveKeypair();
  return jwt.sign(payload, privateKey, { algorithm: "RS256", keyid: kid, expiresIn });
}

/**
 * Reads a JWT's header (`alg`/`kid`) without verifying the signature — used
 * only to decide WHICH key(s) to attempt verification with, never to trust
 * any claim in the token. Returns null for a malformed/undecodable token;
 * callers treat that the same as "no RS256 header info available".
 */
function decodeHeader(token: string): { alg?: string; kid?: string } | null {
  try {
    const decoded = jwt.decode(token, { complete: true }) as { header?: { alg?: string; kid?: string } } | null;
    return decoded?.header ?? null;
  } catch {
    return null;
  }
}

/**
 * Tries every RS256 verification key resolveVerificationKeys(kid) returns
 * (lib/jwt-keys.ts — Phase 1D-b), in order, and returns the first payload
 * that verifies. `kid` is deterministic by construction here: if it names a
 * real kid, resolveVerificationKeys() returns either exactly that key or
 * nothing — this loop never has an "unrelated" key available to fall back
 * to, it only ever has what was explicitly resolved for that kid (or, for a
 * kid-less legacy token, every currently valid key).
 */
function tryVerifyRs256<T>(token: string, kid: string | undefined): T | null {
  for (const candidate of resolveVerificationKeys(kid)) {
    try {
      return jwt.verify(token, candidate.publicKey, { algorithms: ["RS256"] }) as T;
    } catch {
      continue; // this candidate didn't verify this token — try the next, if any
    }
  }
  return null;
}

export function verifyOAuthState<T extends Record<string, unknown> = Record<string, unknown>>(token: string): T | null {
  const header = decodeHeader(token);
  if (header?.alg && header.alg !== "RS256") return null; // OAuth state is RS256-only, no legacy path
  return tryVerifyRs256<T>(token, header?.kid);
}

function extractPayload(decoded: Record<string, unknown>): AuthTokenPayload | null {
  const userId = decoded.userId;
  const role = decoded.role;
  const sid = decoded.sid;
  if (typeof userId === "number" && userId > 0 && typeof role === "string") {
    return { userId, role, ...(typeof sid === "string" ? { sid } : {}) };
  }
  return null;
}

/**
 * Verify a signed session token. Returns null on any failure — never throws.
 *
 * Tries RS256 first, resolved deterministically by the token's own `kid`
 * header (see resolveVerificationKeys() in lib/jwt-keys.ts — Phase 1D-b): a
 * `kid` that names a real active/retiring key verifies against exactly that
 * key; a `kid` that doesn't match anything resolves to zero candidates and
 * the token is rejected outright — it is never retried against some other,
 * unrelated key just because that key happens to be around. A token with no
 * `kid` at all (legacy/kid-less) is tried against every currently valid key,
 * same permissiveness this function always had pre-Phase-1D.
 *
 * Falls back to the legacy HS256 verify path only when
 * ALLOW_LEGACY_HS256_TOKENS=true (rollout grace period — see
 * lib/jwt-keys.ts) and the token isn't itself already an RS256 token, and
 * never mixes algorithms within a single attempt (each jwt.verify call pins
 * `algorithms` explicitly, so a token can't be re-signed under the "wrong"
 * scheme to slip past the intended check).
 */
export function verifyAuthToken(token: string): AuthTokenPayload | null {
  const header = decodeHeader(token);

  if (!header?.alg || header.alg === "RS256") {
    const decoded = tryVerifyRs256<Record<string, unknown>>(token, header?.kid);
    if (decoded) {
      const payload = extractPayload(decoded);
      if (payload) return payload;
    } else if (header?.kid) {
      logger.warn(
        { kid: header.kid },
        "[security] rejected RS256 session token: kid did not resolve to a known active/retiring verification key",
      );
    }
  }

  if (ALLOW_LEGACY_HS256_TOKENS && (!header?.alg || header.alg === "HS256")) {
    const legacySecret = getLegacyHs256Secret();
    if (legacySecret) {
      try {
        const decoded = jwt.verify(token, legacySecret, { algorithms: ["HS256"] }) as Record<string, unknown>;
        const payload = extractPayload(decoded);
        if (payload) {
          logger.warn(
            { userId: payload.userId },
            "[security] accepted legacy HS256 session token — set ALLOW_LEGACY_HS256_TOKENS=false once rollout is complete",
          );
        }
        return payload;
      } catch {
        return null;
      }
    }
  }

  return null;
}
