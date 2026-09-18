/**
 * routes/oidc-introspect.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 5, Phase 10a: Introspection Endpoint (RFC
 * 7662-scoped-down): `POST /oidc/introspect`.
 *
 * Composes, in the order RFC 7662 §2.1 and this file's own lib pair
 * imply:
 *
 *   parse (lib/oidc-introspection-request.ts)
 *     -> required-parameter check (`token` missing -> invalid_request,
 *        the one 10a-reachable member of 3c-g's existing error union —
 *        see below for why no NEW error-code union was invented for this
 *        route)
 *     -> client authentication (lib/oidc-token-client-auth.ts, Phase
 *        3c-b, reused as-is — RFC 7662 §2.1's own client-auth requirement
 *        is textually identical to RFC 6749 §3.2.1's, which that file
 *        already implements; a second, parallel client-auth
 *        implementation here would be two ways to answer the same
 *        question)
 *     -> introspection (lib/oidc-token-introspection.ts, this pass's own
 *        new lookup/classification logic)
 *
 * WHY THIS ROUTE REUSES `OidcTokenErrorCode` (`lib/oidc-token-request.ts`)
 * RATHER THAN INVENTING A NEW UNION
 * This endpoint only ever reaches two of that union's members —
 * `invalid_request` (no `token` in the body) and `invalid_client`
 * (`authenticateOidcTokenClient()`'s own single failure mode) — both
 * already exactly what RFC 7662 itself expects a client-auth or malformed
 * -request failure to look like (it borrows RFC 6749's error vocabulary
 * for exactly this case). Introducing a THIRD error-code type into this
 * codebase for a strict subset of a union that already exists would be
 * new vocabulary with no new meaning; `routes/oidc-token.ts`'s own
 * `respondTokenError()` shape (400 + `{ error }`) is reused verbatim
 * below for the identical reason that file already gives for picking 400
 * over RFC 6749 §5.2's literal 401 (this provider never authenticates a
 * client via the HTTP `Authorization` header, only the POST body).
 *
 * A TOKEN THAT ISN'T ACTIVE IS NEVER AN "ERROR" — RFC 7662 §2.2
 * Once client auth passes, this route ALWAYS responds `200` — an
 * unrecognized, expired, revoked, or wrong-audience token is
 * `{ active: false }`, not a 4xx of any kind. This is RFC 7662's own
 * explicit design (§2.2: "the authorization server MUST NOT include ...
 * fields ... unless its value is `\"true\"`" — the implication being
 * `active: false` alone is itself a complete, successful response), not
 * a scope-narrowing choice this pass made. `lib/oidc-token-introspection.ts`'s
 * own header covers why a wrong-audience token collapses into this exact
 * same shape rather than a distinguishable error.
 *
 * MOUNTING / RATE LIMITING: bare origin (not `/api`, not behind
 * `apiKeyScopeGate`) and `authLimiter` — identical reasoning to
 * `routes/oidc-token.ts`'s own header: an OIDC client's backend (or, for
 * this endpoint, a resource server checking a token before serving a
 * request) calls this URL directly against the issuer's origin, and a
 * credential-bearing (`client_secret` in the body), token-accepting POST
 * endpoint is exactly the brute-forceable surface `authLimiter` — not the
 * generous `globalLimiter` `routes/oidc-resource.ts` uses for its own
 * bearer-only reads — exists for.
 *
 * Scope discipline (this is 10a, not 10b/10c/10d/10e): see
 * `lib/oidc-token-introspection.ts`'s own header for the full list of
 * what this pass deliberately does not add (`POST /oidc/revoke`, cascade
 * revocation, backchannel-logout hook, discovery metadata).
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { authLimiter } from "../middlewares/security";
import { parseOidcIntrospectionRequest } from "../lib/oidc-introspection-request";
import { authenticateOidcTokenClient } from "../lib/oidc-token-client-auth";
import { introspectOidcToken } from "../lib/oidc-token-introspection";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * The actual handler logic, exported separately from the router wiring —
 * same "unit-testable with a minimal req/res double" reasoning every
 * earlier route in this roadmap already follows (`tokenHandler`,
 * `authorizeHandler`, ...).
 */
export async function introspectHandler(req: Request, res: Response): Promise<void> {
  const raw = parseOidcIntrospectionRequest(req.body as Record<string, unknown>);

  // oidc.introspect.started — mirrors oidc.token.started's own reasoning:
  // logged before any validation so a malformed/attack request still
  // leaves a trail. clientId only, never `token`/`client_secret` —
  // section 5's "do not log ... access tokens" rule extends to refresh
  // tokens and client secrets here for the identical reason.
  logger.info({ clientId: raw.clientId }, "oidc.introspect.started");

  if (!raw.token) {
    logger.warn({ clientId: raw.clientId }, "oidc.introspect.failed");
    res.status(400).json({ error: "invalid_request" });
    return;
  }

  const clientAuth = await authenticateOidcTokenClient(raw.clientId, raw.clientSecret);
  if (!clientAuth.ok) {
    logger.warn({ clientId: raw.clientId }, "oidc.introspect.failed");
    res.status(400).json({ error: clientAuth.error });
    return;
  }

  const result = await introspectOidcToken(raw.token, raw.tokenTypeHint, clientAuth.client.clientId);

  logger.info({ clientId: clientAuth.client.clientId, active: result.active }, "oidc.introspect.completed");

  res.status(200).json(result);
}

router.post("/oidc/introspect", authLimiter, introspectHandler);

export default router;
