/**
 * lib/oidc-scope-enforcement.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 2, Phase 4d: Scope Enforcement Middleware.
 *
 * "Given a route that requires a client to hold a specific OIDC scope,
 * reject any request whose bearer access token doesn't carry it" — this
 * file's only job. Built on top of 4c-a/4c-b/4c-c
 * (`verifyOidcAccessToken()`, `lib/oidc-access-token-verification.ts`),
 * the same way `routes/oidc-userinfo.ts` (4c-f) already is — this is that
 * same "verify, then gate" shape, generalized into a reusable middleware
 * FACTORY instead of one route's inline handler logic.
 *
 * SCOPE DISCIPLINE (this is 4d-a/4d-b/4d-c/4d-d, not 4e)
 *   This file defines the enforcement PRIMITIVE — `requireOidcScope(scope)`
 *   — and nothing else. It does not:
 *     - decide WHICH of this codebase's existing resource routes should
 *       require an OIDC scope (4e-a, "Select Resource Routes");
 *     - call `router.get(...)`/`router.post(...)` anywhere, or mount
 *       itself in `app.ts`/`routes/index.ts` (4e-b, "Apply Middleware");
 *     - touch, audit, or regression-test any route that exists today
 *       (4e-c/4e-d). Every route in this codebase that isn't `/oidc/*`
 *       keeps authenticating exactly as it does now (`apiKeyScopeGate`,
 *       session cookies, `lib/auth-utils.ts`) — nothing here changes that.
 *   Building the rollout now would be implementing 4e ahead of 4e, which
 *   the roadmap's "no speculative implementation of future phases" rule
 *   (section 1.4) says not to do. A future pass wires this onto real
 *   routes; this pass only makes it exist, correctly, and tested on its
 *   own.
 *
 * 4D-A — SCOPE MODEL
 *   Deliberately just `string` (`RequiredOidcScope`), not a closed union
 *   of `KNOWN_OIDC_SCOPES` (`oidc-scope-validation.ts`, Phase 2d). That
 *   file's vocabulary governs what a CLIENT may request at
 *   `/oidc/authorize` time; this file governs what a RESOURCE ROUTE
 *   requires of an already-issued token, which is a per-route decision
 *   4e-a hasn't been made yet — narrowing the type now would force every
 *   future `requireOidcScope(...)` call to import a union this file has
 *   no opinion on maintaining.
 *
 * 4D-D — ERROR BEHAVIOR, RFC 6750 §3.1
 *   Same "one public shape, richer internal-only detail via logging"
 *   discipline `routes/oidc-userinfo.ts` (4c-f) already uses for its own
 *   `WWW-Authenticate: Bearer ...` responses, extended with the one case
 *   that file never needed: a token that verifies FINE but doesn't carry
 *   the scope this particular route requires. RFC 6750 §3.1 names that
 *   exact case `insufficient_scope` and — unlike every other bearer-token
 *   failure, which is `401` — calls for `403`, optionally naming the
 *   missing scope on the challenge itself (`scope="..."`). This file does
 *   both: `401 invalid_request` (no token presented at all), `401
 *   invalid_token` (token verification itself failed — reusing
 *   4c-a/4c-b/4c-c's own `OidcAccessTokenVerificationResult` failure,
 *   collapsed the identical way `routes/oidc-userinfo.ts` already
 *   collapses it), `403 insufficient_scope` (verified token, missing
 *   scope) — three outcomes, never a fourth ad hoc shape.
 */
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { verifyOidcAccessToken, type VerifiedOidcAccessToken } from "./oidc-access-token-verification";
import { hashOidcAccessToken, isAccessTokenRevoked } from "./oidc-token-revocation";
import { logger } from "./logger";

/** 4d-a: Scope Model. See file header for why this is deliberately just `string`, not a closed union — the closed vocabulary a *request* may ask for (`KNOWN_OIDC_SCOPES`, Phase 2d) is a different concern from what a *route* requires of a token it already holds. */
export type RequiredOidcScope = string;

/**
 * `Authorization: Bearer <token>` extraction — identical shape to
 * `routes/oidc-userinfo.ts`'s own `extractBearerToken()` (4c-f),
 * deliberately duplicated rather than imported: this file has no route
 * layer of its own to share one with, and the alternative (a shared
 * header-parsing module two files each import one function from) is more
 * indirection than a five-line, unlikely-to-drift regex justifies — the
 * same small-duplication tradeoff `oidc-access-token-verification.ts`'s
 * own `decodeHeader()` already took against `lib/jwt.ts`.
 */
function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1] : null;
}

