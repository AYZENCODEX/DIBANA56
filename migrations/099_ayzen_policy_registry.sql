-- 099_ayzen_policy_registry.sql
-- AYZEN Policy & Authorization Mega Engine — Phase 07: Policy Registry / PAP.
-- Run this once in Supabase SQL Editor. Run AFTER 098.
--
-- Creates the two tables Phase 07 needs: `policies` (one immutable row per
-- (policy_id, version)) and `policy_admin_audit_log` (append-only mutation
-- log). Matches lib/db/src/schema/policy-registry.ts exactly — see that
-- file's header for the full design rationale (why `rules` is TEXT not
-- JSONB, why `before`/`after` are JSONB not typed columns, why there are
-- no DB-level FK constraints).
--
-- DRIZZLE SCHEMA, matching migration 096/097/098's own precedent (RBAC,
-- resource grants, relationships) — this table's readers/writers
-- (`artifacts/api-server/src/lib/policy/registry/*`) are typed, reusable
-- library code with many future call sites (a future admin route, tests),
-- not a single request/response cycle.
--
-- IDEMPOTENT — every statement is safe to re-run, matching every other
-- migration in this directory.

CREATE TABLE IF NOT EXISTS policies (
  id SERIAL PRIMARY KEY,
  policy_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  application TEXT NOT NULL,
  resource TEXT NOT NULL,
  action TEXT NOT NULL,
  rule_kind TEXT NOT NULL,
  rules TEXT NOT NULL,
  effect TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  created_by INTEGER NOT NULL,
  approved_by INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS policies_policy_id_idx ON policies(policy_id);
CREATE UNIQUE INDEX IF NOT EXISTS policies_policy_id_version_idx ON policies(policy_id, version);
CREATE INDEX IF NOT EXISTS policies_status_idx ON policies(status);
CREATE INDEX IF NOT EXISTS policies_application_resource_idx ON policies(application, resource);

-- ── Partial unique index: at most one ACTIVE version per policy_id ────────
-- `PolicyRegistry.transitionStatus()` already enforces this at the
-- application layer (auto-disabling any other ACTIVE version before
-- activating a new one — see policy-registry.ts's own header), so under
-- normal operation this index never actually rejects a legitimate write.
-- It exists as a DB-level backstop against a bug or a future second
-- writer that bypasses `PolicyRegistry` — same belt-and-suspenders
-- reasoning `role_permissions`'s own unique index (migration 096) takes
-- relative to its resolver's own de-duplication. Drizzle's query builder
-- has no first-class partial-index API, so this one is SQL-only (not
-- mirrored in policy-registry.ts's `pgTable` call — see that file's
-- header note).
CREATE UNIQUE INDEX IF NOT EXISTS policies_one_active_per_policy_id_idx
  ON policies(policy_id) WHERE status = 'ACTIVE';

-- ── Basic column-shape guards (belt-and-suspenders alongside the zod
--    checks in policy-registry.ts — see that file's header) ───────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'policies_status_check'
  ) THEN
    ALTER TABLE policies
      ADD CONSTRAINT policies_status_check
      CHECK (status IN ('DRAFT', 'TESTING', 'APPROVED', 'ACTIVE', 'DISABLED', 'ARCHIVED'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'policies_effect_check'
  ) THEN
    ALTER TABLE policies
      ADD CONSTRAINT policies_effect_check
      CHECK (effect IN ('allow', 'deny'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'policies_rule_kind_check'
  ) THEN
    ALTER TABLE policies
      ADD CONSTRAINT policies_rule_kind_check
      CHECK (rule_kind IN ('abac_dsl'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS policy_admin_audit_log (
  id SERIAL PRIMARY KEY,
  actor_id INTEGER,
  policy_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  policy_row_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  before JSONB,
  after JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS policy_admin_audit_log_policy_id_idx ON policy_admin_audit_log(policy_id);
CREATE INDEX IF NOT EXISTS policy_admin_audit_log_policy_row_id_idx ON policy_admin_audit_log(policy_row_id);
CREATE INDEX IF NOT EXISTS policy_admin_audit_log_actor_id_idx ON policy_admin_audit_log(actor_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'policy_admin_audit_log_action_check'
  ) THEN
    ALTER TABLE policy_admin_audit_log
      ADD CONSTRAINT policy_admin_audit_log_action_check
      CHECK (action IN ('policy_created', 'policy_version_created', 'policy_status_changed'));
  END IF;
END $$;

-- No seed data for `policies` itself — matching this migration's own
-- original precedent: a policy only makes sense once authored by a real
-- admin through `PolicyRegistry`.
--
-- ── Amendment (Phase 23A/23B — Admin Policy Console) ────────────────────
-- Adds the two RBAC permission-catalog entries
-- `artifacts/api-server/src/lib/policy/registry/authorizer.ts`'s own
-- header names as "seeded by migration 099" (`admin.policy.manage` /
-- `admin.policy.approve`) — `RbacPolicyAdminAuthorizer` is what Phase 23A
-- adds to actually gate `PolicyRegistry`'s own mutations behind them (see
-- that file's header). Appended here, to this same migration, rather than
-- a new one, because these two rows are PART OF the Policy Registry's own
-- permission surface (documentation for what already-shipped Phase 07
-- code enforces once Phase 23A wires it up), not a new table or a new
-- product concern — same "this phase's own migration is the right home"
-- reasoning migration 104 applies to `admin.role.manage`/
-- `admin.role.assign` for the (separate) RBAC-admin surface. Idempotent
-- (`ON CONFLICT DO NOTHING`), so safe whether this migration has already
-- run once or is being run for the first time with this amendment already
-- in place.
--
-- No explicit grant row is added for either permission: the 'admin' role's
-- pre-existing '*' wildcard (migration 096) already satisfies both checks
-- on its own — see `RbacPolicyAdminAuthorizer`'s own header for why this
-- is called out explicitly rather than left to be discovered by reading
-- migration 096 separately.
INSERT INTO permissions (key, description)
VALUES
  ('admin.policy.manage', 'Create/version AYZEN Policy Registry entries and advance their lifecycle status (Admin Policy Console — Policies/Policy Versions sections).'),
  ('admin.policy.approve', 'Approve a Policy Registry version for activation (maker-checker''s "checker" half — Admin Policy Console).')
ON CONFLICT (key) DO NOTHING;
