/**
 * routes/oidc-userinfo.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 2, Phase 4c-f: `GET /oidc/userinfo`.
 *
 * Composes 4c-a/4c-b/4c-c (`lib/oidc-access-token-verification.ts`) and
 * 4c-d/4c-e (`lib/oidc-userinfo.ts`) into the actual HTTP endpoint:
 *
 *   extract Bearer token from Authorization header (4c-f, this file)
 *     -> verify signature/issuer/expiry, extract subject + scopes
 *        (4c-a/4c-b/4c-c, verifyOidcAccessToken())
 *     -> look up the user, rejecting banned/suspended accounts
 *        (fetchOidcUserinfoRecord())
 *     -> shape the response claims by granted scope
 *        (4c-d/4c-e, buildUserinfoClaims())
 *
 * BEARER EXTRACTION: `Authorization: Bearer <token>` ONLY — deliberately
 * NOT `lib/auth-utils.ts`'s `getTokenFromReq()`, which also reads the
 * `ayzen_session` cookie. UserInfo is a resource-server endpoint any OIDC
 * client's BACKEND calls directly (RFC 6750 §2.1's bearer-token usage,
 * same "this URL is called cross-origin, server-to-server, no browser
 * cookie jar involved" reasoning `routes/oidc-token.ts`'s own header
 * already gives for why it never reads a cookie either) — accepting a
 * cookie here would mean a same-site XSS or CSRF-adjacent bug on
 * `ayzen.tech` could exfiltrate account claims through an endpoint that
 * was only ever meant to answer OIDC clients presenting a token they
 * themselves received.
 *
 * ERROR SHAPE: RFC 6750 §3.1, not section 4's `OidcTokenErrorCode` union
 * — UserInfo is a RESOURCE endpoint, not a TOKEN endpoint, and RFC 6750
 * defines its own `WWW-Authenticate: Bearer ...` challenge header
 * separately from OAuth's token-endpoint error body. Every failure here
 * (missing header, malformed token, bad signature, expired, unknown
 * `kid`, banned account, ...) is reported identically as `401` +
 * `WWW-Authenticate: Bearer error="invalid_token"` + `{ error:
 * "invalid_token" }` — collapsing every internal reason to one public
 * shape is the same "one public code, richer internal-only detail via
 * logging" discipline `oidc-authorize.ts`/`oidc-token.ts` already use for
 * their own error unions, applied to RFC 6750's (smaller) vocabulary
 * instead of RFC 6749's. The one exception: a request with NO
 * `Authorization` header at all gets `error="invalid_request"` per RFC
 * 6750 §3.1's own distinction between "didn't even try to authenticate"
 * and "tried, and it didn't check out".
 *
 * MOUNTING / RATE LIMITING: bare origin (not `/api`, not behind
 * `apiKeyScopeGate`) — same convention `routes/oidc-authorize.ts` and
 * `routes/oidc-token.ts` already established, for the identical reason:
 * an OIDC client's backend calls this URL directly against the issuer's
 * origin. `globalLimiter`, NOT `authLimiter` — this is a resource
 * endpoint read by a client that already holds a validly-issued,
 * unguessable access token, not a credential-guessing surface the way
 * `/oidc/token` (accepts a client-supplied authorization `code`) or a
 * login form is; the concern `authLimiter` exists for doesn't apply here.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { globalLimiter } from "../middlewares/security";
import { verifyOidcAccessToken } from "../lib/oidc-access-token-verification";
import { hashOidcAccessToken, isAccessTokenRevoked } from "../lib/oidc-token-revocation";
import { fetchOidcUserinfoRecord, buildUserinfoClaims } from "../lib/oidc-userinfo";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/** RFC 6750 §3.1: the one challenge value this endpoint ever issues — it never distinguishes error reasons in the header itself, only (identically) in the JSON body's `error` field. */
function respondUnauthorized(res: Response, error: "invalid_request" | "invalid_token"): void {
  res.setHeader("WWW-Authenticate", `Bearer error="${error}"`);
  res.status(401).json({ error });
}

/**
 * 4c-f: `Authorization: Bearer <token>` extraction — case-insensitive
 * scheme per RFC 6750 §2.1, header only (see file header for why never a
 * cookie/query-param fallback). Returns `null` for anything that isn't
 * exactly that shape (missing header, wrong scheme, empty token) rather
 * than guessing at a looser match.
 */
function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1] : null;
}

/**
 * The actual handler logic, exported separately from the router wiring —
 * same reasoning as `tokenHandler`/`authorizeHandler` and every earlier
 * route in this roadmap: unit-testable with a minimal req/res double
 * instead of a live HTTP server. (This one still needs a live DB for
 * `fetchOidcUserinfoRecord()` — see this pass's own test file for exactly
 * which parts of the 4c-f chain that leaves untested here.)
 */
export async function userinfoHandler(req: Request, res: Response): Promise<void> {
  const rawToken = extractBearerToken(req);
  if (!rawToken) {
    respondUnauthorized(res, "invalid_request");
    return;
  }

  // 4c-a/4c-b/4c-c
  const verified = verifyOidcAccessToken(rawToken);
  if (!verified.ok) {
    logger.warn({ reason: verified.reason }, "oidc.userinfo.failed");
    respondUnauthorized(res, "invalid_token");
    return;
  }

  // Season 5, Phase 10b — a token that verifies fine can still have been
  // explicitly killed via `POST /oidc/revoke` since it was minted; see
  // lib/oidc-token-revocation.ts's own header for why this is a SEPARATE
  // composed step rather than folded into verifyOidcAccessToken() itself.
  if (await isAccessTokenRevoked(hashOidcAccessToken(rawToken))) {
    logger.warn({ userId: verified.token.userId, clientId: verified.token.clientId }, "oidc.userinfo.failed");
    respondUnauthorized(res, "invalid_token");
    return;
  }

  // Banned/suspended accounts rejected here too — see lib/oidc-userinfo.ts's
  // own header for why this is the identical check getUserFromToken()
  // already applies to session tokens.
  const user = await fetchOidcUserinfoRecord(verified.token.userId);
  if (!user) {
    logger.warn({ userId: verified.token.userId }, "oidc.userinfo.failed");
    respondUnauthorized(res, "invalid_token");
    return;
  }

  // 4c-d/4c-e
  const claims = buildUserinfoClaims(user, verified.token.scopes);

  logger.info({ userId: user.id, clientId: verified.token.clientId }, "oidc.userinfo.served");
  res.status(200).json(claims);
}

router.get("/oidc/userinfo", globalLimiter, userinfoHandler);

export default router;
