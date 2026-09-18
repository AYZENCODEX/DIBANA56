/**
 * middlewares/api-key-scope.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Drop this at: artifacts/api-server/src/middlewares/api-key-scope.ts
 *
 * Mounted once, globally, in app.ts (before the main router). Every request
 * passes through it, but it only ever ACTS on requests authenticated with a
 * "scoped" AYZEN API key:
 *
 *  - No token, a session JWT, or a "full" API key → untouched, next().
 *  - A "scoped" API key → the request path must fall under one of the key's
 *    granted scopes (lib/api-scopes.ts), or it's rejected with 403 here,
 *    before it ever reaches a route handler.
 *
 * This is the ONLY place scope enforcement lives — no other route file needs
 * to know scoped keys exist. Session-authenticated requests (a user's own
 * login) are never restricted by this file; scoping only applies to keys the
 * user deliberately created as "scoped".
 */
import type { Request, Response, NextFunction } from "express";
import { getTokenFromReq, getUserFromToken } from "../lib/auth-utils";
import { looksLikeApiKey } from "../lib/api-key-crypto";
import { resolveScopeForPath, SCOPE_DEFINITIONS } from "../lib/api-scopes";

export async function apiKeyScopeGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = getTokenFromReq(req);
  if (!token || !looksLikeApiKey(token)) {
    next(); // not an API key request at all — session auth is handled downstream as usual
    return;
  }

  const user = await getUserFromToken(token);
  if (!user) {
    next(); // invalid/revoked key — let the route's own requireAuth produce the normal 401
    return;
  }

  if (user.keyType !== "scoped") {
    next(); // "full" key — no restriction
    return;
  }

  const requiredScope = resolveScopeForPath(req.path);
  const granted = user.scopes ?? [];

  if (!requiredScope || !granted.includes(requiredScope)) {
    res.status(403).json({
      error: "Forbidden",
      code: "SCOPE_NOT_GRANTED",
      solution: requiredScope
        ? `This API key doesn't have the "${requiredScope}" scope. Add it in your API key settings, or use a full-access key.`
        : "This endpoint isn't available to scoped API keys.",
      availableScopes: SCOPE_DEFINITIONS.map((s) => s.id),
    });
    return;
  }

  next();
}
