/**
 * routes/oidc-rollout-flag.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 3, Phase 5c-a: `GET /oidc/rollout-flags/:appId`.
 *
 * The public half of the rollout flag — `sylo-oidc-rollout-flag.ts`'s own
 * header names this file exactly: "Reads the public
 * `/oidc/rollout-flags/:appId` endpoint ... so App.tsx's ProtectedRoute
 * (5c-c) and login.tsx (5d-c) can decide, BEFORE any session exists,
 * whether to start `startSyloOidcLogin()` or fall through to the old
 * credential-form `/login` page." "Before any session exists" is why this
 * is public, not `requireAuth`-gated the way most of this codebase's
 * feature-flag-shaped reads would be: a logged-out visitor hitting an
 * in-scope subdomain for the first time is exactly who needs this answer,
 * and they have no token yet to authenticate the read with.
 *
 * MOUNTING: bare origin (not `/api`, not behind `apiKeyScopeGate`) — same
 * convention every other `/oidc/*` router in this roadmap already
 * establishes (see `routes/oidc-authorize.ts`/`oidc-token.ts`/
 * `oidc-userinfo.ts`/`oidc-resource.ts`'s own "MOUNTING" notes), for the
 * identical reason: the frontend builds this URL directly against
 * `resolveSyloOidcIssuer()`'s resolved origin
 * (`sylo-oidc-rollout-flag.ts`), not through `/api`.
 *
 * RATE LIMITING: `globalLimiter`, not `authLimiter` — this is a read of a
 * boolean an operator controls, not a credential-guessing surface (the
 * same distinction `oidc-userinfo.ts`'s own header draws between itself
 * and `/oidc/token`).
 *
 * RESPONSE SHAPE: `{ appId, oidcEnabled }` — deliberately the exact two
 * fields `sylo-oidc-rollout-flag.ts`'s `getSyloOidcRolloutFlag()` already
 * reads (`typeof data?.oidcEnabled === "boolean"`); no extra fields, no
 * error detail on failure (see below) that a caller could branch on and
 * accidentally treat as "half enabled".
 *
 * FAILURE SHAPE: even an unexpected error here still resolves to
 * `{ appId, oidcEnabled: false }` with a `200`, not a `4xx/5xx` — a
 * non-2xx response is treated as "fail safe to false" by the frontend
 * reader too (see that file's own fail-safe branch), so returning an
 * error status here would still land on the same safe answer, but a `200`
 * with the flag's own shape means a caller who (incorrectly) skipped the
 * status check still gets the safe value instead of `undefined`.
 *
 * SCOPE DISCIPLINE (this is 5c-a, not 5c-b/5c-c/5c-d/5c-e or 5d)
 *   - Read-only. The write side is `routes/admin-oidc-rollout.ts`'s PATCH,
 *     `requireDev`-gated, never this router.
 *   - Delegates every fail-safe/caching decision to
 *     `lib/oidc-client-rollout.ts`'s `getOidcRolloutFlag()` — this file is
 *     HTTP plumbing only.
 */
import { Router, type IRouter } from "express";
import { globalLimiter } from "../middlewares/security";
import { getOidcRolloutFlag } from "../lib/oidc-client-rollout";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.get("/oidc/rollout-flags/:appId", globalLimiter, async (req, res): Promise<void> => {
  const appId = String(req.params.appId ?? "").trim().toLowerCase();
  if (!appId) {
    res.status(200).json({ appId: "", oidcEnabled: false });
    return;
  }

  let oidcEnabled = false;
  try {
    oidcEnabled = await getOidcRolloutFlag(appId);
  } catch (err) {
    // getOidcRolloutFlag() itself already fails safe internally — this
    // catch is belt-and-suspenders against anything unexpected in the
    // route layer above it (see file header's FAILURE SHAPE note).
    logger.warn({ appId, err }, "oidc.rollout_flag.route_failed");
    oidcEnabled = false;
  }

  res.status(200).json({ appId, oidcEnabled });
});

export default router;
