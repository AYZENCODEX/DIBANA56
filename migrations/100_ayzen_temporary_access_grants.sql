-- 100_ayzen_temporary_access_grants.sql
-- AYZEN Policy & Authorization Mega Engine — Phase 11: Temporary / Expiring
-- Access. Run this once in Supabase SQL Editor. Run AFTER 099.
--
-- Creates `temporary_access_grants` — matches
-- lib/db/src/schema/temporary-access-grants.ts exactly — see that file's
-- header for the full design rationale (why this is a NEW table rather than
-- adding expiresAt/startsAt to `resource_grants`, what `scope` means, why
-- there is no `effect`/`revokedAt` column).
--
-- DRIZZLE SCHEMA, matching migration 097 (resource_grants)/099 (policy
-- registry)'s own precedent — this table's readers/writers
-- (`artifacts/api-server/src/lib/policy/temporary-access/*`) are typed,
-- reusable library code with many future call sites (a future admin route,
-- tests), not a single request/response cycle.
--
-- IDEMPOTENT — every statement is safe to re-run, matching every other
-- migration in this directory.

CREATE TABLE IF NOT EXISTS temporary_access_grants (
  id SERIAL PRIMARY KEY,
  subject_user_id INTEGER NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  action TEXT NOT NULL,
  scope TEXT NOT NULL,
  organization_id INTEGER,
  starts_at TIMESTAMP NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  granted_by INTEGER NOT NULL,
  reason TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS temporary_access_grants_subject_idx
  ON temporary_access_grants(subject_user_id, resource_type, action);

-- Supports a future cleanup/archival job walking already-expired rows —
-- nothing in Phase 11 itself reads this index yet (temporary-access-rule.ts
-- filters by time in application code against request.context.timestamp,
-- not via a WHERE clause on this column — see that file's header), but it
-- costs nothing to have ready and avoids a table scan whenever that future
-- job does land.
CREATE INDEX IF NOT EXISTS temporary_access_grants_expires_idx
  ON temporary_access_grants(expires_at);

-- ── CHECK constraints: DB-level backstop, mirroring the Zod refinements in
-- lib/db/src/schema/temporary-access-grants.ts's insertTemporaryAccessGrantSchema
-- (same "belt-and-suspenders" reasoning migration 099's partial-active-index
-- comment gives for its own DB-level backstop; Drizzle's pgTable call does
-- not mirror CHECK constraints either, matching that same precedent) ────────
ALTER TABLE temporary_access_grants
  DROP CONSTRAINT IF EXISTS temporary_access_grants_scope_check;
ALTER TABLE temporary_access_grants
  ADD CONSTRAINT temporary_access_grants_scope_check
  CHECK (scope IN ('resource', 'resource_type'));

ALTER TABLE temporary_access_grants
  DROP CONSTRAINT IF EXISTS temporary_access_grants_window_check;
ALTER TABLE temporary_access_grants
  ADD CONSTRAINT temporary_access_grants_window_check
  CHECK (expires_at > starts_at);

-- A "resource"-scoped grant must actually name a resource; a
-- "resource_type"-scoped grant deliberately has resource_id = NULL (see
-- schema file header) — this constraint keeps a malformed row (e.g. scope =
-- "resource" with a NULL resource_id) from ever reaching the application
-- layer instead of relying on temporary-access-rule.ts to notice at read
-- time.
ALTER TABLE temporary_access_grants
  DROP CONSTRAINT IF EXISTS temporary_access_grants_resource_id_check;
ALTER TABLE temporary_access_grants
  ADD CONSTRAINT temporary_access_grants_resource_id_check
  CHECK ((scope = 'resource' AND resource_id IS NOT NULL) OR (scope = 'resource_type' AND resource_id IS NULL));
