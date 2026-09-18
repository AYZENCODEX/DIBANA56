/**
 * routes/oidc-connected-apps.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 4, Phase 7d: Consent Revocation (route half), now
 * actually built out — Season 5, Phase 10d: Cascade Call-Site Wiring.
 *
 * `GET /oidc/connected-apps` — the Security page's "Connected Apps"
 * section: every client `req.user` currently has an ACTIVE consent for
 * (`listActiveConsentsForUser()`, `lib/oidc-user-consents.ts`, 7d), joined
 * against `oidc_clients` for a display name a raw `client_id` alone
 * wouldn't give the user. `client_secret_hash` /
 * `registration_access_token_hash` are never read here at all (this
 * handler only asks `getOidcClientById()` for `clientName`) — no risk of
 * either leaking through this surface.
 *
 * `POST /oidc/connected-apps/:clientId/revoke` — the Disconnect button.
 * Composes, in order:
 *   1. `revokeConsent(userId, clientId)` (`lib/oidc-user-consents.ts`, 7a/7d)
 *      — the soft-revoke write. Returns `false` when there was no active
 *      consent to revoke (never asked, or already revoked) — this route
 *      still responds `204` either way (RFC-adjacent "revoking something
 *      already gone is not an error" posture this whole OIDC family uses
 *      for `POST /oidc/revoke` itself, 10b) but skips steps 2/3 entirely
 *      when there was nothing real to cascade from.
 *   2. `revokeAllTokensForClientAndUser(userId, clientId)`
 *      (`lib/oidc-token-revocation.ts`, 10c) — this pass's own real
 *      implementation of the exact function `lib/oidc-user-consents.ts`'s
 *      own 7d header already named as "not yet built." Every still-live
 *      refresh token this user holds for this client stops being
 *      redeemable immediately; any access token already in hand keeps
 *      verifying for at most its own remaining 60-minute TTL (documented
 *      scope boundary, see that file's own header).
 *   3. `void dispatchBackchannelLogoutForUserAndClient(userId, clientId)`
 *      (`lib/oidc-logout-propagation.ts`, 10d) — notifies the ONE client
 *      just disconnected (not every other client this user is still
 *      logged into) that this session is over, so a well-behaved RP can
 *      end its own local session immediately rather than waiting on the
 *      access token's natural expiry. `void`-called, never awaited inline
 *      — same "propagation must never block or fail an already-succeeded
 *      response" contract every other backchannel dispatch call site in
 *      this codebase already follows.
 *
 * AUTH: `requireAuth` on both routes — same tier `routes/oidc-consent.ts`
 * (7b) already uses, for the identical reason: this is a page shown
 * "after login," never called by an anonymous visitor or an OIDC client
 * itself. `req.user!.userId` is the only identity either handler trusts,
 * never a client-supplied user id — a user can only ever list or revoke
 * their OWN connected apps.
 *
 * MOUNTING / RATE LIMITING: bare origin (not `/api`, not behind
 * `apiKeyScopeGate`) — same convention every `/oidc/*` router in this
 * codebase already uses. `globalLimiter`, not `authLimiter`: this is a
 * cookie-authenticated, already-logged-in user managing their own
 * account, not a credential-guessing surface the way `/oidc/token` or
 * `/oidc/consent/allow` (accepting a client-supplied authorization
 * artifact) are — the same reasoning `routes/oidc-userinfo.ts`'s own
 * header gives for choosing `globalLimiter` over `authLimiter`.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { globalLimiter } from "../middlewares/security";
import { requireAuth } from "../middlewares/auth";
import { listActiveConsentsForUser, revokeConsent } from "../lib/oidc-user-consents";
import { getOidcClientById } from "../lib/oidc-clients";
import { revokeAllTokensForClientAndUser } from "../lib/oidc-token-revocation";
import { dispatchBackchannelLogoutForUserAndClient } from "../lib/oidc-logout-propagation";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ── GET /oidc/connected-apps — 7d: list this user's active consents ───────
router.get("/oidc/connected-apps", globalLimiter, requireAuth, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.userId;

  const consents = await listActiveConsentsForUser(userId);

  const apps = await Promise.all(
    consents.map(async (consent) => {
      const client = await getOidcClientById(consent.clientId);
      return {
        clientId: consent.clientId,
        // Falls back to the raw client_id for any client with no
        // clientName on file — see lib/oidc-clients.ts's own doc comment
        // on OidcClient.clientName for why this is expected, not a bug.
        clientName: client?.clientName ?? consent.clientId,
        grantedScopes: consent.grantedScopes,
        grantedAt: consent.grantedAt.toISOString(),
      };
    }),
  );

  res.json({ apps });
});

// ── POST /oidc/connected-apps/:clientId/revoke — 7d + 10c + 10d: disconnect ─
router.post(
  "/oidc/connected-apps/:clientId/revoke",
  globalLimiter,
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.userId;
    const clientId = String(req.params.clientId ?? "").trim();
    if (!clientId) {
      res.status(400).json({ error: "clientId is required" });
      return;
    }

    const revokedConsent = await revokeConsent(userId, clientId);
    if (!revokedConsent) {
      // Nothing active to revoke (never granted, or already revoked) —
      // same "still a successful no-op, nothing left to cascade from"
      // posture POST /oidc/revoke (10b) already takes for an
      // already-dead/unrecognized token.
      res.status(204).end();
      return;
    }

    const revokedTokenCount = await revokeAllTokensForClientAndUser(userId, clientId);

    logger.info(
      { userId, clientId, revokedTokenCount },
      "oidc.connected_apps.revoked",
    );

    // 10d: notify the one disconnected client — never blocks/fails this
    // response, see file header.
    void dispatchBackchannelLogoutForUserAndClient(userId, clientId);

    res.status(204).end();
  },
);

export default router;
