/**
 * routes/admin-oidc-backchannel-logout.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 3, Phase 6e-d: Monitoring.
 *
 * The admin-facing read side of 6e-d — `lib/oidc-logout-propagation.ts`'s
 * own 6e-d section does the actual DB reads and threshold math
 * (`getBackchannelLogoutQueueStats()` / `evaluateBackchannelLogoutQueueHealth()`);
 * this route is a thin pass-through, the exact same relationship
 * `routes/admin-oidc-rollout.ts`'s GET handler has with
 * `getOidcLoginAttemptStats()`/`evaluateOidcRolloutHealth()` (`lib/oidc-login-attempts.ts`).
 *
 * MOUNTING: through `routes/index.ts`, same `requireDev`-gated tier as
 * `admin-oidc-rollout.ts` and `config.ts` — an internal operator surface,
 * never called by an OIDC client or a logged-out visitor.
 *
 * Deliberately GET-only. Unlike `admin-oidc-rollout.ts` (which also exposes
 * a PATCH to flip the rollout flag), this queue has no admin-actionable
 * write in scope for 6e-d — see `lib/oidc-logout-propagation.ts`'s own
 * 6e-c "what's intentionally not here" note: no dead-letter replay/requeue
 * endpoint exists yet, and 6e-d's own task was "define metrics/dashboards/
 * alerting," not "add an admin action." A future sub-phase can add a
 * replay endpoint here without this file's shape needing to change.
 */
import { Router, type IRouter } from "express";
import { requireDev } from "../middlewares/auth";
import { getBackchannelLogoutQueueStats, computeBackchannelLogoutQueueHealth, DEFAULT_BACKCHANNEL_LOGOUT_STATS_WINDOW_MS } from "../lib/oidc-logout-propagation";

const router: IRouter = Router();

// ── GET /admin/oidc-backchannel-logout/status — 6e-d: queue stats + health ──
router.get("/admin/oidc-backchannel-logout/status", requireDev, async (req, res): Promise<void> => {
  const windowMs = (() => {
    const raw = Number(req.query.windowMs);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BACKCHANNEL_LOGOUT_STATS_WINDOW_MS;
  })();

  // Single fetch — health computed via the PURE `computeBackchannelLogoutQueueHealth()`
  // over this same stats object, not the effectful `evaluateBackchannelLogoutQueueHealth()`
  // wrapper (which would fetch its own stats a second time). One DB round
  // trip per request, same discipline `routes/admin-oidc-rollout.ts`'s own
  // `Promise.all([...])` batching keeps for its three parallel reads.
  const stats = await getBackchannelLogoutQueueStats(windowMs);
  const health = computeBackchannelLogoutQueueHealth(stats);

  res.json({ stats, health });
});

export default router;
