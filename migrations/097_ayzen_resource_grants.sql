-- 097_ayzen_resource_grants.sql
-- AYZEN Policy & Authorization Mega Engine — Phase 03, sub-phase 3B: explicit
-- resource grants + resource-level deny.
-- Run this once in Supabase SQL Editor. Run AFTER 096.
--
-- One generic table backing both "explicit grants" and "resource-level
-- deny" from the roadmap's Phase 03 list — see
-- lib/db/src/schema/resource-grants.ts's header for the full design
-- rationale (why one table, why resource_id is TEXT, why there is no
-- expiresAt column yet).
--
-- IDEMPOTENT — every statement is safe to re-run, matching every other
-- migration in this directory.

CREATE TABLE IF NOT EXISTS resource_grants (
  id SERIAL PRIMARY KEY,
  subject_user_id INTEGER NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  action TEXT NOT NULL,
  effect TEXT NOT NULL,
  granted_by INTEGER,
  reason TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS resource_grants_subject_idx ON resource_grants(subject_user_id);
CREATE INDEX IF NOT EXISTS resource_grants_resource_idx ON resource_grants(resource_type, resource_id);
CREATE UNIQUE INDEX IF NOT EXISTS resource_grants_subject_resource_action_idx
  ON resource_grants(subject_user_id, resource_type, resource_id, action);

-- No seed data — unlike migration 096's illustrative role/permission catalog,
-- there is nothing meaningful to seed here yet: a resource grant only makes
-- sense once tied to a real resource row that already exists in this
-- database, and this migration must stay generic across every resource
-- type. The first real rows are written once a future admin-console/sharing
-- feature actually calls INSERT against this table (no writer exists yet —
-- see the Phase 3B CHANGES doc's "not done" section).
