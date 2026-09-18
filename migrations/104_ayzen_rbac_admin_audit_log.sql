-- 104_ayzen_rbac_admin_audit_log.sql
-- AYZEN Policy & Authorization Mega Engine — Phase 23C (Admin Policy
-- Console — Roles, Permissions & Assignments sections).
-- Run this once in Supabase SQL Editor. Run AFTER 103.
--
-- Creates the ONE new table this phase adds: `rbac_admin_audit_log`. Every
-- other table `lib/policy/rbac-admin/*` reads/writes (`roles`,
-- `permissions`, `role_permissions`, `user_roles`) already exists —
-- migration 096 (Phase 02) — and is reused as-is; see
-- `drizzle-rbac-admin-provider.ts`'s own header for why (Rule 2: do not
-- replace/duplicate existing data). Matches
-- `lib/db/src/schema/rbac.ts`'s `rbacAdminAuditLogTable` exactly — see
-- that file's own header for the full design rationale (why this is one
-- shared audit stream for every RBAC-admin mutation kind rather than one
-- table per kind, why `subject_key` is not an FK to any single table, why
-- there are no DB-level FK constraints at all).
--
-- DRIZZLE SCHEMA, matching migration 096/097/098/099's own precedent
-- (RBAC, resource grants, relationships, policy registry) — this table's
-- readers/writers (`lib/policy/rbac-admin/*`) are typed, reusable library
-- code with many future call sites (the admin route this phase also
-- ships, tests), not a single request/response cycle.
--
-- IDEMPOTENT — every statement is safe to re-run (CREATE ... IF NOT
-- EXISTS, ON CONFLICT DO NOTHING for the seed rows), matching every other
-- migration in this directory.

CREATE TABLE IF NOT EXISTS rbac_admin_audit_log (
  id SERIAL PRIMARY KEY,
  actor_id INTEGER,
  action TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  before JSONB,
  after JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rbac_admin_audit_log_subject_key_idx ON rbac_admin_audit_log(subject_key);
CREATE INDEX IF NOT EXISTS rbac_admin_audit_log_actor_id_idx ON rbac_admin_audit_log(actor_id);
CREATE INDEX IF NOT EXISTS rbac_admin_audit_log_action_idx ON rbac_admin_audit_log(action);

-- ── Basic column-shape guard (belt-and-suspenders alongside the zod check
--    in lib/db/src/schema/rbac.ts — see that file's header) ───────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rbac_admin_audit_log_action_check'
  ) THEN
    ALTER TABLE rbac_admin_audit_log
      ADD CONSTRAINT rbac_admin_audit_log_action_check
      CHECK (action IN (
        'role_created', 'role_updated', 'role_deleted',
        'permission_created', 'permission_granted', 'permission_revoked',
        'user_role_assigned', 'user_role_revoked'
      ));
  END IF;
END $$;

-- ── Seed: the two RBAC-admin permission-catalog entries + an explicit
--    admin grant ────────────────────────────────────────────────────────
-- `RbacRbacAdminAuthorizer`'s own header (authorizer.ts) names both as
-- "seeded (as a catalog row + an explicit admin grant) by migration 104"
-- — an explicit grant exists for each even though the 'admin' role's
-- pre-existing '*' wildcard (migration 096) already satisfies both checks
-- on its own, so this admin console's own two permissions are visible in
-- `role_permissions` the same way any other console-managed grant would
-- be, rather than being invisibly true only because of the wildcard.
INSERT INTO permissions (key, description)
VALUES
  ('admin.role.manage', 'Create/edit/delete roles, manage the permission catalog, and grant/revoke a role''s own permission patterns (Admin Policy Console — Roles/Permissions sections).'),
  ('admin.role.assign', 'Assign or revoke a role ON A USER (Admin Policy Console — Assignments section). Distinct from admin.role.manage: defining what a role CAN do is a different capability from deciding WHO holds it.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.permission_key
FROM roles r
CROSS JOIN (VALUES ('admin.role.manage'), ('admin.role.assign')) AS p(permission_key)
WHERE r.key = 'admin'
ON CONFLICT (role_id, permission_key) DO NOTHING;

-- No seed data for `rbac_admin_audit_log` itself — matching migration
-- 099's own precedent for `policy_admin_audit_log`: an audit row only
-- makes sense once a real mutation runs through `RbacAdminRegistry`.
