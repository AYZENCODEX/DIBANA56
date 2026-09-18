-- 098_ayzen_relationships.sql
-- AYZEN Policy & Authorization Mega Engine — Phase 04: ReBAC.
-- Run this once in Supabase SQL Editor. Run AFTER 097.
--
-- One generic table for every relation kind (owner/member/manager/viewer/
-- editor/approver/auditor) against every relation target (organization,
-- team, vault item, or any future resource type) — see
-- lib/db/src/schema/relationships.ts's header for the full design
-- rationale (why one table, why the unique index covers all four columns
-- instead of just three, why resource_id is TEXT, why there is no
-- expiresAt column yet).
--
-- IDEMPOTENT — every statement is safe to re-run, matching every other
-- migration in this directory.

CREATE TABLE IF NOT EXISTS relationships (
  id SERIAL PRIMARY KEY,
  subject_user_id INTEGER NOT NULL,
  relation TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  granted_by INTEGER,
  reason TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS relationships_subject_idx ON relationships(subject_user_id);
CREATE INDEX IF NOT EXISTS relationships_resource_idx ON relationships(resource_type, resource_id);
CREATE UNIQUE INDEX IF NOT EXISTS relationships_subject_resource_relation_idx
  ON relationships(subject_user_id, resource_type, resource_id, relation);

-- No seed data — same reasoning as migration 097 (resource_grants): a
-- relationship only makes sense once tied to a real resource row that
-- already exists in this database (a real organization, a real team, a
-- real vault item), and this migration must stay generic across every
-- resource type. The first real rows are written once a future
-- org/team-management feature actually calls INSERT against this table
-- (no writer exists yet — see the Phase 04 CHANGES doc's "not done"
-- section).
