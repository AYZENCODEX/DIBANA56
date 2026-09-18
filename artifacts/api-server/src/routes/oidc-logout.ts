/**
 * routes/oidc-logout.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 3, Phase 6a (RP-Initiated Logout Request) + Phase 6b
 * (Session Termination): `GET /oidc/logout`, this provider's
 * `end_session_endpoint` (OIDC RP-Initiated Logout 1.0).
 *
 *   parse + validate request (6a-a..6a-e, lib/oidc-logout-request.ts +
 *   lib/oidc-id-token.ts's verifyIdTokenHint())
 *     -> invalid: direct, non-redirecting error response (6a-e — see
 *        lib/oidc-logout-request.ts's own header for why RP-Initiated
 *        Logout never redirects back an error the way /oidc/authorize
 *        does)
 *     -> valid: identify the caller's OWN session the exact same way
 *        POST /auth/logout already does (6b-a, lib/auth-utils.ts's
 *        getTokenFromReq() + lib/jwt.ts's verifyAuthToken()) — never the
 *        id_token_hint's `sub`, which is untrusted-for-this-purpose
 *        informational data about which client's login the hint names,
 *        not proof of which browser session is making THIS request
 *     -> revoke that session + clear the cookie (6b-b,
 *        lib/sessions.ts's revokeSessionByJti() /
 *        lib/session-cookie.ts's clearSessionCookie() — the identical
 *        two calls POST /auth/logout already makes)
 *     -> redirect to the verified post_logout_redirect_uri (+ state), or
 *        a plain JSON confirmation when none was supplied (6b-d)
 *
 * 6b-a/6b-b, WHY THE SAME MECHANISM AS POST /auth/logout, NOT A NEW ONE:
 * AYZEN's `user_sessions` table (lib/sessions.ts) and `ayzen_session`
 * cookie (lib/session-cookie.ts) are already the ONE session model every
 * first-party surface in this codebase shares (see lib/sessions.ts's own
 * header — Mail/Vault/Finance/Marketplace are all routes in one SPA
 * sharing one login token). An OIDC-initiated logout terminating a
 * DIFFERENT session record than the one every other logout path already
 * uses would leave two parallel, inconsistent notions of "signed out" —
 * exactly what Phase 6c (`user_sessions` Integration, "Reuse existing
 * revoke behavior") explicitly starts from as its own premise. This file
 * reuses `revokeSessionByJti()`/`clearSessionCookie()` directly rather
 * than adding a second revocation code path for 6c to later reconcile.
 *
 * 6b-c, Token/Session Relationship: already correct, not new work here.
 * `lib/auth-utils.ts`'s `getUserFromToken()` already calls
 * `isSessionRevoked(ownToken.sid)` on every request (added when
 * `lib/sessions.ts` first shipped) — the moment `revokeSessionByJti()`
 * below sets `revoked_at`, every OTHER route in this codebase already
 * treats that `sid` as signed out on its very next request. Nothing in
 * this file needs to separately propagate that state anywhere.
 *
 * MOUNTING: bare origin, not under `/api` — an OIDC client (or a browser
 * navigating here directly per RP-Initiated Logout 1.0 §2) constructs
 * `${issuer}/oidc/logout` directly, the identical convention every other
 * `/oidc/*` route in this codebase already follows (see
 * routes/oidc-authorize.ts's own header). Not one of the routers combined
 * in routes/index.ts; mounted directly on the Express `app` (app.ts).
 *
 * RATE LIMITING: `authLimiter` — same choice `/oidc/authorize` already
 * made for the identical reason (file header there): this is a
 * user-facing, state-mutating authentication-adjacent entry point
 * (it revokes a session), reachable unauthenticated, not a static
 * metadata read like the two `well-known` routes.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { authLimiter } from "../middlewares/security";
import {
  parseOidcLogoutRequest,
  validateOidcLogoutRequest,
  type OidcLogoutRequestValidationResult,
} from "../lib/oidc-logout-request";
import { verifyIdTokenHint } from "../lib/oidc-id-token";
import { getOidcClientById } from "../lib/oidc-clients";
import { getTokenFromReq } from "../lib/auth-utils";
import { verifyAuthToken } from "../lib/jwt";
import { revokeSessionByJti } from "../lib/sessions";
import { clearSessionCookie } from "../lib/session-cookie";
// OIDC Roadmap — Season 3, Phase 6e-b (Sylo Integration): Phase 6d-a's own
// requirement #2 — an RP-initiated logout starting here must ALSO end
// Sylo's own local session, in the same action, not on the caller's next
// rejected API call. See dispatchBackchannelLogoutForUser()'s own header
// for why this call below is fire-and-forget.
import { dispatchBackchannelLogoutForUser } from "../lib/oidc-logout-propagation";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/** 6b-d: what a bare (no post_logout_redirect_uri) logout returns — mirrors POST /auth/logout's own response shape (routes/auth.ts) exactly, so a client that lands here without a redirect target sees a response in the same shape every other AYZEN sign-out already produces. */
const SIGNED_OUT_RESPONSE = { message: "Signed out" };

