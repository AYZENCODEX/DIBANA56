-- 093_ayzen_oidc_client_admin_audit_log.sql
-- OIDC Roadmap — Season 5, Phase 9e: Audit Log.
-- Run this once in Supabase SQL Editor. Run AFTER 092.
--
-- 9a-9c (this Season's earlier sub-phases) gave an operator read/edit/
-- create/delete over `oidc_clients` with no durable record of WHO changed
-- WHAT, WHEN — every one of those writes today is only a `logger.info()`
-- line, which (same caveat `lib/oidc-login-attempts.ts`'s own header
-- already gives for 9a's `lastTokenIssuedAt`) is process-local and does
-- not survive a restart, let alone support "show me this client's history"
-- as a queryable admin view. This table is that durable record — 9e's own
-- roadmap text names the exact column list this migration ships:
-- `actorId`, `clientId`, `action`, `before`/`after` JSON, `at`.
--
-- SHAPE FOLLOWS `lib/vault-backup-audit.ts`'s PRECEDENT (9e's own roadmap
-- text: "শেপ হুবহু lib/vault-backup-audit.ts-এর existing precedent অনুসরণ
-- করে") AT THE DESIGN level, not the column-for-column level: a dedicated,
-- append-only audit table; a best-effort, never-throws write helper
-- (`lib/oidc-client-admin-audit.ts`); an actor/target/action/detail shape.
-- The concrete columns here are 9e's own roadmap-named list instead of
-- vault-backup-audit's `ownerUserId`/`eventType`/`detail` names, because
-- THIS domain's natural unit of change is a full before/after row snapshot
-- (an admin edit/create/delete/status-change on one `oidc_clients` row),
-- not a single free-form `detail` blob describing an arbitrary event —
-- `before`/`after` is the more useful shape for "what did this admin
-- action actually change" than a narrower `detail: Record<string, unknown>`
-- would be here.
--
-- RAW SQL / `pool.query()`, NOT A DRIZZLE SCHEMA — same reasoning migration
-- 088's own header already gives for `oidc_user_consents`: every OIDC
-- table this codebase has added since Season 4 (088, 090-092) is read/
-- written through `@workspace/db`'s raw `pool`, not a `@workspace/db`
-- Drizzle schema mirror, and `lib/oidc-client-admin.ts`/`lib/oidc-clients.ts`
-- (this table's two writers, 9b/9c/9d) already use that same raw-`pool`
-- idiom. Adding a Drizzle mirror here would be the only OIDC-family write
-- path in this Season doing so.
--
-- `client_id` is DELIBERATELY NOT a FOREIGN KEY into `oidc_clients` — same
-- precedent `oidc_authorization_codes`/`oidc_refresh_tokens`/
-- `oidc_user_consents` (migrations 080/082/088) already establish, and for
-- an even more direct reason here: a `client_deleted` (9c) audit row is
-- written for a `client_id` that, by the time anyone reads this table back,
-- no longer has a corresponding `oidc_clients` row at all. An FK would make
-- recording that exact event impossible.
--
-- `actor_id` IS a nullable FK into `users(id) ON DELETE SET NULL` — unlike
-- `client_id` above, the acting admin is a real, present `users` row at
-- write time (every route this table's writer serves is `requireDev`-gated,
-- `req.user` always set) and audit rows should survive that admin account
-- later being deleted, the same "keep the history, drop the dangling
-- reference" posture `ON DELETE SET NULL` already expresses for this exact
-- situation elsewhere in this codebase's admin-action tables.
--
-- `before`/`after` are both NULLABLE JSONB, independently — a `client_created`
-- (9c) row has no meaningful `before` (nothing existed yet), a
-- `client_deleted` (9c) row has no meaningful `after` (nothing exists
-- anymore). Both being present only for `client_updated` (9b) and
-- `client_status_changed` (9d) is expected, not a bug.
CREATE TABLE IF NOT EXISTS oidc_client_admin_audit_log (
  id SERIAL PRIMARY KEY,

  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- the requireDev-authenticated admin who performed the action; NULL only if that user is later deleted
  client_id TEXT NOT NULL,                                    -- oidc_clients.client_id this action targeted — see header for why this is NOT an FK

  action TEXT NOT NULL,                                       -- 'client_created' | 'client_updated' | 'client_deleted' | 'client_status_changed' — see lib/oidc-client-admin-audit.ts's own OidcClientAdminAuditAction union, the single source of truth for this vocabulary (no CHECK constraint here — same "the TS union, not a DB constraint, is authoritative" choice this roadmap's admin-status column takes the opposite side of on purpose, see migration 091's own CHECK for the contrasting case where a DB-level guarantee mattered more)

  before JSONB,                                                -- sanitized (never client_secret_hash / registration_access_token_hash) snapshot of the row BEFORE this action, or NULL — see header
  after JSONB,                                                 -- same, AFTER this action, or NULL — see header

  at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- The one read path this table serves, `GET /admin/oidc-clients/:clientId/audit-log`
-- (9e), is always scoped to one client_id, newest-first — this composite
-- index is what makes that read cheap without a full table scan, same
-- "index the exact WHERE + ORDER BY shape the one real caller uses"
-- precedent `oidc_user_consents_user_id_active_idx` (migration 088)
-- already sets for this roadmap's other audit-adjacent reads.
CREATE INDEX IF NOT EXISTS oidc_client_admin_audit_log_client_id_at_idx
  ON oidc_client_admin_audit_log(client_id, at DESC);
