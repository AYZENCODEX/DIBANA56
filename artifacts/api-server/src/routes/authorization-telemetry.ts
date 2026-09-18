/**
 * routes/authorization-telemetry.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 24 (Observability).
 *
 * This is Phase 24's own "integrate with existing AYZEN observability"
 * instruction, read literally: `./telemetry.ts` is this app's REAL
 * observability surface (`GET /api/telemetry/functions|errors|ping`, a
 * `POST /api/telemetry/smoke-test`, consumed by
 * `artifacts/ayzen/src/pages/admin/developer.tsx`'s "Telemetry" tab) — not
 * Grafana, not any external APM. This file adds the authorization-layer
 * counterpart to that SAME surface, in the SAME router-per-concern style
 * every other `routes/*.ts` file here already follows, rather than
 * inventing a separate dashboarding product this app doesn't already run
 * (see `lib/policy/observability/dashboards.ts`'s own header for the full
 * reasoning).
 *
 * ── Reads the shared singletons, mounted or not ──────────────────────────
 * `lib/policy/observability/runtime-registries.ts`'s `metricsRegistry`/
 * `accessPatternRegistry` are the SAME instances a future `PolicyEngine`
 * construction site will eventually feed via `authorizationObserver` (see
 * that file's own header) — nothing routes through them yet, because
 * nothing in this app constructs a `PolicyEngine` yet (Rule 16; see the
 * roadmap's own "MIGRATION STRATEGY" — routes move over in waves, later).
 * Mounting this router now is still correct, not premature: it exposes
 * the REAL, honestly-empty current state (`requestsTotal: 0`, etc.), the
 * same way `./telemetry.ts`'s own `/telemetry/errors` already returns an
 * honest "no errors recorded yet" placeholder rather than fabricating
 * data (see that file's own `rows.length === 0` branch) — not a stand-in
 * that pretends decisions are already flowing.
 *
 * ── GET /telemetry/authorization/dashboards ───────────────────────────────
 * The roadmap's own six named dashboards (authorization health, denial
 * spikes, policy errors, latency, unusual access patterns, high-risk
 * decisions), as one JSON object — see `lib/policy/observability/
 * dashboards.ts`'s own `buildAuthorizationDashboards()`.
 *
 * ── GET /telemetry/authorization/metrics ──────────────────────────────────
 * Prometheus text exposition format, both registries' output concatenated
 * — for the day a real Prometheus/Grafana deployment exists to scrape it
 * (see `lib/policy/observability/metrics-registry.ts`'s own header on why
 * this format was chosen with zero client-library dependency).
 *
 * ── ROUTE INTEGRATION ROADMAP — SEASON B, PHASE B3: AUTH FINDING ─────────
 * This router was mounted (`routes/index.ts`) with NO auth middleware at
 * all — neither `requireDev` nor anything else — since the day it shipped
 * (Phase 24). Any unauthenticated caller could read every authorization
 * decision this engine has ever made, in aggregate: denial rates, which
 * policies fire, unusual-access-pattern flags — a real information
 * disclosure, not a hypothetical one, on the same tier as
 * `admin-policy-console.ts`/`admin-rbac-console.ts`/
 * `admin-resource-console.ts` (which have all always required at least
 * `requireDev`). Phase B3 fixes this: `requireDev` first (same "must be a
 * real operator session at all" tier every other admin console in this
 * codebase already shares), then a NEW `admin.telemetry.read` permission
 * (migration 106) through the exact same PEP pattern the three sibling
 * consoles above now use, so this console's own access is — for the
 * first time — itself observable through the same audit/telemetry
 * surface it exposes. See `CHANGES_ROUTE_INTEGRATION_PHASE_B3.md`.
 */

import { Router } from "express";
import { metricsRegistry, accessPatternRegistry } from "../lib/policy/observability/runtime-registries";
import { buildAuthorizationDashboards } from "../lib/policy/observability/dashboards";
import { requireDev, getPepRbacProvider, pepDecisionObserver } from "../middlewares/auth";
import { requirePermission } from "../lib/policy/pep/middleware";

const router = Router();

export const TELEMETRY_READ_PERMISSION = "admin.telemetry.read";

// `onDeny` matches the `{ error: "forbidden", message }`, 403 shape the
// sibling admin consoles' own `sendFailure()` helpers already return for
// their own permission denials (see admin-policy-console.ts's own Phase
// B3 comment) — this router has no such helper of its own (it never
// needed one before this phase), so the shape is written out directly
// here instead of introducing one for a two-route file.
const requireTelemetryReadAccess = requirePermission(getPepRbacProvider(), TELEMETRY_READ_PERMISSION, undefined, {
  onDecision: pepDecisionObserver,
  onDeny: (_req, res) => {
    res.status(403).json({ error: "forbidden", message: 'This action requires the "admin.telemetry.read" permission.' });
  },
});

// ── GET /telemetry/authorization/dashboards — the roadmap's six named
//    dashboards, as JSON, for the existing admin Telemetry tab to render. ──
router.get("/telemetry/authorization/dashboards", requireDev, requireTelemetryReadAccess, (_req, res): void => {
  res.json(buildAuthorizationDashboards(metricsRegistry.snapshot(), accessPatternRegistry.snapshot()));
});

// ── GET /telemetry/authorization/metrics — Prometheus text exposition,
//    for a real Prometheus/Grafana deployment to scrape directly. ──
router.get("/telemetry/authorization/metrics", requireDev, requireTelemetryReadAccess, (_req, res): void => {
  res.type("text/plain; version=0.0.4; charset=utf-8");
  res.send(metricsRegistry.toPrometheusText() + accessPatternRegistry.toPrometheusText());
});

export default router;