/** RFC 6750 §3.1 — no `Authorization` header at all, or a token that failed 4c-a/4c-b/4c-c verification. Same two-value distinction (and same reasoning for keeping it a two-value distinction) `routes/oidc-userinfo.ts`'s own `respondUnauthorized()` already established. */
function respondUnauthorized(res: Response, error: "invalid_request" | "invalid_token"): void {
  res.setHeader("WWW-Authenticate", `Bearer error="${error}"`);
  res.status(401).json({ error });
}

/** 4d-d: RFC 6750 §3.1's `insufficient_scope` — a token that verified fine but doesn't carry `requiredScope`. `403`, not `401`: the bearer proved who it is, it simply isn't allowed to do this. The challenge names the missing scope, per spec, so a well-behaved client can tell exactly what to re-request at `/oidc/authorize`. */
function respondInsufficientScope(res: Response, requiredScope: RequiredOidcScope): void {
  res.setHeader("WWW-Authenticate", `Bearer error="insufficient_scope", scope="${requiredScope}"`);
  res.status(403).json({ error: "insufficient_scope" });
}

/**
 * 4d-c: Required-Scope Check — pure, no Express, no I/O. Factored out of
 * the middleware below so it (and the "does this token satisfy this
 * route" rule) is unit-testable on its own, the same "pure predicate,
 * separate from the route/middleware that enforces it" split
 * `isAuthorizationCodeExpired()` (`oidc-authorization-codes.ts`, 3b-g)
 * already established for its own enforcement rule.
 */
export function hasRequiredScope(grantedScopes: string[], requiredScope: RequiredOidcScope): boolean {
  return grantedScopes.includes(requiredScope);
}

/**
 * Augments `req` with the verified token, for a handler downstream of this
 * middleware that wants `userId`/`clientId`/`scopes` without re-verifying —
 * same "attach what was already resolved, for handlers further down the
 * chain" shape `apiKeyScopeGate` (`middlewares/api-key-scope.ts`) already
 * uses via `getUserFromToken()`'s return value.
 */
export interface RequestWithOidcToken extends Request {
  oidcToken?: VerifiedOidcAccessToken;
}

/**
 * 4d-b/4d-c: the middleware FACTORY. `requireOidcScope("profile")` returns
 * an Express middleware that:
 *   1. extracts a Bearer token (RFC 6750 §2.1) — missing entirely ->
 *      `401 invalid_request`;
 *   2. verifies it (4c-a/4c-b/4c-c) — fails -> `401 invalid_token`;
 *   3. checks `requiredScope` against the token's granted scopes (4d-c) —
 *      missing -> `403 insufficient_scope`;
 *   4. otherwise attaches the verified token to `req.oidcToken` and calls
 *      `next()`.
 *
 * Not itself mounted on any route — see file header (4e's job).
 *
 * UPDATE — Season 5, Phase 10b: a cryptographically-valid access token can
 * have been explicitly killed via `POST /oidc/revoke` since it was
 * minted; without this check, a scope-gated route would keep accepting a
 * token 10b's own endpoint just revoked, exactly the "cosmetic
 * revocation" gap this roadmap's own Phase 9d/7d notes already criticize
 * elsewhere. Composed as a separate step AFTER `verifyOidcAccessToken()`
 * (unchanged), never folded into it — same "pure predicate, separate
 * effectful I/O" split `lib/oidc-token-revocation.ts`'s own header
 * documents, and the same wiring `routes/oidc-userinfo.ts` and
 * `lib/oidc-token-introspection.ts` already use as this Season's other
 * two composed callers. This is what makes the returned middleware
 * `async` where it previously wasn't — the one shape change this update
 * makes to the factory below.
 */
export function requireOidcScope(requiredScope: RequiredOidcScope): RequestHandler {
  return async (req: RequestWithOidcToken, res: Response, next: NextFunction): Promise<void> => {
    const rawToken = extractBearerToken(req);
    if (!rawToken) {
      respondUnauthorized(res, "invalid_request");
      return;
    }

    const verified = verifyOidcAccessToken(rawToken);
    if (!verified.ok) {
      logger.warn({ reason: verified.reason, requiredScope }, "oidc.scope_enforcement.failed");
      respondUnauthorized(res, "invalid_token");
      return;
    }

    if (await isAccessTokenRevoked(hashOidcAccessToken(rawToken))) {
      logger.warn(
        { userId: verified.token.userId, clientId: verified.token.clientId, requiredScope },
        "oidc.scope_enforcement.failed",
      );
      respondUnauthorized(res, "invalid_token");
      return;
    }

    if (!hasRequiredScope(verified.token.scopes, requiredScope)) {
      logger.warn(
        { userId: verified.token.userId, clientId: verified.token.clientId, requiredScope },
        "oidc.scope_enforcement.insufficient_scope",
      );
      respondInsufficientScope(res, requiredScope);
      return;
    }

    req.oidcToken = verified.token;
    next();
  };
}
