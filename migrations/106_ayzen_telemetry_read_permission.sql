-- 106_ayzen_telemetry_read_permission.sql
-- AYZEN Policy & Authorization Mega Engine — Route Integration Roadmap,
-- Season B, Phase B3 (Admin consoles / dogfooding).
-- Run this once in Supabase SQL Editor. Run AFTER 105.
--
-- Adds ONE new permission-catalog entry: `admin.telemetry.read`. No new
-- table — `permissions`/`role_permissions` already exist (migration 096)
-- and are reused as-is (Rule 2: do not replace/duplicate existing data),
-- same precedent migration 104/105 already follow for their own consoles'
-- permission keys.
--
-- IDEMPOTENT — every statement is safe to re-run (ON CONFLICT DO NOTHING),
-- matching every other migration in this directory.
--
-- ── WHY THIS ONE IS DIFFERENT FROM 099/104/105 ──────────────────────────
-- `admin.policy.manage`/`admin.policy.approve` (099), `admin.role.manage`/
-- `admin.role.assign` (104), and `admin.resource.manage` (105) were each
-- added ALONGSIDE the console they gate — those routes already required
-- `requireDev` before their respective phase, so granting the new
-- permission to 'admin' only (via its pre-existing '*' wildcard) changed
-- nothing for who could reach them.
--
-- `routes/authorization-telemetry.ts` is not that case: per this phase's
-- own CHANGES doc, that route had NO auth middleware at all before this
-- migration — not even `requireDev`. Phase B3 adds `requireDev` AND this
-- permission together, in the same route-file change. To avoid the new
-- `requireDev` alone silently becoming the more restrictive of the two
-- checks (which would make behavior harder to reason about than "one
-- gate, one clear grant list"), `admin.telemetry.read` is granted to
-- BOTH 'dev' and 'admin' here — matching `requireDev`'s own "dev OR
-- admin" role scope exactly, so the new PDP-routed permission check is
-- never stricter than the role gate sitting in front of it.
INSERT INTO permissions (key, description)
VALUES
  ('admin.telemetry.read', 'Read the Policy & Authorization Mega Engine''s own authorization-decision dashboards/metrics (routes/authorization-telemetry.ts).')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.permission_key
FROM roles r
CROSS JOIN (VALUES ('admin.telemetry.read')) AS p(permission_key)
WHERE r.key IN ('dev', 'admin')
ON CONFLICT (role_id, permission_key) DO NOTHING;
