-- 101_ayzen_approval_requests.sql
-- AYZEN Policy & Authorization Mega Engine — Phase 12: Approval Engine. Run
-- this once in Supabase SQL Editor. Run AFTER 100.
--
-- Creates `approval_requests` and `approval_audit_log` — matches
-- lib/db/src/schema/approval-requests.ts exactly — see that file's header
-- for the full design rationale (why `approval_requests` is a MUTABLE row
-- unlike every other Phase 03/07/11 grant/registry table, why `resource_id`
-- is nullable, why there is no `scope: "resource_type"` breadth the way
-- migration 100's `temporary_access_grants` has, why `organization_id` is
-- carried but never matched against).
--
-- DRIZZLE SCHEMA, matching migration 097/099/100's own precedent — this
-- table's readers/writers (`artifacts/api-server/src/lib/policy/approval/*`)
-- are typed, reusable library code with many future call sites (a future
-- approval-request route, tests), not a single request/response cycle.
--
-- IDEMPOTENT — every statement is safe to re-run, matching every other
-- migration in this directory.

CREATE TABLE IF NOT EXISTS approval_requests (
  id SERIAL PRIMARY KEY,
  initiator_user_id INTEGER NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  action TEXT NOT NULL,
  organization_id INTEGER,
  reason TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING',
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  decided_by INTEGER,
  decided_at TIMESTAMP,
  decision_reason TEXT
);

CREATE TABLE IF NOT EXISTS approval_audit_log (
  id SERIAL PRIMARY KEY,
  actor_id INTEGER,
  request_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  before JSONB,
  after JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- approval-gate-rule.ts's live-approval lookup (findApprovedRequest())
-- filters by exactly these four columns plus state = 'APPROVED' — see
-- schema file header.
CREATE INDEX IF NOT EXISTS approval_requests_lookup_idx
  ON approval_requests(initiator_user_id, resource_type, resource_id, action);

CREATE INDEX IF NOT EXISTS approval_requests_state_idx
  ON approval_requests(state);

-- Supports a future cleanup/reminder job walking soon-to-expire or
-- already-expired PENDING rows — same "ready for a future job, nothing in
-- this phase queries it yet" posture migration 100's own
-- temporary_access_grants_expires_idx comment documents.
CREATE INDEX IF NOT EXISTS approval_requests_expires_idx
  ON approval_requests(expires_at);

CREATE INDEX IF NOT EXISTS approval_audit_log_request_id_idx
  ON approval_audit_log(request_id);

CREATE INDEX IF NOT EXISTS approval_audit_log_actor_id_idx
  ON approval_audit_log(actor_id);

-- ── CHECK constraints: DB-level backstop, mirroring the Zod refinements in
-- lib/db/src/schema/approval-requests.ts's insertApprovalRequestSchema /
-- insertApprovalAuditLogSchema (same "belt-and-suspenders" reasoning
-- migration 099's partial-active-index comment gives for its own DB-level
-- backstop; Drizzle's pgTable call does not mirror CHECK constraints
-- either, matching migration 100's own precedent) ──────────────────────────

ALTER TABLE approval_requests
  DROP CONSTRAINT IF EXISTS approval_requests_state_check;
ALTER TABLE approval_requests
  ADD CONSTRAINT approval_requests_state_check
  CHECK (state IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'));

ALTER TABLE approval_audit_log
  DROP CONSTRAINT IF EXISTS approval_audit_log_action_check;
ALTER TABLE approval_audit_log
  ADD CONSTRAINT approval_audit_log_action_check
  CHECK (action IN ('approval_requested', 'approval_decided', 'approval_cancelled', 'approval_expired'));

-- A request's `decided_by`/`decided_at` are set together, and only for a
-- row that actually ends APPROVED/REJECTED — see schema file header
-- ("decided_by ... stays NULL forever for a row that ends
-- EXPIRED/CANCELLED, since nobody ever decided it") and
-- approval-engine.ts's `applyStateChange()`, which is the one place that
-- ever writes these two columns together. Keeps a malformed row (e.g.
-- state = 'PENDING' with a non-NULL decided_by) from ever reaching the
-- application layer instead of relying on DrizzleApprovalRequestProvider to
-- notice at read time.
ALTER TABLE approval_requests
  DROP CONSTRAINT IF EXISTS approval_requests_decision_consistency_check;
ALTER TABLE approval_requests
  ADD CONSTRAINT approval_requests_decision_consistency_check
  CHECK (
    (state IN ('APPROVED', 'REJECTED') AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
    OR (state IN ('PENDING', 'EXPIRED', 'CANCELLED') AND decided_by IS NULL AND decided_at IS NULL)
  );
