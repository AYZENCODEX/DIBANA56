/**
 * routes/well-known-jwks.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 1, Phase 1E-c: `/.well-known/jwks.json`.
 *
 * Serves the JWKS (JSON Web Key Set) AYZEN's OIDC clients (and any RS256
 * JWT verifier) need to validate tokens signed by lib/jwt.ts, WITHOUT ever
 * exposing the private signing key. Wires together:
 *   - resolveVerificationKeys() (1D-b) — the same sync, cached,
 *     rotation-aware key source verifyAuthToken()/verifyOAuthState()
 *     (lib/jwt.ts) already use on their hot path;
 *   - buildJwks()               (1E-b) — VerificationKey[] → { keys: [...] }.
 *
 * Deliberately mounted OUTSIDE the `/api` prefix (see app.ts) — OIDC/RFC
 * 8414 well-known endpoints are resolved by clients relative to the
 * issuer's bare origin (`https://<issuer>/.well-known/jwks.json`), not
 * under an API-specific path prefix. This file is therefore NOT one of the
 * routers combined in routes/index.ts (all of those live under `/api`); it
 * is mounted directly on the Express `app` instead — see app.ts.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { resolveVerificationKeys, buildJwks } from "../lib/jwt-keys";

const router: IRouter = Router();

// 5 minutes: short enough that a rotation (1D-d) is visible to any
// HTTP-caching client/CDN in front of this endpoint well within the 7-day
// token lifetime + grace-period retention window (1D-e) that keeps the old
// key verifiable in the meantime — so a short cache here trades a small
// amount of redundant computation for never being the reason a client
// misses a rotation. Not zero/no-store: this endpoint is meant to be
// polled periodically by every relying party, and resolveVerificationKeys()
// is already an in-memory cache underneath (1D-b) — a few minutes of HTTP
// caching on top just saves the round trip for well-behaved clients.
const JWKS_CACHE_CONTROL = "public, max-age=300";

/**
 * The actual handler logic, exported separately from the router wiring so
 * it's unit-testable (scripts/src/test-jwks-endpoint.ts) with a minimal
 * req/res double instead of needing a live HTTP server — same reasoning
 * as jwt-keys.ts's pure functions being factored out for DB-free testing.
 */
export function jwksHandler(_req: Request, res: Response): void {
  // resolveVerificationKeys() (1D-b) is synchronous and, by design, never
  // throws — an empty/DB-unavailable case degrades to the single
  // env-resolved active keypair (or, in the pre-cache-load window, exactly
  // that same fallback). buildJwks() (1E-b) is likewise total: empty input
  // -> { keys: [] }, and a single malformed key is skipped rather than
  // failing the whole response. There is deliberately no try/catch here —
  // there is nothing in this call chain that raises.
  const keys = resolveVerificationKeys();
  const jwks = buildJwks(keys);
  res.set("Cache-Control", JWKS_CACHE_CONTROL);
  // application/json (not a JWK-specific media type) matches what every
  // major OIDC provider (Google, Microsoft, Okta, Auth0) actually serves
  // jwks_uri as in practice, and is what res.json() sets by default — kept
  // explicit here so the choice is documented rather than incidental.
  res.type("application/json");
  res.json(jwks);
}

router.get("/.well-known/jwks.json", jwksHandler);

export default router;
