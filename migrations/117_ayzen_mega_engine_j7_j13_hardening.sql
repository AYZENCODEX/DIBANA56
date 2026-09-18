-- AYZEN Mega Engine J7-J13 hardening
-- Durable workflow execution leases, cancellation governance, and indexes.

ALTER TABLE workflow_run
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT,
  ADD COLUMN IF NOT EXISTS cancellation_actor_user_id INTEGER,
  ADD COLUMN IF NOT EXISTS execution_owner TEXT,
  ADD COLUMN IF NOT EXISTS execution_lease_until TIMESTAMP,
  ADD COLUMN IF NOT EXISTS execution_version INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_workflow_run_execution_lease
  ON workflow_run(execution_lease_until);

CREATE INDEX IF NOT EXISTS idx_workflow_run_status_resume
  ON workflow_run(status, next_resume_at);