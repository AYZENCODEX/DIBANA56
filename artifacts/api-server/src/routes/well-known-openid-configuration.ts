/**
 * routes/well-known-openid-configuration.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 1, Phase 1E-e: `/.well-known/openid-configuration`.
 *
 * Serves the OIDC Discovery 1.0 metadata document that
 * lib/oidc-discovery.ts (1E-d) already knows how to build — this sub-phase
 * is deliberately "just" route wiring, exactly as 1E-d's own doc comment
 * predicted: "1E-e's endpoint is a route handler wiring this up, not new
 * metadata-assembly logic." Wires together:
 *   - getOidcDiscoveryMetadata()  (1E-d) — resolves the issuer from env and
 *     builds the { issuer, jwks_uri, ... } document;
 *   - jwks_uri inside that document already points at the endpoint 1E-c
 *     added in this same run, derived (not independently configured) so
 *     the two can never drift apart.
 *
 * Deliberately mounted OUTSIDE the `/api` prefix (see app.ts), for the
 * identical reason as routes/well-known-jwks.ts: OIDC/RFC 8414 well-known
 * endpoints are resolved by clients relative to the issuer's bare origin
 * (`https://<issuer>/.well-known/openid-configuration`), not under an
 * API-specific path prefix. Not one of the routers combined in
 * routes/index.ts; mounted directly on the Express `app` instead.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { getOidcDiscoveryMetadata } from "../lib/oidc-discovery";

const router: IRouter = Router();

// 1 hour: discovery metadata (issuer, supported scopes/response types/algs,
// jwks_uri) only changes on a code deploy — nothing in the request path
// mutates it the way key rotation (1D-d) mutates the JWKS response, so
// there's no rotation-visibility deadline forcing a short TTL the way
// JWKS_CACHE_CONTROL (1E-c) has one. Still not immutable/no-store: a
// well-behaved relying party is expected to poll this periodically per the
// OIDC spec, so some HTTP-level caching is appropriate — just longer than
// JWKS, since the underlying values change far less often.
const OPENID_CONFIGURATION_CACHE_CONTROL = "public, max-age=3600";

/**
 * The actual handler logic, exported separately from the router wiring so
 * it's unit-testable (scripts/src/test-openid-configuration-endpoint.ts)
 * with a minimal req/res double instead of needing a live HTTP server —
 * same reasoning, same shape, as well-known-jwks.ts's jwksHandler().
 */
export function openidConfigurationHandler(_req: Request, res: Response): void {
  // getOidcDiscoveryMetadata() (1E-d) is synchronous and total: it reads
  // env (with a hardcoded production-default fallback) and returns a
  // plain object built from constant arrays — there is nothing in this
  // call chain that can throw, same as jwksHandler()'s reasoning for
  // omitting a try/catch.
  const metadata = getOidcDiscoveryMetadata();
  res.set("Cache-Control", OPENID_CONFIGURATION_CACHE_CONTROL);
  // application/json — OIDC Discovery 1.0 §3 requires this exact media
  // type for the discovery response.
  res.type("application/json");
  res.json(metadata);
}

router.get("/.well-known/openid-configuration", openidConfigurationHandler);

export default router;
