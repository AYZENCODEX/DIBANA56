/**
 * routes/admin-oidc-rollout.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 3, Phase 5c-c (admin write half) / 5c-d (comparison
 * monitoring) / 5c-e + 5e-d (rollback) / 5d-b (cutover) / 5e-c (alert
 * thresholds, surfaced in the GET response's `health` field below).
 *
 * The admin-API twin of `scripts/src/set-oidc-rollout-flag.ts` — that
 * script's own header says it plainly: "routes/admin-oidc-rollout.ts's
 * PATCH endpoint is the same mechanism reached through the admin API
 * instead of a CLI — pick whichever is convenient; both call the
 * identical `lib/oidc-client-rollout.ts` helper." This file is that other
 * half, plus the read-side `GET` the CLI script has no equivalent of (an
 * admin UI needs to SHOW the current state and recent health, not just
 * flip it blind).
 *
 * SAFETY MODEL — deliberately the exact same one, reimplemented here
 * rather than imported, because a shared "is this app_id allowed" helper
 * would need to live in a module BOTH `scripts/src/set-oidc-rollout-flag.ts`
 * (a `tsx`-run CLI script with no Express types in scope) and this route
 * (an Express handler) could import cleanly without either one dragging
 * in the other's runtime assumptions — small enough logic that
 * duplicating the one `if` is less risk than a new shared module two very
 * different call sites both have to agree to import correctly. See that
 * script's own header for the full "why Sylo only, why an explicit
 * override exists" reasoning; `ALLOWED_WITHOUT_OVERRIDE` below is that
 * same boundary.
 *
 * MOUNTING: through `routes/index.ts` at `/api/admin/oidc-rollout/*` — the
 * same tier as `routes/config.ts`'s `/api/admin/config/*` (also
 * `requireDev`-gated, also mounted through this same aggregator) — NOT
 * bare-origin like `oidc-rollout-flag.ts`'s public GET. This is an
 * internal admin surface, not something an OIDC client or a logged-out
 * visitor ever calls.
 */
import { Router, type IRouter } from "express";
import { requireDev } from "../middlewares/auth";
import { getOidcRolloutFlag, setOidcRolloutFlag } from "../lib/oidc-client-rollout";
import {
  getOidcLoginAttemptStats,
  DEFAULT_STATS_WINDOW_MS,
  evaluateOidcRolloutHealth,
} from "../lib/oidc-login-attempts";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * Season 3 only migrates Sylo (roadmap section 1.3's own execution
 * boundary) — identical to `set-oidc-rollout-flag.ts`'s
 * `args.app !== "sylo"` guard, see file header for why this is
 * duplicated rather than shared.
 */
const ALLOWED_WITHOUT_OVERRIDE = new Set(["sylo"]);

// ── GET /admin/oidc-rollout/:appId — current flag + 5c-d/5e comparison stats ──
router.get("/admin/oidc-rollout/:appId", requireDev, async (req, res): Promise<void> => {
  const appId = String(req.params.appId ?? "").trim().toLowerCase();
  if (!appId) { res.status(400).json({ error: "appId is required" }); return; }

  const windowMs = (() => {
    const raw = Number(req.query.windowMs);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STATS_WINDOW_MS;
  })();

  const [oidcEnabled, stats, health] = await Promise.all([
    getOidcRolloutFlag(appId),
    Promise.resolve(getOidcLoginAttemptStats(appId, windowMs)),
    // Season 3, Phase 5e-c (additive): "define actionable thresholds" —
    // evaluated fresh on every read against the same window, never
    // stored, never acted on by this route itself. See
    // evaluateOidcRolloutHealth()'s own header for the exact thresholds
    // and why crossing one does not, by itself, do anything but show up
    // here — 5c-e/5e-d's PATCH below (or set-oidc-rollout-flag.ts
    // --disable) remains the only thing that actually rolls back.
    Promise.resolve(evaluateOidcRolloutHealth(appId, windowMs)),
  ]);

  res.json({ appId, oidcEnabled, stats, health });
});

// ── PATCH /admin/oidc-rollout/:appId — 5c-c/5c-e/5d-b/5e-d: flip the flag ────
router.patch("/admin/oidc-rollout/:appId", requireDev, async (req, res): Promise<void> => {
  const appId = String(req.params.appId ?? "").trim().toLowerCase();
  if (!appId) { res.status(400).json({ error: "appId is required" }); return; }

  const { enabled, allowNonSylo } = req.body as { enabled?: unknown; allowNonSylo?: unknown };
  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: "enabled (boolean) is required" });
    return;
  }

  if (!ALLOWED_WITHOUT_OVERRIDE.has(appId) && allowNonSylo !== true) {
    res.status(403).json({
      error: "Refusing to touch this app_id",
      code: "NON_SYLO_APP_ID",
      solution:
        `Season 3 only migrates Sylo. Pass { "allowNonSylo": true } once "${appId}" has its own OIDC client wiring (Phase 5a/5b equivalent).`,
    });
    return;
  }

  const before = await getOidcRolloutFlag(appId);
  await setOidcRolloutFlag(appId, enabled);

  logger.info(
    { appId, from: before, to: enabled, actorId: req.user?.userId },
    "oidc.rollout_flag.admin_updated",
  );

  res.json({ appId, oidcEnabled: enabled });
});

export default router;
