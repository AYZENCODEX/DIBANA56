/**
 * lib/oidc-backchannel-logout-receive.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 3, Phase 6e-b: Sylo Integration (receiving side).
 *
 * The RP-side counterpart to `lib/oidc-logout-propagation.ts`'s
 * `issueOidcLogoutToken()` / `dispatchBackchannelLogoutForUser()` — verifies
 * an inbound Logout Token per OpenID Back-Channel Logout 1.0 §2.6 and, once
 * verified, ends Sylo's own local session(s) for that user via
 * `lib/sessions.ts`'s `revokeSessionsByUserAndOriginClient()` (migration
 * 086's `origin_client_id` tag is exactly what lets this resolve "which of
 * this user's sessions are Sylo's" without a `sid` — see that function's
 * own header for why).
 *
 * The one caller is `routes/oidc-backchannel-logout.ts`'s
 * `backchannelLogoutHandler()` — see that route's own header for the
 * §2.6 response-code contract this function's return value drives (a
 * verification failure of ANY kind below maps to the same HTTP 400
 * `{ error: "invalid_request" }`, never a different status per failure
 * reason — §2.6 doesn't distinguish them at the wire level, so neither
 * does this function's caller).
 *
 * VERIFICATION CHECKLIST (§2.6), mirroring `verifyIdTokenHint()`'s
 * RS256/`kid` pattern from `lib/oidc-id-token.ts` — both verify a token
 * this SAME provider signed against its own published JWKS (Phase 1e):
 *   - RS256 signature verifies against a current active/retiring key
 *     (`resolveVerificationKeys()`, `lib/jwt-keys.ts`).
 *   - `exp` IS enforced (unlike `verifyIdTokenHint()`'s deliberate
 *     `ignoreExpiration: true` for an `id_token_hint`) — a Logout Token is
 *     a live, short-TTL (`LOGOUT_TOKEN_TTL_SECONDS`, 2 minutes) event
 *     notification consumed once near issuance, never a credential
 *     re-presented well after the fact.
 *   - `iss` matches this provider's own issuer identity
 *     (`resolveIssuer()`).
 *   - `events` carries the exact Back-Channel Logout schema key
 *     (`BACKCHANNEL_LOGOUT_EVENT`, §2.4) — imported from
 *     `lib/oidc-logout-propagation.ts` rather than re-declared, so the
 *     sending and receiving sides can never drift on the literal string.
 *   - `nonce` MUST NOT be present (§2.4's own explicit prohibition — a
 *     Logout Token is never an authentication-freshness proof the way an
 *     ID token is).
 *   - `sub` present and a positive integer string (this provider's own
 *     `String(userId)` convention — see `buildLogoutTokenClaims()`).
 *   - `aud` names a real, currently-registered `oidc_clients.client_id`
 *     (`oidcClientExists()`, Phase 2A-c) — this is also the exact
 *     `client_id` value handed to `revokeSessionsByUserAndOriginClient()`
 *     below, so a token whose `aud` doesn't resolve to a real client can
 *     never be used to "revoke" a client_id that could never have tagged
 *     a real session in the first place.
 *
 * NOT this file's scope:
 *   - No retry/replay-detection beyond `exp` (`jti` uniqueness tracking
 *     is 6e-c, Failure Handling, if it turns out to be needed at all —
 *     this provider's own Logout Tokens are single-use-by-construction
 *     fire-and-forget events, not bearer credentials, so replay
 *     protection beyond a short `exp` window is not started here).
 *   - No `oidc.backchannel_logout.*` metrics/alerting beyond the
 *     `logger.info`/`logger.warn` calls below — 6e-d (Monitoring).
 */
import jwt from "jsonwebtoken";
import { resolveVerificationKeys } from "./jwt-keys";
import { resolveIssuer } from "./oidc-discovery";
import { BACKCHANNEL_LOGOUT_EVENT } from "./oidc-logout-propagation";
import { oidcClientExists } from "./oidc-clients";
import { revokeSessionsByUserAndOriginClient } from "./sessions";
import { logger } from "./logger";

