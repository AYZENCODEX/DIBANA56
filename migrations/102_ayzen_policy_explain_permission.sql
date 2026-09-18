-- 102_ayzen_policy_explain_permission.sql
-- AYZEN Policy & Authorization Mega Engine — Phase 15: Explainability. Run
-- this once in Supabase SQL Editor. Run AFTER 101.
--
-- NO SCHEMA CHANGE. `roles` / `permissions` / `role_permissions` already
-- exist (migration 096) — this migration only adds a seed permission
-- catalog row and a role grant, the same additive-data-only shape
-- migration 096's own "Seed: illustrative permission catalog entries" /
-- "Seed: baseline role -> permission grants" sections already established.
-- No lib/db/src/schema/*.ts change accompanies this migration because no
-- table/column is added — see lib/db/src/schema/rbac.ts's own header:
-- role_permissions.permission_key is a plain TEXT column, already able to
-- hold this new string with no schema change, exactly like every other
-- permission key.
--
-- Adds `admin.policy.explain` — the permission
-- lib/policy/explain/viewer-authorization.ts's `canViewExplanationDetail()`
-- checks (via the SAME resolveEffectivePermissions()/permissionMatches()
-- chain every other RBAC check in this engine already uses) before ever
-- populating Phase 15's admin/debug explanation detail (policy, version,
-- matched rule, reason code, risk, assurance, resource context) for a
-- caller. The `admin` role already satisfies this today via its existing
-- `"*"` global wildcard grant (migration 096) with no further change
-- required — this migration's explicit grant exists so the capability is
-- independently visible in the `permissions`/`role_permissions` catalog
-- (auditable on its own, not merely implied by the wildcard) and so a
-- future, narrower role (e.g. a dedicated "auditor" role, not yet seeded)
-- could be granted exactly this one capability without inheriting the
-- full admin wildcard.
--
-- IDEMPOTENT — every statement is safe to re-run (ON CONFLICT DO NOTHING),
-- matching every other migration in this directory.

INSERT INTO permissions (key, description)
VALUES
  ('admin.policy.explain', 'View admin/debug authorization-decision explanation detail (policy, version, matched rule, reason code, risk, assurance, resource context). Gates Phase 15 (Explainability) detail exposure.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'admin.policy.explain'
FROM roles r
WHERE r.key = 'admin'
ON CONFLICT (role_id, permission_key) DO NOTHING;
