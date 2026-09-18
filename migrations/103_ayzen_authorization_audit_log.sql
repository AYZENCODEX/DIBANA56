-- 103_ayzen_authorization_audit_log.sql
-- AYZEN Policy & Authorization Mega Engine — Phase 17 (Authorization Audit).
-- Run this once in Supabase SQL Editor. Run AFTER 102.
--
-- Dedicated, append-only durable store for every PDP (PolicyEngine)
-- decision — the roadmap's own Phase 17 field list. Written by
-- lib/policy/audit/audit-observer.ts's createAuthorizationAuditObserver(),
-- through lib/policy/audit/drizzle-audit-writer.ts, whenever a caller wires
-- an engine with { onDecision: createAuthorizationAuditObserver(writer) }.
-- Nothing in the app constructs that wiring yet (see
-- CHANGES_POLICY_AUTHORIZATION_ENGINE_PHASE17.md) — this table can be
-- created ahead of that wiring with zero effect on existing traffic.
--
-- Distinct from policy_admin_audit_log (migration 099, Phase 07): that
-- table is about ADMINISTRATIVE changes to the policy registry itself
-- (who created/versioned/activated a policy). This table is about the
-- RUNTIME OUTCOME of every authorization question asked of the PDP,
-- registry-backed or not.

CREATE TABLE IF NOT EXISTS authorization_audit_log (
  id SERIAL PRIMARY KEY,

  decision_id TEXT NOT NULL,
  request_id TEXT NOT NULL,

  subject_user_id INTEGER,
  subject_role TEXT,
  subject_auth_type TEXT,
  subject_organization_id INTEGER,

  product TEXT,
  resource_type TEXT,
  resource_id TEXT,
  action TEXT,

  decision TEXT NOT NULL,       -- ALLOW | DENY | STEP_UP | APPROVAL_REQUIRED
  reason_code TEXT NOT NULL,

  policy_id TEXT,
  policy_version INTEGER,

  risk TEXT,                    -- low | medium | high
  assurance_methods JSONB,      -- e.g. ["password", "totp"]
  required_assurance TEXT,

  "timestamp" TIMESTAMP NOT NULL,  -- when the PDP produced the decision
  latency_ms INTEGER,

  created_at TIMESTAMP NOT NULL DEFAULT NOW()  -- when this row was persisted
);

CREATE INDEX IF NOT EXISTS authorization_audit_log_request_id_idx ON authorization_audit_log(request_id);
CREATE INDEX IF NOT EXISTS authorization_audit_log_subject_user_id_idx ON authorization_audit_log(subject_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS authorization_audit_log_decision_idx ON authorization_audit_log(decision, created_at DESC);
CREATE INDEX IF NOT EXISTS authorization_audit_log_policy_id_idx ON authorization_audit_log(policy_id);
CREATE INDEX IF NOT EXISTS authorization_audit_log_created_at_idx ON authorization_audit_log(created_at DESC);

-- Same discipline as migration 073 (vault_backup_audit_log) and migration
-- 067 (encryption_keys): an audit trail that can be edited or deleted by
-- application code isn't an audit trail. No UPDATE or DELETE path is ever
-- wired up in the app — this trigger makes that a DB-enforced guarantee
-- instead of just a convention, so a bug or a compromised account with DB
-- write access still can't quietly erase or rewrite its own tracks.
CREATE OR REPLACE FUNCTION prevent_authorization_audit_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'authorization_audit_log rows are append-only and never deleted or edited. See migration 103.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_authorization_audit_log_delete ON authorization_audit_log;
CREATE TRIGGER trg_prevent_authorization_audit_log_delete
  BEFORE DELETE ON authorization_audit_log
  FOR EACH ROW
  EXECUTE FUNCTION prevent_authorization_audit_log_mutation();

DROP TRIGGER IF EXISTS trg_prevent_authorization_audit_log_update ON authorization_audit_log;
CREATE TRIGGER trg_prevent_authorization_audit_log_update
  BEFORE UPDATE ON authorization_audit_log
  FOR EACH ROW
  EXECUTE FUNCTION prevent_authorization_audit_log_mutation();