/** Every distinct reason `handleInboundBackchannelLogout()` can decline a token — kept internally granular for logging even though the route's own §2.6 response is the same `invalid_request` for all of them. */
export type BackchannelLogoutReceiveFailureReason =
  | "unsupported_alg"
  | "signature_verification_failed"
  | "issuer_mismatch"
  | "nonce_present"
  | "missing_events_claim"
  | "malformed_claims"
  | "unknown_client"
  | "expired";

export type BackchannelLogoutReceiveResult =
  | { ok: true; userId: number; clientId: string }
  | { ok: false; reason: BackchannelLogoutReceiveFailureReason };

/**
 * Reads a JWT's header (`alg`/`kid`) without verifying the signature —
 * used only to decide WHICH key(s) to attempt verification with, never to
 * trust any claim in the token. Identical in shape and purpose to
 * `lib/oidc-id-token.ts`'s own private `decodeHeader()` — duplicated
 * rather than imported since that one is intentionally unexported.
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
 * 6e-b: verifies an inbound `logout_token` is a genuine, current,
 * unexpired Logout Token this provider itself issued for a real
 * registered client, and — if so — revokes exactly that client's tagged
 * sessions for the named user. See file header for the full checklist and
 * `routes/oidc-backchannel-logout.ts` for the one caller.
 */
export async function handleInboundBackchannelLogout(logoutToken: string): Promise<BackchannelLogoutReceiveResult> {
  const header = decodeHeader(logoutToken);
  if (header?.alg && header.alg !== "RS256") {
    logger.warn({ alg: header.alg }, "oidc.backchannel_logout.received.unsupported_alg");
    return { ok: false, reason: "unsupported_alg" };
  }

  for (const candidate of resolveVerificationKeys(header?.kid)) {
    let decoded: Record<string, unknown>;
    try {
      decoded = jwt.verify(logoutToken, candidate.publicKey, { algorithms: ["RS256"] }) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        logger.warn({}, "oidc.backchannel_logout.received.expired");
        return { ok: false, reason: "expired" };
      }
      continue; // this candidate key didn't verify this token — try the next, if any
    }

    if (decoded.iss !== resolveIssuer()) {
      logger.warn({}, "oidc.backchannel_logout.received.issuer_mismatch");
      return { ok: false, reason: "issuer_mismatch" };
    }
    if ("nonce" in decoded) {
      logger.warn({}, "oidc.backchannel_logout.received.nonce_present");
      return { ok: false, reason: "nonce_present" };
    }
    const events = decoded.events as Record<string, unknown> | undefined;
    if (!events || typeof events !== "object" || !(BACKCHANNEL_LOGOUT_EVENT in events)) {
      logger.warn({}, "oidc.backchannel_logout.received.missing_events_claim");
      return { ok: false, reason: "missing_events_claim" };
    }

    const sub = decoded.sub;
    const aud = decoded.aud;
    if (typeof sub !== "string" || sub.length === 0 || typeof aud !== "string" || aud.length === 0) {
      logger.warn({}, "oidc.backchannel_logout.received.malformed_claims");
      return { ok: false, reason: "malformed_claims" };
    }
    const userId = Number(sub);
    if (!Number.isInteger(userId) || userId <= 0) {
      logger.warn({ sub }, "oidc.backchannel_logout.received.malformed_claims");
      return { ok: false, reason: "malformed_claims" };
    }

    if (!(await oidcClientExists(aud))) {
      logger.warn({ clientId: aud }, "oidc.backchannel_logout.received.unknown_client");
      return { ok: false, reason: "unknown_client" };
    }

    const revoked = await revokeSessionsByUserAndOriginClient(userId, aud).catch((err) => {
      logger.warn({ err, userId, clientId: aud }, "oidc.backchannel_logout.received.revoke_failed");
      return 0;
    });

    logger.info({ userId, clientId: aud, revoked }, "oidc.backchannel_logout.received.processed");
    return { ok: true, userId, clientId: aud };
  }

  logger.warn({}, "oidc.backchannel_logout.received.signature_verification_failed");
  return { ok: false, reason: "signature_verification_failed" };
}
