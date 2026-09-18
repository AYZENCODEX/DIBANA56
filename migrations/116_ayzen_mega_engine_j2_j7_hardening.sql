-- J2-J7 hardening: durable scheduler dedupe, trace propagation, compensation
-- recovery, and an engine audit sink. All statements are idempotent.
ALTER TABLE event_outbox ADD COLUMN IF NOT EXISTS trace_id TEXT;
ALTER TABLE scheduled_job ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE scheduled_job ADD COLUMN IF NOT EXISTS trace_id TEXT;
ALTER TABLE workflow_run ADD COLUMN IF NOT EXISTS trace_id TEXT;
ALTER TABLE workflow_run ADD COLUMN IF NOT EXISTS compensation_state JSONB;
ALTER TABLE workflow_run ADD COLUMN IF NOT EXISTS compensation_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workflow_run ADD COLUMN IF NOT EXISTS max_compensation_attempts INTEGER NOT NULL DEFAULT 3;

CREATE UNIQUE INDEX IF NOT EXISTS scheduled_job_idempotency_key_idx
  ON scheduled_job(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS scheduled_job_trace_id_idx ON scheduled_job(trace_id);
CREATE INDEX IF NOT EXISTS event_outbox_trace_id_idx ON event_outbox(trace_id);
CREATE INDEX IF NOT EXISTS workflow_run_trace_id_idx ON workflow_run(trace_id);

CREATE TABLE IF NOT EXISTS engine_audit_log (
  id UUID PRIMARY KEY,
  action TEXT NOT NULL,
  actor_user_id INTEGER,
  organization_id INTEGER,
  subject_type TEXT,
  subject_id TEXT,
  event_id TEXT,
  workflow_run_id TEXT,
  job_id TEXT,
  trace_id TEXT,
  correlation_id TEXT,
  causation_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS engine_audit_log_trace_idx ON engine_audit_log(trace_id, created_at);
CREATE INDEX IF NOT EXISTS engine_audit_log_subject_idx ON engine_audit_log(subject_type, subject_id, created_at);
CREATE INDEX IF NOT EXISTS engine_audit_log_action_idx ON engine_audit_log(action, created_at);