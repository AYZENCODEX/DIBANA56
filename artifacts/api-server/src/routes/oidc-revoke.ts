/**
 * routes/oidc-revoke.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 5, Phase 10b: Revocation Endpoint (RFC
 * 7009-scoped-down): `POST /oidc/revoke`.
 *
 * Composes, in the same order `routes/oidc-introspect.ts` (10a) already
 * established for its own near-identical body shape:
 *
 *   parse (lib/oidc-revocation-request.ts)
 *     -> required-parameter check (`token` missing -> invalid_request)
 *     -> client authentication (lib/oidc-token-client-auth.ts, reused
 *        as-is — RFC 7009 §2.1's own client-auth requirement is the same
 *        RFC 6749 §3.2.1 confidential-client check RFC 7662 §2.1 already
 *        shares)
 *     -> revocation (lib/oidc-token-revocation.ts, this pass's own new
 *        mutating logic)
 *
 * WHY THIS ROUTE, LIKE 10a's, REUSES `OidcTokenErrorCode` RATHER THAN
 * INVENTING A NEW UNION — identical reasoning to `routes/oidc-introspect.ts`'s
 * own header: this endpoint only ever reaches `invalid_request` (no
 * `token` in the body) and `invalid_client`
 * (`authenticateOidcTokenClient()`'s own single failure mode), both
 * already exactly what RFC 7009 borrows from RFC 6749's error vocabulary
 * for the identical client-auth/malformed-request cases. Same
 * `respondTokenError()`-shape (400 + `{ error }`) reuse, for the same
 * "this provider never authenticates a client via the HTTP
 * `Authorization` header" reason.
 *
 * RFC 7009 §2.2 — WHY A REVOKED/UNRECOGNIZED/WRONG-AUDIENCE TOKEN IS
 * *NEVER* AN "ERROR" EITHER. Once client auth passes, this route ALWAYS
 * responds `200` with an EMPTY body — RFC 7009's own words: "the
 * authorization server responds with HTTP status code 200 if the token
 * has been revoked successfully OR IF THE CLIENT SUBMITTED AN INVALID
 * TOKEN." `lib/oidc-token-revocation.ts`'s own `revokeOidcToken()`
 * returns a richer `OidcRevocationOutcome` (`revoked`/`tokenType`) purely
 * for THIS file's own logging — none of it is ever put on the response
 * body, unlike 10a's introspect response (which DOES echo `active`/claims
 * back, because that endpoint's entire purpose is to answer a question;
 * this one's is only to perform an action).
 *
 * MOUNTING / RATE LIMITING: bare origin, `authLimiter` — identical
 * reasoning and identical tier to `routes/oidc-introspect.ts`'s own
 * header: a credential-bearing (`client_secret` in the body), token-
 * accepting POST is the same brute-forceable surface either way.
 *
 * Scope discipline (this is 10b, not 10c/10d/10e): see
 * `lib/oidc-token-revocation.ts`'s own header for the full list of what
 * this pass deliberately does not add (cascade-by-client's actual call
 * sites in 7d/9d, backchannel-logout hook, discovery metadata) — 10c's
 * OWN cascade functions ARE built in this pass, just not called from
 * here: this route only ever revokes the ONE token a caller named.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { authLimiter } from "../middlewares/security";
import { parseOidcRevocationRequest } from "../lib/oidc-revocation-request";
import { authenticateOidcTokenClient } from "../lib/oidc-token-client-auth";
import { revokeOidcToken } from "../lib/oidc-token-revocation";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * The actual handler logic, exported separately from the router wiring —
 * same "unit-testable with a minimal req/res double" reasoning every
 * earlier route in this roadmap already follows.
 */
export async function revokeHandler(req: Request, res: Response): Promise<void> {
  const raw = parseOidcRevocationRequest(req.body as Record<string, unknown>);

  // oidc.revoke.started — mirrors oidc.introspect.started's own reasoning:
  // logged before any validation so a malformed/attack request still
  // leaves a trail. clientId only, never `token`/`client_secret` —
  // section 5's "do not log ... access tokens" rule extends to refresh
  // tokens and client secrets here for the identical reason.
  logger.info({ clientId: raw.clientId }, "oidc.revoke.started");

  if (!raw.token) {
    logger.warn({ clientId: raw.clientId }, "oidc.revoke.failed");
    res.status(400).json({ error: "invalid_request" });
    return;
  }

  const clientAuth = await authenticateOidcTokenClient(raw.clientId, raw.clientSecret);
  if (!clientAuth.ok) {
    logger.warn({ clientId: raw.clientId }, "oidc.revoke.failed");
    res.status(400).json({ error: clientAuth.error });
    return;
  }

  const outcome = await revokeOidcToken(raw.token, raw.tokenTypeHint, clientAuth.client.clientId);

  logger.info(
    { clientId: clientAuth.client.clientId, revoked: outcome.revoked, tokenType: outcome.tokenType },
    "oidc.revoke.completed",
  );

  // RFC 7009 §2.2: 200, empty body, always, once client auth has passed —
  // see file header for why an invalid/unrecognized/already-revoked/
  // wrong-audience token is reported identically to a freshly-revoked one.
  res.status(200).end();
}

router.post("/oidc/revoke", authLimiter, revokeHandler);

export default router;