/**
 * 6a-e: turns a failing `OidcLogoutRequestValidationResult` into an HTTP
 * response. Exported separately from the route handler, same reasoning as
 * every other route in this roadmap (`respondToAuthorizeFailure()`,
 * `jwksHandler()`, ...) — unit-testable with a minimal `res` double.
 * Always a direct 400, never a redirect — see this file's own header and
 * lib/oidc-logout-request.ts's header for why.
 */
export function respondToLogoutFailure(
  res: Response,
  result: Extract<OidcLogoutRequestValidationResult, { ok: false }>,
): void {
  res.status(400).json({ error: result.error });
}

/**
 * The actual handler logic, exported separately from the router wiring —
 * same reasoning as `authorizeHandler()`/`openidConfigurationHandler()`:
 * unit-testable with a minimal req/res double instead of a live HTTP
 * server.
 */
export async function logoutHandler(req: Request, res: Response): Promise<void> {
  const raw = parseOidcLogoutRequest(req.query as Record<string, unknown>);

  const result = await validateOidcLogoutRequest(raw, verifyIdTokenHint, getOidcClientById);

  if (!result.ok) {
    logger.warn({ error: result.error }, "oidc.logout.denied");
    respondToLogoutFailure(res, result);
    return;
  }

  // 6b-a — Current Session Identification. See file header for why this
  // is the caller's own cookie/bearer session, not the id_token_hint's sub.
  const token = getTokenFromReq(req);

  // 6b-b — Session Invalidation. clearSessionCookie() runs unconditionally
  // — harmless for a caller with no cookie (e.g. a Bearer-token client
  // hitting this endpoint directly), same as POST /auth/logout.
  clearSessionCookie(res);
  if (token) {
    const decoded = verifyAuthToken(token);
    if (decoded?.sid) {
      await revokeSessionByJti(decoded.sid).catch(() => {});
      // 6e-b: this is exactly as true whether the caller making THIS
      // request already IS Sylo (revoking its own session first) — see
      // dispatchBackchannelLogoutForUser()'s own header for why looping
      // over every registered target unconditionally (rather than trying
      // to skip "the client that just called us") is the simpler, still-
      // correct choice: Sylo's own receiving endpoint finds nothing left
      // to revoke and is a harmless no-op in that case.
      if (decoded.userId) void dispatchBackchannelLogoutForUser(decoded.userId);
    }
  }

  // oidc.logout — section 5's observability event list.
  logger.info({ clientId: result.client?.clientId ?? null }, "oidc.logout");

  // 6b-d — Logout Completion.
  if (result.postLogoutRedirectUri) {
    const target = new URL(result.postLogoutRedirectUri);
    if (result.state) target.searchParams.set("state", result.state);
    res.redirect(302, target.toString());
    return;
  }

  res.json(SIGNED_OUT_RESPONSE);
}

router.get("/oidc/logout", authLimiter, logoutHandler);

export default router;
