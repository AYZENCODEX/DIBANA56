-- 105_ayzen_resource_admin_audit_log.sql
-- AYZEN Policy & Authorization Mega Engine — Phase 23D (Admin Policy
-- Console — Resources section).
-- Run this once in Supabase SQL Editor. Run AFTER 104.
--
-- Creates the ONE new table this phase adds: `resource_admin_audit_log`.
-- The table this phase's admin console reads/writes, `resource_grants`,
-- already exists — migration 097 (Phase 03, sub-phase 3B) — and is reused
-- as-is (Rule 2: do not replace/duplicate existing data). Matches
-- `lib/db/src/schema/resource-grants.ts`'s own `resourceAdminAuditLogTable`
-- exactly — see that file's own header (appended this phase) for the full
-- design rationale (why this is its own audit stream rather than folding
-- into `rbac_admin_audit_log`/`policy_admin_audit_log`, why `subject_key`
-- is not an FK to `resource_grants`, why there are no DB-level FK
-- constraints at all).
--
-- DRIZZLE SCHEMA, matching migration 096/097/098/099/104's own precedent
-- — this table's readers/writers (`lib/policy/resource-admin/*`) are
-- typed, reusable library code with many future call sites (the admin
-- route this phase also ships, tests), not a single request/response
-- cycle.
--
-- IDEMPOTENT — every statement is safe to re-run (CREATE ... IF NOT
-- EXISTS, ON CONFLICT DO NOTHING for the seed rows), matching every other
-- migration in this directory.

CREATE TABLE IF NOT EXISTS resource_admin_audit_log (
  id SERIAL PRIMARY KEY,
  actor_id INTEGER,
  action TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  before JSONB,
  after JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS resource_admin_audit_log_subject_key_idx ON resource_admin_audit_log(subject_key);
CREATE INDEX IF NOT EXISTS resource_admin_audit_log_actor_id_idx ON resource_admin_audit_log(actor_id);
CREATE INDEX IF NOT EXISTS resource_admin_audit_log_action_idx ON resource_admin_audit_log(action);

-- ── Basic column-shape guard (belt-and-suspenders alongside the zod check
--    in lib/db/src/schema/resource-grants.ts — see that file's header) ────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'resource_admin_audit_log_action_check'
  ) THEN
    ALTER TABLE resource_admin_audit_log
      ADD CONSTRAINT resource_admin_audit_log_action_check
      CHECK (action IN ('resource_grant_created', 'resource_grant_revoked'));
  END IF;
END $$;

-- ── Seed: this admin console's own permission-catalog entry + an explicit
--    admin grant ────────────────────────────────────────────────────────
-- `RbacResourceAdminAuthorizer`'s own header (authorizer.ts) names this as
-- "seeded (as a catalog row + an explicit admin grant) by migration 105"
-- — an explicit grant exists even though the 'admin' role's pre-existing
-- '*' wildcard (migration 096) already satisfies the check on its own,
-- same reasoning migration 104 gives for `admin.role.manage`/
-- `admin.role.assign`. A single flat permission (unlike RBAC-admin's
-- manage/assign split) — see resource-admin/types.ts's own header for why
-- create, revoke, and the allow/deny distinction all sit behind one
-- permission here rather than two.
INSERT INTO permissions (key, description)
VALUES
  ('admin.resource.manage', 'Create or revoke an explicit (subject, resource, action) grant/deny entry (Admin Policy Console — Resources section).')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.permission_key
FROM roles r
CROSS JOIN (VALUES ('admin.resource.manage')) AS p(permission_key)
WHERE r.key = 'admin'
ON CONFLICT (role_id, permission_key) DO NOTHING;

-- No seed data for `resource_admin_audit_log` itself — matching migration
-- 104's own precedent: an audit row only makes sense once a real mutation
-- runs through `ResourceAdminRegistry`.
