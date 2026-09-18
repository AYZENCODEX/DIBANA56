/**
 * routes/oidc-resource.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 2, Phase 4e: Middleware Rollout.
 *
 * 4E-A — SELECT RESOURCE ROUTES
 *   `requireOidcScope()` (Phase 4d, `lib/oidc-scope-enforcement.ts`) was
 *   built and unit-tested but never mounted anywhere — that file's own
 *   header explicitly reserved "which of this codebase's existing
 *   resource routes should require an OIDC scope" for 4e-a. Having gone
 *   to select one: NONE of this codebase's existing `/api/*` routes are
 *   an appropriate candidate for THIS pass. Every one of them is still
 *   authenticated the way Season 1/2's own architecture note says they
 *   are (`getTokenFromReq()`'s session-cookie/legacy-API-key path,
 *   `apiKeyScopeGate`) — Sylo (or any other first-party app) does not yet
 *   send an OIDC bearer token for its OWN resource calls; that only
 *   starts at Phase 5 (Sylo OIDC Migration, Season 3), which has not
 *   begun. Retrofitting `requireOidcScope()` onto a live, currently
 *   session-authenticated `/api/*` route now — before any client
 *   actually holds an OIDC access token to call it with — would lock
 *   real users out of a route that works today, which is exactly the
 *   "preserve existing routes, handlers, services" / "no speculative
 *   implementation of future phases" boundary section 1.3/1.4 exist to
 *   prevent.
 *
 *   What IS selected: a small, purpose-built OIDC resource-server surface,
 *   mounted the same bare-origin way `/oidc/userinfo` (4c-f) already is —
 *   `GET /oidc/resource/profile` and `GET /oidc/resource/email`, one per
 *   non-`openid` scope this provider currently defines semantics for
 *   (`KNOWN_OIDC_SCOPES`, Phase 2d: `openid`/`profile`/`email` — `openid`
 *   itself never gates a *resource*, it's the scope that makes a token an
 *   OIDC token at all). This is the "Scope-Enforced Resource" step the
 *   Season 2 exit criteria's flow chart names, and it's genuinely new
 *   surface (nothing existing changes behavior), not a redesign of
 *   anything — see 4e-c below for the regression check that confirms
 *   that. It is deliberately minimal: two GET endpoints, no business
 *   logic beyond "prove the bearer token carries the required scope, then
 *   echo back what it verified to" — the reference shape a real Phase 5
 *   resource route will follow once one actually needs to exist.
 *
 * 4E-B — APPLY MIDDLEWARE
 *   `requireOidcScope("profile")` / `requireOidcScope("email")` applied
 *   directly as Express route middleware below — exactly the factory
 *   `lib/oidc-scope-enforcement.ts` already built for this, used for the
 *   first time.
 *
 * 4E-C — REGRESSION CHECKS
 *   See `CHANGES_OIDC_MIDDLEWARE_ROLLOUT_PHASE4E.md` for the full
 *   checklist this pass ran. Summary: this file is new; `app.ts`'s only
 *   change is one more `app.use(oidcResourceRouter)` line, positioned
 *   with the other bare-origin OIDC routers, strictly before `/api`'s
 *   `apiKeyScopeGate`/`router` mount — so nothing under `/api/*` changed,
 *   and no other route file was touched.
 */
import { Router, type IRouter, type Response } from "express";
import { globalLimiter } from "../middlewares/security";
import { requireOidcScope, type RequestWithOidcToken } from "../lib/oidc-scope-enforcement";

const router: IRouter = Router();

/**
 * Both handlers share this shape: `requireOidcScope()` has already done
 * every authentication/authorization decision by the time either of these
 * runs (missing token, invalid token, and missing scope are all handled —
 * and responded to — inside the middleware itself, per 4d-d). A handler
 * downstream of it only ever runs for a request that's already cleared,
 * so it has nothing left to check.
 */
function respondWithVerifiedToken(req: RequestWithOidcToken, res: Response): void {
  // req.oidcToken is always set here — requireOidcScope() guarantees it
  // (see lib/oidc-scope-enforcement.ts) before calling next().
  const token = req.oidcToken!;
  res.status(200).json({
    sub: String(token.userId),
    client_id: token.clientId,
    scopes: token.scopes,
  });
}

router.get("/oidc/resource/profile", globalLimiter, requireOidcScope("profile"), respondWithVerifiedToken);
router.get("/oidc/resource/email", globalLimiter, requireOidcScope("email"), respondWithVerifiedToken);

export default router;
