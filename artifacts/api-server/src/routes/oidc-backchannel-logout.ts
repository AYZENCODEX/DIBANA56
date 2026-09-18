/**
 * routes/oidc-backchannel-logout.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 3, Phase 6e-b: Sylo Integration.
 *
 * `POST /oidc/backchannel-logout` — the exact URI
 * `scripts/src/seed-oidc-clients.ts` registers as Sylo's own
 * `backchannel_logout_uri` (`https://sylo.ayzen.tech/oidc/backchannel-logout`,
 * matching `scripts/src/test-oidc-logout-propagation.ts`'s own 6e-a test
 * fixture for that exact target). This is Sylo acting as the RP side of
 * OpenID Back-Channel Logout 1.0 §2.5/§2.6 — parse the form-encoded
 * `logout_token`, verify + act on it via
 * `lib/oidc-backchannel-logout-receive.ts`'s `handleInboundBackchannelLogout()`,
 * respond per §2.6's own status-code contract.
 *
 * MOUNTING: bare origin, not `/api`, same tier as every other `/oidc/*`
 * router (`routes/oidc-logout.ts`'s own header gives the identical
 * reasoning) — a Back-Channel Logout POST is server-to-server, addressed
 * directly at `${issuer}/oidc/backchannel-logout`, never routed through
 * any browser-facing surface. Per Phase 6d-c's own note, the SENDER of
 * this POST is, today, this exact same Express app
 * (`dispatchBackchannelLogoutForUser()`, `lib/oidc-logout-propagation.ts`)
 * — so in production this request never actually leaves the process —
 * but the route is written exactly as it would be for a genuinely
 * separate RP, since 6d-c's own Decision Record is explicit that this
 * model has to keep working once Ryft/Wisp/Verve/Zynth become real,
 * independently-deployed RPs (future scope, not this Season's).
 *
 * RATE LIMITING: `globalLimiter`, not `authLimiter` — same reasoning
 * `routes/oidc-client-errors.ts`'s own header gives for its own
 * unauthenticated beacon: this isn't a credential-guessing surface (no
 * password, no OTP, no session cookie is ever accepted or checked here),
 * and the REAL security boundary is `verifyLogoutToken()`'s RS256
 * signature check inside the handler, not a rate limit. `globalLimiter`
 * only bounds how much a caller who doesn't have a validly-signed token
 * can make this endpoint do (verify-and-reject, cheaply).
 *
 * RESPONSE CONTRACT (OpenID Back-Channel Logout 1.0 §2.6)
 *   - Valid token, logout processed: HTTP 200, empty body.
 *   - Invalid/missing token: HTTP 400, `{ error: "invalid_request" }` —
 *     §2.6 defines a `logout_token` error response in OAuth 2.0 Bearer
 *     Token Usage's `error`/`error_description` shape; this endpoint
 *     keeps the same flat `{ error }` shape every other `/oidc/*` route
 *     in this roadmap already uses (`routes/oidc-logout.ts`'s
 *     `respondToLogoutFailure()`) rather than introducing a new response
 *     shape for just this one route.
 *   - Never a redirect, never HTML — this is a machine-to-machine
 *     endpoint, no browser is ever on the other end of this request.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { globalLimiter } from "../middlewares/security";
import { handleInboundBackchannelLogout } from "../lib/oidc-backchannel-logout-receive";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * Exported separately from the router wiring — same reasoning as every
 * other handler in this roadmap (`logoutHandler`, `authorizeHandler`, …):
 * unit-testable with a minimal req/res double instead of a live HTTP
 * server + real RS256 keys wired through a live DB pool.
 */
export async function backchannelLogoutHandler(req: Request, res: Response): Promise<void> {
  const logoutToken = (req.body as Record<string, unknown> | undefined)?.logout_token;
  if (typeof logoutToken !== "string" || logoutToken.length === 0) {
    logger.warn({}, "oidc.backchannel_logout.received.missing_token");
    res.status(400).json({ error: "invalid_request" });
    return;
  }

  const result = await handleInboundBackchannelLogout(logoutToken);
  if (!result.ok) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }

  res.status(200).end();
}

router.post("/oidc/backchannel-logout", globalLimiter, backchannelLogoutHandler);

export default router;
